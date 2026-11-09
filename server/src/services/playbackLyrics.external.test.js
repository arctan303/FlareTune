import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocalMetadataReadRoute } from '../routes/localMetadataRead.js';
import { handleLyricsWorkbenchRoute as rawRoute } from '../plugins/lyrics-workbench/workspace.js';
import { testLyricsContext, testLyricsAiDeps } from '../plugins/lyrics-workbench/test-support.js';
const handleLocalLyricsManageRoute = (req, url, db, headers, session, env, deps = {}) => rawRoute(req, url, db, headers, session, env,
  { context: testLyricsContext, aiAvailable: async () => true, ...deps, aiDeps: testLyricsAiDeps(deps.aiDeps) });
import { beginLyricAssetAiCompletion as beginRaw } from './lyricAssetTranslation.js';
import { buildEditedLyricArtifact } from './lyricAssetWorkflow.js';
import { createLyricDraftReceipt } from './lyricDraftReceipt.js';
import { guardExternalLyricStore, resolveLyricSong } from './playbackLyrics.js';
import { createMemoryLyricStore, createMemoryR2Bucket, makeLyricDocument, makeReadyArtifact, makeSong } from '../test/lyricAssetFixtures.js';

const beginLyricAssetAiCompletion = args => beginRaw({ ...args, deps: testLyricsAiDeps(args.deps) });
const ytSong = makeSong({ id: 'yt:QBtVFL0Qefs', title: 'Original Title', artist: 'Original Artist', language: null, source: 'youtube' });
const admin = { mode: 'normal', account: { accountId: 'admin', role: 'admin' } };
const member = { mode: 'normal', account: { accountId: 'member', role: 'member' } };
const workspacePath = `/api/lyrics/workspace/${encodeURIComponent(ytSong.id)}`;
const request = (path, method = 'GET', body) => new Request(`https://tune.test${path}`, {
  method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
function withoutCatalog() {
  const calls = [];
  return { calls, prepare(sql) {
    calls.push(sql);
    if (/\bSongs\b/u.test(sql)) throw new Error('Virtual songs must not read or write the local catalog');
    return { bind() { return this; }, first: async () => null, all: async () => ({ results: [] }) };
  } };
}
const meta = (db, deps, env = {}, path = `/api/lyrics?songId=${encodeURIComponent(ytSong.id)}`) => {
  const req = request(path);
  return handleLocalMetadataReadRoute(req, new URL(req.url), db, {}, 'member', env, deps);
};
const workspace = (db, deps, { path = workspacePath, method = 'GET', body, session = admin } = {}) => {
  const req = request(path, method, body);
  return handleLocalLyricsManageRoute(req, new URL(req.url), db, {}, session, {}, deps);
};

test('virtual YT playback retrieves lyrics by trusted metadata without any Songs row or interface-language inference', async () => {
  const db = withoutCatalog(); const store = createMemoryLyricStore(); const metadata = [];
  const response = await meta(db, { resolveSong: async id => id === ytSong.id ? ytSong : null,
    songStillExists: async () => true, store,
    fetchDocument: async (source, song) => {
      metadata.push(song);
      return source === 'lrclib' ? makeLyricDocument({ source: 'lrclib' }) : null;
    }, beginCompletion: async ({ store: saved }) => saved.get(ytSong.id),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.lines[0].text, 'Hello');
  assert.equal(store.current().songId, ytSong.id);
  assert.ok(metadata.length);
  assert.equal(metadata[0].title, 'Original Title');
  assert.equal(metadata[0].artist, 'Original Artist');
  assert.equal(metadata[0].duration, ytSong.duration);
  assert.equal(metadata[0].language, null);
  assert.equal(db.calls.some(sql => /\bSongs\b/u.test(sql)), false);
});

test('YT and local IDs keep separate lyric asset keys', async () => {
  const bucket = createMemoryR2Bucket(); const db = withoutCatalog();
  const localId = ytSong.id.slice(3);
  const localSong = makeSong({ id: localId });
  const { buildReadyLyricArtifact } = await import('./lyricAssetWorkflow.js');
  const { createLyricArtifactStore } = await import('./lyricArtifactStore.js');
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  await store.createIfAbsent(localId, (await buildReadyLyricArtifact(localSong,
    makeLyricDocument({ lines: [{ time: 1, text: 'Local lyric' }] }))).artifact);
  await store.createIfAbsent(ytSong.id, (await buildReadyLyricArtifact(ytSong,
    makeLyricDocument({ lines: [{ time: 1, text: 'YouTube lyric' }] }))).artifact);
  const response = await meta(db, { resolveSong: async () => ytSong, songStillExists: async () => true, store,
    beginCompletion: async () => ({ artifact: (await store.get(ytSong.id)).artifact }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.lines[0].text, 'YouTube lyric');
  assert.equal((await store.get(localId)).artifact.original.lines[0].text, 'Local lyric');
  assert.notEqual(store.key(localId), store.key(ytSong.id));
  assert.equal(bucket.calls.put.length, 2);
});

test('virtual source must be resolved by its exact ID; missing resolver, disabled source and malformed IDs stay closed', async () => {
  const db = withoutCatalog(); const store = createMemoryLyricStore(); let lookups = 0;
  for (const deps of [{}, { resolveSong: async () => null }, { resolveSong: async () => ({ ...ytSong, id: 'another' }) }]) {
    assert.equal((await meta(db, { ...deps, store })).status, 404);
  }
  const resolver = async () => { lookups++; return ytSong; };
  assert.equal(await resolveLyricSong(db, 'yt:invalid', { resolveSong: resolver }), null);
  assert.equal(lookups, 0);
  assert.equal(store.calls.get, 0);
});

test('disconnect during an automatic lyric fetch prevents creating an external asset', async () => {
  const db = withoutCatalog(); const store = createMemoryLyricStore(); let connected = true;
  const response = await meta(db, { resolveSong: async () => connected ? ytSong : null,
    songStillExists: async () => connected, store,
    fetchDocument: async () => { connected = false; return makeLyricDocument(); },
  });
  assert.equal(response.status, 404);
  assert.equal(store.calls.create, 0);
  assert.equal(store.calls.put, 0);
});

test('external lyric workspace supports candidate retrieval and explicit source save without catalog insertion', async () => {
  const db = withoutCatalog(); const store = createMemoryLyricStore(); const deps = {
    store, resolveSong: async () => ytSong, songStillExists: async () => true,
    listSourceCandidates: async (source, song) => {
      assert.equal(song.id, ytSong.id);
      return [{ source, providerLyricId: 'one', matchedTitle: song.title, matchedArtist: song.artist }];
    },
    fetchDocument: async (_source, song) => {
      assert.equal(song.title, ytSong.title);
      return makeLyricDocument({ source: 'custom_lrc', format: 'lrc' });
    },
  };
  const candidates = await workspace(db, deps, { path: `${workspacePath}/candidates?source=custom_lrc` });
  assert.equal(candidates.status, 200);
  assert.equal((await candidates.json()).data.candidates[0].matchedTitle, ytSong.title);
  const saved = await workspace(db, deps, { method: 'PUT', body: { source: 'custom_lrc', providerLyricId: 'one', etag: null } });
  assert.equal(saved.status, 200);
  assert.equal(store.current().songId, ytSong.id);
  assert.equal(store.current().original.lines[0].text, 'Hello');
  const read = await workspace(db, deps);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).data.song.source, 'youtube');
  assert.equal(db.calls.some(sql => /\bSongs\b/u.test(sql)), false);
});

test('a member cannot edit YT shared lyrics and disconnect during an explicit fetch prevents a write', async () => {
  const db = withoutCatalog(); const store = createMemoryLyricStore(); let connected = true;
  const deps = { store, resolveSong: async () => connected ? ytSong : null, songStillExists: async () => connected,
    fetchDocument: async () => { connected = false; return makeLyricDocument({ source: 'custom_lrc', format: 'lrc' }); } };
  const body = { source: 'custom_lrc', etag: null };
  assert.equal((await workspace(db, deps, { method: 'PUT', body, session: member })).status, 403);
  assert.equal(store.calls.get, 0);
  assert.equal((await workspace(db, deps, { method: 'PUT', body })).status, 404);
  assert.equal(store.calls.create, 0);
});

test('AI completion on a YT song never writes inferred language to Songs', async () => {
  const artifact = makeReadyArtifact({ songId: ytSong.id });
  const store = createMemoryLyricStore(artifact); const db = withoutCatalog();
  const started = await beginLyricAssetAiCompletion({ env: {}, db, song: ytSong, store, force: true, targetLanguage: 'zh', deps: {
    resolveAiFeature: async () => null, reserveDailyQuota: async () => true,
    loadLyricAiConfig: async () => ({ provider: 'deepseek', model: 'test', targetLanguage: 'zh', translateLyrics: true, detectLanguage: true }),
    getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test', systemPrompt: '' }),
    askAI: async () => ({ songLanguage: 'en', translations: [{ unitId: 0, text: '你好' }] }),
    updateSongLanguage: async () => { throw new Error('YT language must not write local Songs'); },
  } });
  await started.task;
  assert.equal(store.current().translation.lines[0], '你好');
  assert.equal(store.current().aiCompletion?.errorCode ?? null, null);
  assert.equal(db.calls.some(sql => /\bSongs\b/u.test(sql)), false);
});

test('saving a signed AI draft for YT stores its lyric document without attempting local language persistence', async () => {
  const db = withoutCatalog(); const store = createMemoryLyricStore();
  const env = { SETUP_SECRET: 'test-external-lyric-receipt-key'.repeat(2) };
  const lines = [{ time: 1, text: 'Hello', tlyric: '你好' }];
  const artifact = await buildEditedLyricArtifact(ytSong, lines);
  const aiReceipt = await createLyricDraftReceipt(env, { songId: ytSong.id,
    accountId: admin.account.accountId, etag: null, language: 'en', textHash: artifact.textHash });
  const req = request(`${workspacePath}/document`, 'PUT', { etag: null, lines, aiReceipt });
  const response = await handleLocalLyricsManageRoute(req, new URL(req.url), db, {}, admin, env,
    { store, resolveSong: async () => ytSong, songStillExists: async () => true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.languageUpdateFailed, false);
  assert.equal(store.current().songId, ytSong.id);
  assert.equal(store.current().translation.lines[0], '你好');
  assert.equal(db.calls.some(sql => /\bSongs\b/u.test(sql)), false);
});

test('disconnect while an AI task is in flight prevents its late lyric write', async () => {
  const artifact = makeReadyArtifact({ songId: ytSong.id }); const rawStore = createMemoryLyricStore(artifact);
  let connected = true;
  const store = guardExternalLyricStore(rawStore, ytSong.id, async () => connected);
  const started = await beginLyricAssetAiCompletion({ env: {}, db: withoutCatalog(), song: ytSong, store, force: true, targetLanguage: 'zh', deps: {
    resolveAiFeature: async () => null, reserveDailyQuota: async () => true,
    getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test', systemPrompt: '' }),
    askAI: async () => { connected = false; return { translations: [{ unitId: 0, text: 'Late' }] }; },
  } });
  await assert.rejects(started.task, /Song source is no longer available/u);
  assert.equal(rawStore.calls.put, 1); // only the pending marker, before disconnect
  assert.equal(rawStore.current().translation, null);
});
