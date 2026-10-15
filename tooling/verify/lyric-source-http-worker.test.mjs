import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('real workerd lyric HTTP accepts JSON and refuses redirects without a second destination', { timeout: 30000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import {fetchLimitedJson} from './server/src/services/lyricSourceHttp.js';
    export default {async fetch(request) {
      const path = new URL(request.url).pathname;
      try { return Response.json({value:await fetchLimitedJson(fetch,'https://lyrics.example.com'+path,
        {provider:'custom_krc',stage:'search'})}); }
      catch(error) { return Response.json({error:error.kind},{status:502}); }
    }};` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'lyrics-http', modules: true,
    compatibilityDate: '2026-09-23', script: bundle.outputFiles[0].text,
    outboundService: async request => {
      calls.push(request.url);
      if (request.url.endsWith('/ok')) return Response.json({ candidates: [] });
      return new Response(null, { status: 302, headers: { Location: 'https://unconfigured.example.com/private' } });
    },
  }] }));
  try {
    const ok = await mf.dispatchFetch('https://app.example.com/ok');
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { value: { candidates: [] } });
    const redirect = await mf.dispatchFetch('https://app.example.com/redirect');
    assert.equal(redirect.status, 502); assert.deepEqual(await redirect.json(), { error: 'invalid' });
    assert.deepEqual(calls, ['https://lyrics.example.com/ok', 'https://lyrics.example.com/redirect']);
  } finally { await mf.dispose(); }
});
