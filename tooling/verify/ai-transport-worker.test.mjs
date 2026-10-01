import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('actual workerd AI transport accepts manual redirects and never follows a credential-bearing redirect', { timeout: 45000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import { fetchAi } from './server/src/services/aiTransport.js';
    import { chatAI } from './server/src/services/ai.js';
    export default { async fetch(request) {
      if (new URL(request.url).pathname.startsWith('/gemini')) {
        try { return Response.json(await chatAI([{ role: 'user', content: 'fixture' }], [],
          { provider: 'gemini', source: 'custom', protocol: 'gemini_native', model: new URL(request.url).pathname.endsWith('redirect') ? 'redirect' : 'fixture' },
          { AI_PROFILE_API_KEY: 'test-only-key', AI_PROFILE_BASE_URL: 'https://provider.example' }));
        } catch (error) { return Response.json({ error: error.message }); }
      }
      try { const response = await fetchAi('https://provider.example/' + new URL(request.url).pathname.slice(1),
        { headers: { Authorization: 'Bearer test-only-key' } });
        return Response.json({ status: response.status, payload: await response.json() });
      } catch (error) { return Response.json({ error: error.message }); }
    } };` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const requests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'ai-transport-test',
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-23',
    outboundService: request => {
      requests.push({ url: request.url, authorization: request.headers.get('Authorization') });
      if (request.url.includes('redirect')) return new Response('private upstream content',
        { status: 302, headers: { Location: 'https://attacker.example/collect' } });
      if (request.url.includes('streamGenerateContent')) return new Response('data: {"candidates":[{"content":{"parts":[{"text":"fixture reply"}]},"finishReason":"STOP"}]}\n\n');
      return Response.json({ data: [{ id: 'fixture-model' }] });
    },
  }] }));
  try {
    const success = await (await mf.dispatchFetch('http://local.test/models')).json();
    assert.equal(success.status, 200);
    assert.equal(success.payload.data[0].id, 'fixture-model');
    const redirected = await (await mf.dispatchFetch('http://local.test/redirect')).json();
    assert.deepEqual(redirected, { error: 'AI_UPSTREAM_302' });
    assert.equal((await (await mf.dispatchFetch('http://local.test/gemini')).json()).content, 'fixture reply');
    const geminiRedirect = await (await mf.dispatchFetch('http://local.test/gemini-redirect')).json();
    assert.ok(geminiRedirect.error);
    assert.doesNotMatch(JSON.stringify(geminiRedirect), /test-only-key|private upstream|attacker/);
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.url.startsWith('https://provider.example/')));
    assert.ok(requests.slice(0, 2).every(request => request.authorization === 'Bearer test-only-key'));
  } finally { await mf.dispose(); }
});
