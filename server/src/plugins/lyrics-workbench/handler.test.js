import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../subsonic/test-support.js';
import { createPluginRegistry } from '../registry.js';
import { compiledPluginManifests } from '../../../../shared/plugins/catalog.js';
import { handlePluginApi } from '../../routes/plugins.js';
import { createLyricsWorkbenchHandler } from './handler.js';
import { createPluginServiceLease } from '../services.js';
import { createMemoryLyricStore, makeReadyArtifact, makeLyricDocument } from '../../test/lyricAssetFixtures.js';
import { readPlaybackLyrics } from '../../services/playbackLyrics.js';
import { DEFAULT_LYRIC_AI_CONFIG } from '../../utils/lyricAiConfig.js';

const BUILD = 'd'.repeat(64);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function app(t, dependencies = {}) {
  const f = await fixture(); t.after(() => f.close());
  const manifests = compiledPluginManifests.filter(item => ['ai-gateway', 'lyrics-workbench'].includes(item.id));
  const registry = createPluginRegistry({ manifests, builds: manifests.map(item => ({ id: item.id, sourceDigest: BUILD })), deployment: null });
  const install = async (id = 'lyrics-workbench', installed = true) => registry.setInstalled(f.env, f.signed.session, id,
    { installed, revision: (await registry.readInstallation(f.env, id)).revision });
  const store = dependencies.store || createMemoryLyricStore(makeReadyArtifact({ songId: 's1' }));
  const tasks = [];
  const call = async (path = '/workspace/s1', method = 'GET', body, auth = f.signed, build = BUILD) => {
    const url = `https://test.example/api/account/plugins/lyrics-workbench${path}`;
    const req = new Request(url, { method, headers: { 'Content-Type': 'application/json', ...(build ? { 'X-FlareTune-Plugin-Build': build } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const handler = createLyricsWorkbenchHandler(f.env, auth.session, { registry,
      executionContext: { waitUntil: task => tasks.push(task) }, dependencies: { store, ...dependencies } });
    return handlePluginApi(req, new URL(url).pathname, f.env, auth.session, json,
      { registry, handlers: { 'lyrics-workbench': handler } });
  };
  const admin = async (path, method = 'GET', body, auth = f.signed) => {
    const req = new Request(`https://test.example/api/admin/plugins/lyrics-workbench${path}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-FlareTune-Plugin-Build': BUILD }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return handlePluginApi(req, new URL(req.url).pathname, f.env, auth.session, json, { registry,
      handlers: { 'lyrics-workbench': createLyricsWorkbenchHandler(f.env, auth.session, { registry, dependencies }) } });
  };
  return { ...f, registry, install, store, tasks, call, admin };
}

test('workbench is absent by default; installed plain editing does not require Gateway and member writes remain forbidden', async t => {
  const f = await app(t);
  assert.equal((await f.call()).status, 409);
  await f.install();
  const member = await f.signIn('member');
  const read = await f.call('/workspace/s1', 'GET', undefined, member);
  assert.equal(read.status, 200); assert.equal((await read.json()).data.aiCompletionEnabled, false);
  const body = { lines: [{ time: 1, text: 'Saved plain lyric' }], etag: (await f.store.get('s1')).etag };
  assert.equal((await f.call('/workspace/s1/document', 'PUT', body, member)).status, 403);
  assert.equal((await f.call('/workspace/s1/document', 'PUT', body)).status, 200);
  assert.equal(f.store.current().original.lines[0].text, 'Saved plain lyric');
  assert.equal((await f.call('/workspace/s1/ai-completion', 'POST', {}, member)).status, 409);
  assert.equal((await f.call('/workspace/s1/draft-ai', 'POST', body)).status, 409);
  for (const build of [null, '0'.repeat(64)]) assert.equal((await f.call('/workspace/s1', 'GET', undefined, f.signed, build)).status, 409);
});

test('uninstall during a candidate fetch discards the delayed shared lyric save', async t => {
  const fetch = deferred(); const entered = deferred();
  const f = await app(t, { fetchDocument: async () => { entered.resolve(); return fetch.promise; } }); await f.install();
  const before = JSON.stringify(f.store.current());
  const result = f.call('/workspace/s1', 'PUT', { source: 'lrclib', etag: (await f.store.get('s1')).etag });
  await entered.promise; await f.install('lyrics-workbench', false);
  fetch.resolve(makeLyricDocument({ source: 'lrclib', lines: [{ time: 1, text: 'Late overwrite' }] }));
  assert.equal((await result).status, 409); assert.equal(JSON.stringify(f.store.current()), before);
});

test('workbench uninstall during the final external source check prevents the raw shared write', async t => {
  const songId = 'yt:abcdefghijk', entered = deferred(), released = deferred(); let checks = 0, putCalls = 0;
  const raw = createMemoryLyricStore(makeReadyArtifact({ songId }));
  const store = { ...raw, putIfMatch: (...args) => { putCalls++; return raw.putIfMatch(...args); } };
  const f = await app(t, { store, resolveSong: async id => ({ id, title: 'External song', artist: 'Artist', language: 'en' }),
    songStillExists: async () => { if (++checks === 2) { entered.resolve(); await released.promise; } return true; } });
  await f.install(); const before = JSON.stringify(raw.current());
  const pending = f.call(`/workspace/${encodeURIComponent(songId)}/document`, 'PUT',
    { lines: [{ time: 1, text: 'Late shared write' }], etag: (await raw.get(songId)).etag });
  await entered.promise; await f.install('lyrics-workbench', false); released.resolve();
  assert.equal((await pending).status, 409); assert.equal(putCalls, 0);
  assert.equal(JSON.stringify(raw.current()), before);
});

test('Gateway uninstall during an external AI save source check prevents the raw translation write', async t => {
  const songId = 'yt:abcdefghijk', asked = deferred(), reply = deferred(), entered = deferred(), released = deferred();
  let f, afterReply = false, checks = 0, putCalls = 0;
  const raw = createMemoryLyricStore(makeReadyArtifact({ songId }));
  const store = { ...raw, putIfMatch: (...args) => { putCalls++; return raw.putIfMatch(...args); } };
  f = await app(t, { store, resolveSong: async id => ({ id, title: 'External song', artist: 'Artist', language: 'en' }),
    songStillExists: async () => { if (afterReply && ++checks === 2) { entered.resolve(); await released.promise; } return true; },
    aiDeps: { reserveDailyQuota: async () => true, createGatewayClient: async params => {
      const lease = await createPluginServiceLease({ ...params, providerId: 'ai-gateway', registry: f.registry });
      assert.deepEqual(params.configuration, { slot: 'ai-model' });
      return { config: { provider: 'deepseek', model: 'fixture-model', generationOptions: { temperature: 0.2 } }, assertCurrent: lease.assertCurrent, guardedDb: lease.guardedDb,
        ask: async () => { asked.resolve(); await reply.promise; return { translations: [{ unitId: 0, text: 'Late translation' }] }; } };
    } } });
  await f.install(); await f.install('ai-gateway');
  assert.equal((await f.call(`/workspace/${encodeURIComponent(songId)}/ai-completion`, 'POST', {})).status, 202);
  await asked.promise; const before = JSON.stringify(raw.current()), priorPuts = putCalls;
  afterReply = true; reply.resolve(); await entered.promise;
  await f.install('ai-gateway', false); released.resolve(); await Promise.allSettled(f.tasks);
  assert.equal(putCalls, priorPuts); assert.equal(JSON.stringify(raw.current()), before);
});

test('Gateway retirement during manual AI cannot commit a translation or inferred song language', async t => {
  const reply = deferred(); const entered = deferred(); let f;
  f = await app(t, { aiDeps: { reserveDailyQuota: async () => true,
    createGatewayClient: async params => {
      const lease = await createPluginServiceLease({ ...params, providerId: 'ai-gateway', registry: f.registry });
      assert.deepEqual(params.configuration, { slot: 'ai-model' });
      return { config: { provider: 'deepseek', model: 'fixture-model', generationOptions: { temperature: 0.2 } }, assertCurrent: lease.assertCurrent, guardedDb: lease.guardedDb,
        ask: async () => { entered.resolve(); return reply.promise; } };
    } } });
  await f.install(); await f.install('ai-gateway');
  const result = await f.call('/workspace/s1/ai-completion', 'POST', {}, await f.signIn('member'));
  assert.equal(result.status, 202); await entered.promise;
  const pending = JSON.stringify(f.store.current());
  await f.install('ai-gateway', false);
  reply.resolve({ songLanguage: 'ja', translations: [{ unitId: 0, text: '遅い翻訳' }] });
  await Promise.allSettled(f.tasks);
  assert.equal(JSON.stringify(f.store.current()), pending);
  assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
});

test('workbench settings and source settings retain CAS and administrator-only access', async t => {
  const f = await app(t); await f.install(); const member = await f.signIn('member');
  assert.equal((await f.admin('/settings', 'GET', undefined, member)).status, 403);
  const read = await f.admin('/settings'); assert.equal(read.status, 200);
  const data = await read.json(); const value = { ...data.setting.value, automaticCompletionEnabled: false };
  const saved = await f.admin('/settings', 'PUT', { value, expectedRevision: data.setting.revision });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).setting.value.automaticCompletionEnabled, false);
  assert.equal((await f.admin('/settings', 'PUT', { value, expectedRevision: data.setting.revision })).status, 409);
  const sources = await f.admin('/sources-settings'); assert.equal(sources.status, 200);
  const sourceData = await sources.json();
  assert.equal((await f.admin('/sources-settings', 'PUT', { value: sourceData.setting.value, expectedRevision: sourceData.setting.revision })).status, 200);
  await f.install('lyrics-workbench', false);
  assert.equal((await f.admin('/settings')).status, 409);
  assert.equal((await f.admin('/sources-settings')).status, 409);
});

test('ordinary playback without the optional plugins preserves saved assets and never starts AI; installed plugins enable member automatic AI', async t => {
  const f = await app(t); const member = await f.signIn('member'); let calls = 0;
  const tasks = [];
  const lyricConfig = { ...DEFAULT_LYRIC_AI_CONFIG, completionEnabled: true,
    automaticCompletionEnabled: true, targetLanguage: 'zh' };
  const deps = { session: member.session, registry: f.registry, store: f.store,
    loadLyricAiConfig: async () => lyricConfig,
    readOrCreateLyricArtifact: async () => f.store.get('s1'),
    aiDeps: { registry: f.registry, reserveDailyQuota: async () => true,
      getAIAssistantConfig: async () => lyricConfig,
      createGatewayClient: async params => {
        const lease = await createPluginServiceLease({ ...params, providerId: 'ai-gateway', registry: f.registry });
        assert.deepEqual(params.configuration, { slot: 'ai-model' });
        return { config: { provider: 'deepseek', model: 'fixture-model', generationOptions: { temperature: 0.2 } }, assertCurrent: lease.assertCurrent, guardedDb: lease.guardedDb,
          ask: async () => { calls++; return { translations: [{ unitId: 0, text: '你好' }] }; } };
      } } };
  const read = () => readPlaybackLyrics({ env: f.env, db: f.db, song: { id: 's1', language: 'en' },
    accountId: 'member', executionContext: { waitUntil: value => tasks.push(value) }, deps });
  const original = JSON.stringify(f.store.current());
  assert.ok((await read()).lyrics.lines.length); assert.equal(calls, 0); assert.equal(tasks.length, 0);
  assert.equal(JSON.stringify(f.store.current()), original);
  await f.install(); await read(); assert.equal(calls, 0); assert.equal(tasks.length, 0);
  await f.install('ai-gateway');
  const pending = await read(); assert.equal(pending.lyrics.translationState, 'pending');
  await Promise.all(tasks); assert.equal(calls, 1);
  assert.equal(f.store.current().translation.lines[0], '你好');
});

test('source probes use the installed administrator capability and discard a delayed result after uninstall', async t => {
  const entered = deferred(), response = deferred();
  const f = await app(t, { testSource: async () => { entered.resolve(); return response.promise; } });
  await f.install();
  const member = await f.signIn('member');
  assert.equal((await f.admin('/source-test', 'POST', {}, member)).status, 403);
  const pending = f.admin('/source-test', 'POST', {}); await entered.promise;
  await f.install('lyrics-workbench', false);
  response.resolve({ status: 'ready', lineCount: 1 });
  assert.equal((await pending).status, 409);
});

test('an optional AI lease retiring during playback falls back to the saved original lyrics', async t => {
  const store = createMemoryLyricStore(makeReadyArtifact({ songId: 's1',
    aiCompletion: { status: 'review', candidateIndices: [0], reviewAccountId: 'old-owner', updatedAt: new Date().toISOString() } }));
  const f = await app(t, { store }); let checks = 0;
  const read = await readPlaybackLyrics({ env: f.env, db: f.db, song: { id: 's1', language: 'en' }, accountId: f.owner,
    deps: { session: f.signed.session, store: f.store, readOrCreateLyricArtifact: () => f.store.get('s1'),
      createAiLease: async () => ({ guardedDb: db => db, assertCurrent: async () => { checks++; throw new Error('retired'); } }) } });
  assert.ok(read.lyrics.lines.length); assert.equal(read.lyrics.translationState, 'unavailable'); assert.ok(checks);
});
