import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const latestUrl = 'https://api.github.com/repos/arctan303/FlareTune/releases/latest';
const manifestUrl = 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-update.json';
const sourceUrl = 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-source.tar.gz';
const hookUrl = 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-edge-hook-12345';
const redirectUrl = 'https://forbidden-second-destination.test/never-reached';
const manifest = { schemaVersion: 1, id: `1.3.0:${'b'.repeat(40)}`, version: '1.3.0', commit: 'b'.repeat(40),
  host: { version: '1.3.0', sourceDigest: 'c'.repeat(64) }, hostApiVersion: 5, minVersion: '1.2.1',
  notes: { zh: '边缘运行时回归', en: 'Edge runtime regression' }, source: { url: sourceUrl, sha256: 'd'.repeat(64) },
  migration: { compatible: true }, channel: 'stable' };
const release = { tag_name: '1.3.0', draft: false, prerelease: false, assets: [
  { name: 'flaretune-update.json', browser_download_url: manifestUrl },
  { name: 'flaretune-source.tar.gz', browser_download_url: sourceUrl },
] };

// Bundle the actual discovery and configure/check/start/trigger implementation.
// Authentication and DB readiness are isolated fixture concerns; fetch remains
// workerd's real native fetch, including its RequestInit validation/redirects.
let bundle;
function workerScript() {
  bundle ||= build({ stdin: { resolveDir: root, contents: `
    import { createSystemUpdate } from './server/src/systemUpdate/service.js';
    import { discoverRelease } from './server/src/systemUpdate/releases.js';
    const nativeFetch = globalThis.fetch;
    const redirectModes = [];
    globalThis.fetch = (input, init) => { redirectModes.push(init?.redirect); return nativeFetch(input, init); };
    export default { async fetch(request, env) {
      redirectModes.length = 0;
      try {
        const path = new URL(request.url).pathname;
        if (path === '/legacy-error') {
          try { await nativeFetch(${JSON.stringify(hookUrl)}, { method: 'POST', redirect: 'error' });
            return Response.json({ accepted: true }); }
          catch (error) { return Response.json({ accepted: false, name: error.name, message: error.message }); }
        }
        if (path === '/discover') return Response.json({ release: await discoverRelease(env), redirectModes });
        if (path !== '/start') return new Response(null, { status: 404 });
        const update = createSystemUpdate({
          runtime: { version: '1.2.1', sourceDigest: 'a'.repeat(64), hostApiVersion: 5, plugins: [] },
          requireAdminImpl: async () => {}, state: async () => ({ state: 'ready' }),
          supplemental: async () => ({ supplementalPending: false }),
        });
        const configured = await update.configure(env, null, { revision: 0,
          deployHookUrl: ${JSON.stringify(hookUrl)}, buildToken: 'synthetic_edge_update_token_12345678901234567890' });
        const checked = await update.check(env, null, { revision: configured.revision });
        const started = await update.start(env, null, { revision: checked.revision, releaseId: checked.latest.id });
        return Response.json({ job: started.job, redirectModes });
      } catch (error) { return Response.json({ error: error.code || error.name, redirectModes }, { status: error.status || 503 }); }
    } };` }, bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' })
    .then(result => result.outputFiles[0].text);
  return bundle;
}

async function fixture(run, { redirectAt } = {}) {
  const requests = [];
  let secondDestinationRequests = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'system-update-edge-fetch',
    modules: true, script: await workerScript(), compatibilityDate: '2026-09-23', d1Databases: ['DB'],
    bindings: { SETUP_SECRET: 'synthetic_setup_secret_for_real_workerd_1234567890' },
    async outboundService(request) {
      if (new URL(request.url).hostname === 'forbidden-second-destination.test') {
        secondDestinationRequests++;
        return Response.json({ error: 'SECOND_DESTINATION_MUST_NOT_BE_REACHED' }, { status: 500 });
      }
      requests.push({ url: request.url, method: request.method });
      assert.equal(request.headers.has('Authorization'), false);
      assert.equal(request.headers.has('Cookie'), false);
      if (request.url === redirectAt) return new Response('synthetic redirect', { status: 302, headers: { Location: redirectUrl } });
      if (request.url === latestUrl) return Response.json(release);
      if (request.url === manifestUrl) return Response.json(manifest);
      if (request.url === hookUrl) {
        assert.equal(request.method, 'POST');
        return Response.json({ success: true, result: { build_uuid: 'synthetic-edge-provider-build-12345' } });
      }
      throw new Error('UNEXPECTED_TEST_OUTBOUND_DESTINATION');
    },
  }] }));
  try {
    const { DB: db } = await mf.getBindings('system-update-edge-fetch');
    await db.prepare('CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value_json TEXT,revision INTEGER NOT NULL,updated_at INTEGER,updated_by TEXT)').run();
    await run({ requests, secondDestinationRequests: () => secondDestinationRequests,
      call: async path => { const response = await mf.dispatchFetch(`https://system-update-edge.test${path}`);
        return { status: response.status, body: await response.json() }; } });
  } finally { await mf.dispose(); }
}

test('real workerd rejects legacy redirect:error before any outbound request', { timeout: 45_000 }, async () => {
  await fixture(async f => {
    const { status, body } = await f.call('/legacy-error');
    assert.equal(status, 200);
    assert.equal(body.accepted, false);
    assert.equal(body.name, 'TypeError');
    assert.match(body.message, /redirect|error/i);
    assert.deepEqual(f.requests, []);
    assert.equal(f.secondDestinationRequests(), 0);
  });
});

test('real workerd discovers actual GitHub latest and its validated manifest', { timeout: 45_000 }, async () => {
  await fixture(async f => {
    const { status, body } = await f.call('/discover');
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.release, manifest);
    assert.deepEqual(body.redirectModes, ['manual', 'follow']);
    assert.deepEqual(f.requests, [{ url: latestUrl, method: 'GET' }, { url: manifestUrl, method: 'GET' }]);
    assert.equal(f.secondDestinationRequests(), 0);
  });
});

test('real workerd actual system update start accepts a normal Hook response and records providerBuildId', { timeout: 45_000 }, async () => {
  await fixture(async f => {
    const { status, body } = await f.call('/start');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.job.status, 'queued');
    assert.equal(body.job.providerBuildId, 'synthetic-edge-provider-build-12345');
    assert.equal(body.job.error, null);
    assert.equal(body.job.target.id, manifest.id);
    assert.deepEqual(body.redirectModes, ['manual', 'follow', 'manual']);
    assert.deepEqual(f.requests, [{ url: latestUrl, method: 'GET' }, { url: manifestUrl, method: 'GET' }, { url: hookUrl, method: 'POST' }]);
    assert.equal(f.secondDestinationRequests(), 0);
  });
});

test('real workerd actual Hook path rejects 302 without following or recording a provider build', { timeout: 45_000 }, async () => {
  await fixture(async f => {
    const { status, body } = await f.call('/start');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.job.status, 'activation_pending');
    assert.equal(body.job.error, 'SYSTEM_UPDATE_TRIGGER_FAILED');
    assert.equal(body.job.providerBuildId, undefined);
    assert.deepEqual(body.redirectModes, ['manual', 'follow', 'manual']);
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests.at(-1).url, hookUrl);
    assert.equal(f.secondDestinationRequests(), 0);
  }, { redirectAt: hookUrl });
});

test('real workerd actual latest API rejects 302 without following or fetching a manifest', { timeout: 45_000 }, async () => {
  await fixture(async f => {
    const { status, body } = await f.call('/discover');
    assert.equal(status, 502);
    assert.equal(body.error, 'SYSTEM_UPDATE_RELEASE_UNAVAILABLE');
    assert.deepEqual(body.redirectModes, ['manual']);
    assert.deepEqual(f.requests, [{ url: latestUrl, method: 'GET' }]);
    assert.equal(f.secondDestinationRequests(), 0);
  }, { redirectAt: latestUrl });
});
