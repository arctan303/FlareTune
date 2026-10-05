import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleLocalLyricsManageRoute } from './localLyricsManage.js';
import { createLyricArtifactStore } from '../services/lyricArtifactStore.js';
import { runLyricAssetAiCompletion } from '../services/lyricAssetTranslation.js';
import { buildEditedLyricArtifact } from '../services/lyricAssetWorkflow.js';
import { createLyricDraftReceipt } from '../services/lyricDraftReceipt.js';
import { LyricSourceError } from '../services/lyricSourceLoader.js';
import {
  createMemoryLyricStore,
  createMemoryR2Bucket,
  makeLyricDocument,
  makeReadyArtifact,
  makeSong,
  makeSongDb,
} from '../test/lyricAssetFixtures.js';

const member = { mode: 'normal', account: { accountId: 'local_member', role: 'member' } };
const admin = { mode: 'normal', account: { accountId: 'local_admin', role: 'admin' } };
const path = (suffix = '') => `/api/lyrics/workspace/song-1${suffix}`;
const request = (urlPath, method = 'GET', body) => new Request(`https://tune.test${urlPath}`, {
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const route = (req, { session = admin, db = makeSongDb(), store = createMemoryLyricStore(makeReadyArtifact()),
  deps = {}, env = {} } = {}) => handleLocalLyricsManageRoute(
  req, new URL(req.url), db, {}, session, env, { store, ...deps },
);

test('manual search source filter limits provider calls and preserves match warnings', async () => {
  const calls = [];
  const deps = { listSourceCandidates: async source => {
    calls.push(source);
    return [{ source, providerLyricId: 'one', matchedTitle: 'Night Song (Live)',
      matchedArtist: 'Singer', versionMismatch: true, durationDelta: 20 }];
  } };
  const response = await route(request(path('/candidates?source=netease')), { deps });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['netease']);
  assert.equal(payload.data.candidates[0].versionMismatch, true);
  assert.equal(payload.data.candidates[0].durationDelta, 20);
  for (const source of ['auto', 'invalid']) {
    assert.equal((await route(request(path(`/candidates?source=${source}`)), { deps })).status, 400);
  }
  assert.deepEqual(calls, ['netease']);
});

test('only new workspace path is dispatched and a verified normal local account is mandatory', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  assert.equal(await route(request('/api/manage/lyrics/song-1'), { store }), null);
  for (const session of [null, {}, { mode: 'must_change_password', account: admin.account },
    { mode: 'normal', account: { accountId: 'x', role: 'viewer' } },
    { mode: 'normal', account: { role: 'admin', sub: 'old-oauth-sub' } }]) {
    const response = await route(request(path()), { session, store });
    assert.equal(response.status, 401);
  }
  assert.equal(store.calls.get, 0);
  assert.equal((await route(request(`${path()}?account_id=other`), { store })).status, 400);
  assert.equal((await route(request('/api/lyrics/workspace/song%2Fother'), { store })).status, 400);
  assert.equal(store.calls.get, 0);
});

test('member and administrator read the same existing lyric asset without provider calls or writes', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  let providerCalls = 0;
  for (const session of [member, admin]) {
    const response = await route(request(path()), { session, store,
      deps: { listCandidates: async () => { providerCalls += 1; } } });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.song.id, 'song-1');
    assert.equal(payload.data.status, 'ready');
    assert.equal(payload.data.etag, 'etag-1');
  }
  assert.equal(providerCalls, 0);
  assert.equal(store.calls.put, 0);
});

test('lyric AI master switch hides the workspace action and rejects manual requests', async () => {
  const songs = makeSongDb();
  const db = { prepare(sql) {
    if (sql.includes('instance_settings')) return { async first() { return { value_json: JSON.stringify({
      provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2, styleRules: '',
      targetLanguage: 'zh', cleanDirtyLyrics: true, translateLyrics: true,
      detectLanguage: true, referenceExistingTranslation: false,
      completionEnabled: false, automaticCompletionEnabled: false,
    }) }; } };
    return songs.prepare(sql);
  } };
  const store = createMemoryLyricStore(makeReadyArtifact());
  const read = await route(request(path()), { db, store, session: member });
  assert.equal((await read.json()).data.aiCompletionEnabled, false);
  for (const [suffix, body] of [
    ['/ai-completion', {}],
    ['/draft-ai', { etag: 'etag-1', lines: [{ time: 1, text: 'Hello' }] }],
  ]) {
    const denied = await route(request(path(suffix), 'POST', body), { db, store });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'LYRIC_AI_DISABLED');
  }
  assert.equal(store.calls.put, 0);
});

test('member cannot directly mutate the shared lyric artifact', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  const changes = [
    request(path(), 'PUT', { source: 'auto', etag: 'etag-1' }),
    request(path(), 'DELETE', { etag: 'etag-1' }),
    request(path('/offset'), 'PATCH', { offsetMs: 100, etag: 'etag-1' }),
    request(path('/timeline'), 'PATCH', { deltaMs: 100, etag: 'etag-1' }),
    request(path('/document'), 'PUT', { lines: [{ time: 1, text: 'Edited' }], etag: 'etag-1' }),
    request(path('/draft-ai'), 'POST', { lines: [{ time: 1, text: 'Edited' }], etag: 'etag-1' }),
    request(path('/import'), 'POST', { lrc: '[00:01.000]Edited', etag: 'etag-1' }),
    request(path('/restore'), 'POST', { asset: makeReadyArtifact(), etag: 'etag-1' }),
    request(path('/translation'), 'DELETE', { etag: 'etag-1' }),
  ];
  for (const change of changes) {
    const response = await route(change, { session: member, store });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'FORBIDDEN');
  }
  assert.equal(store.calls.get, 0);
  assert.equal(store.calls.put, 0);
});

test('current lyric draft creates the first shared asset only on explicit save', async () => {
  const store = createMemoryLyricStore();
  assert.equal(store.calls.create, 0);
  const saved = await route(request(path('/document'), 'PUT', {
    etag: null, lines: [{ time: 1, text: 'First line', tlyric: '第一句' }],
  }), { store });
  assert.equal(saved.status, 200);
  assert.equal(store.calls.create, 1);
  assert.equal(store.current().original.lines[0].text, 'First line');
  const stale = await route(request(path('/document'), 'PUT', {
    etag: null, lines: [{ time: 1, text: 'Overwrite' }],
  }), { store });
  assert.equal(stale.status, 409);
  assert.equal(store.current().original.lines[0].text, 'First line');
});

test('candidate draft can receive AI changes and save once without an intermediate write', async () => {
  const store = createMemoryLyricStore();
  const draft = [{ time: 1.0006, endTime: 2.0006, text: 'Hello',
    words: [{ text: 'Hello', startTime: 1.0006, endTime: 2.0006 }] }];
  const completed = await route(request(path('/draft-ai'), 'POST', {
    etag: null, lines: draft,
  }), { store, deps: { completeDraft: async ({ lines }) => ({ status: 'ready',
    lines: lines.map((line) => ({ ...line, tlyric: '你好' })) }) } });
  assert.equal(completed.status, 200);
  assert.equal(store.calls.create, 0);
  assert.equal(store.calls.put, 0);
  const rounded = await route(request(path('/document'), 'PUT', {
    etag: null, lines: [{ ...draft[0], time: 1.001 }],
  }), { store });
  assert.equal(rounded.status, 422);
  assert.equal(store.calls.create, 0);
  const edited = (await completed.json()).data.lines;
  edited[0].time += 0.05;
  edited[0].endTime += 0.05;
  edited[0].words[0].startTime += 0.05;
  edited[0].words[0].endTime += 0.05;
  const saved = await route(request(path('/document'), 'PUT', { etag: null, lines: edited }), { store });
  assert.equal(saved.status, 200);
  assert.equal(store.calls.create, 1);
  assert.equal(store.current().original.lines[0].time, 1.0506);
  assert.equal(store.current().translation.lines[0], '你好');
});

test('draft AI infrastructure errors are retryable and leave the shared asset unchanged', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  const response = await route(request(path('/draft-ai'), 'POST', {
    etag: 'etag-1', lines: [{ time: 1, text: 'Hello' }],
  }), { store, deps: { completeDraft: async () => { throw new Error('upstream unavailable'); } } });
  assert.equal(response.status, 503);
  assert.equal(store.calls.put, 0);
  assert.equal(store.current().original.lines[0].text, 'Hello');
});

test('final draft save alone applies a Worker-signed AI language inference', async () => {
  const env = { SETUP_SECRET: 's'.repeat(48) };
  const song = makeSong({ language: 'ja' });
  const lines = [{ time: 1, text: 'Hello', tlyric: '你好' }];
  const artifact = await buildEditedLyricArtifact(song, lines);
  const receipt = await createLyricDraftReceipt(env, {
    songId: song.id, accountId: admin.account.accountId, etag: null,
    language: 'en', textHash: artifact.textHash,
  });
  const baseDb = makeSongDb([song]);
  let languageWrites = 0;
  const db = { prepare(sql) {
    if (sql.startsWith('UPDATE Songs SET language')) return { bind(language, songId, oldLanguage) {
      assert.equal(language, 'en'); assert.equal(songId, song.id); assert.equal(oldLanguage, 'ja');
      return { run: async () => { languageWrites += 1; } };
    } };
    return baseDb.prepare(sql);
  } };
  const store = createMemoryLyricStore();
  const invalid = await route(request(path('/document'), 'PUT', {
    etag: null, lines: [{ time: 1, text: 'Different' }], aiReceipt: receipt,
  }), { env, db, store });
  assert.equal(invalid.status, 400);
  assert.equal(store.calls.create, 0);
  assert.equal(languageWrites, 0);
  const saved = await route(request(path('/document'), 'PUT', { etag: null, lines, aiReceipt: receipt }),
    { env, db, store });
  assert.equal(saved.status, 200);
  assert.equal(store.calls.create, 1);
  assert.equal(languageWrites, 1);
});

test('final draft save reports a concurrent song-language update without losing the lyric', async () => {
  const env = { SETUP_SECRET: 's'.repeat(48) };
  const song = makeSong({ language: 'ja' });
  const lines = [{ time: 1, text: 'Hello' }];
  const artifact = await buildEditedLyricArtifact(song, lines);
  const receipt = await createLyricDraftReceipt(env, {
    songId: song.id, accountId: admin.account.accountId, etag: null,
    language: 'en', textHash: artifact.textHash,
  });
  const baseDb = makeSongDb([song]);
  const db = { prepare(sql) {
    if (sql.startsWith('UPDATE Songs SET language')) return { bind() {
      return { run: async () => ({ meta: { changes: 0 } }) };
    } };
    return baseDb.prepare(sql);
  } };
  const store = createMemoryLyricStore();
  const response = await route(request(path('/document'), 'PUT', {
    etag: null, lines, aiReceipt: receipt,
  }), { env, db, store });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.languageUpdateFailed, true);
  assert.equal(store.current().original.lines[0].text, 'Hello');
});

test('member can trigger the Worker-owned AI completion without supplying a language', async () => {
  let called = 0;
  const response = await route(request(path('/ai-completion'), 'POST', {}), {
    session: member,
    deps: { beginCompletion: async ({ song, actorAccountId }) => {
      called += 1;
      assert.equal(song.language, 'en');
      assert.equal(actorAccountId, member.account.accountId);
      return { state: 'started', etag: 'etag-2', artifact: makeReadyArtifact({
        aiCompletion: { status: 'pending', updatedAt: '2026-09-10T00:00:00.000Z' },
      }), task: null };
    } },
  });
  assert.equal(response.status, 202);
  assert.equal(called, 1);
  const rejected = await route(request(path('/ai-completion'), 'POST', { language: 'ja' }), {
    session: member,
  });
  assert.equal(rejected.status, 400);
});

test('a legacy cleanup proposal is applied automatically when any member reads lyrics', async () => {
  const base = makeReadyArtifact();
  const store = createMemoryLyricStore(makeReadyArtifact({
    original: { ...base.original, lines: [
      { time: 0, text: 'Lyrics by: Someone' }, base.original.lines[0],
    ] },
    translation: { source: 'ai', originalTextHash: base.textHash,
      lines: ['', '你好'], updatedAt: base.updatedAt },
    aiCompletion: { status: 'review', candidateIndices: [0], reviewAccountId: member.account.accountId,
      updatedAt: base.updatedAt },
  }));
  const otherMember = { mode: 'normal', account: { accountId: 'another_member', role: 'member' } };
  const first = await route(request(path()), { session: otherMember, store });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).data.asset.aiCompletion, null);
  assert.deepEqual(store.current().original.lines.map((line) => line.text), ['Hello']);
  assert.deepEqual(store.current().translation.lines, ['你好']);
  assert.equal(store.current().translation.originalTextHash, store.current().textHash);
  assert.notEqual(store.current().textHash, base.textHash);
  assert.equal(store.calls.put, 1);
  const ownerView = await route(request(path()), { session: member, store });
  assert.equal((await ownerView.json()).data.asset.aiCompletion, null);
  assert.equal(store.calls.put, 1);
  assert.equal(await route(request(path('/ai-cleanup'), 'POST', {
    etag: 'etag-2', removeLineIndices: [0],
  }), { session: member, store }), null);
});

test('legacy cleanup keeps the original if deletion would leave only song title metadata', async () => {
  const base = makeReadyArtifact();
  const store = createMemoryLyricStore(makeReadyArtifact({
    original: { ...base.original, lines: [
      { time: 0, text: 'Night Song - Singer' }, base.original.lines[0],
    ] },
    aiCompletion: { status: 'review', candidateIndices: [1],
      reviewAccountId: member.account.accountId, updatedAt: base.updatedAt },
  }));
  const result = await route(request(path()), { session: member, store });
  assert.equal(result.status, 200);
  assert.deepEqual(store.current().original.lines.map((line) => line.text),
    ['Night Song - Singer', 'Hello']);
  assert.equal(store.current().aiCompletion, null);
  assert.equal(store.calls.put, 1);
});

test('timeline shift bakes legacy offset into shared word timing exactly once', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact({ offsetMs: 200 }));
  const response = await route(request(path('/timeline'), 'PATCH', { deltaMs: -100, etag: 'etag-1' }), { store });
  assert.equal(response.status, 200);
  assert.equal(store.current().offsetMs, 0);
  assert.equal(store.current().original.lines[0].time, 1.1);
  assert.equal(store.current().original.lines[0].words[0].startTime, 1.1);
  assert.equal((await response.json()).data.lyrics.lines[0].time, 1.1);
  assert.equal((await route(request(path('/timeline'), 'PATCH', { deltaMs: 50, etag: 'etag-1' }), { store })).status, 409);
});

test('timeline shift keeps an in-flight AI completion attached to unchanged lyric text', async () => {
  const pending = { status: 'pending', updatedAt: '2026-09-25T00:00:00.000Z' };
  const store = createMemoryLyricStore(makeReadyArtifact({ aiCompletion: pending }));
  const response = await route(request(path('/timeline'), 'PATCH', { deltaMs: 250, etag: 'etag-1' }), { store });
  assert.equal(response.status, 200);
  assert.deepEqual(store.current().aiCompletion, pending);
  assert.equal(store.current().textHash, 'a'.repeat(64));
  assert.equal(store.current().original.lines[0].time, 1.25);
  const completed = await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: pending.updatedAt, textHash: 'a'.repeat(64),
    deps: {
      now: () => Date.parse('2026-09-25T00:01:00.000Z'),
      reserveDailyQuota: async () => true,
      getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test', systemPrompt: '' }),
      askAI: async () => ({ translations: [{ unitId: 0, text: '你好' }] }),
    },
  });
  assert.equal(completed.state, 'updated');
  assert.deepEqual(store.current().translation.lines, ['你好']);
  assert.equal(store.current().original.lines[0].time, 1.25);
});

test('line editing keeps unchanged word timing, aligns translation, and rejects malformed words', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  const good = await route(request(path('/document'), 'PUT', { etag: 'etag-1', lines: [
    { time: 1, endTime: 2, text: 'Hello', words: [{ text: 'Hello', startTime: 1, endTime: 2 }], tlyric: '你好' },
    { time: 3, text: 'New line', tlyric: '新的一行' },
  ] }), { store });
  assert.equal(good.status, 200);
  assert.equal(store.current().original.source, 'manual');
  assert.equal(store.current().original.lines[0].words.length, 1);
  assert.deepEqual(store.current().translation.lines, ['你好', '新的一行']);
  const bad = await route(request(path('/document'), 'PUT', { etag: 'etag-2', lines: [
    { time: 1, text: 'Changed', words: [{ text: 'Hello', startTime: 1, endTime: 2 }] },
  ] }), { store });
  assert.equal(bad.status, 422);
  assert.equal(store.calls.put, 1);
});

test('manual lyric translation remains visible after saving under a non-Chinese instance target', async () => {
  const songs = makeSongDb();
  const db = { prepare(sql) {
    if (sql.includes('instance_settings')) return { async first() { return { value_json: JSON.stringify({
      provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2, styleRules: '',
      targetLanguage: 'ja', cleanDirtyLyrics: true, translateLyrics: true,
      detectLanguage: true, referenceExistingTranslation: false,
    }) }; } };
    return songs.prepare(sql);
  } };
  const store = createMemoryLyricStore(makeReadyArtifact());
  const saved = await route(request(path('/document'), 'PUT', { etag: 'etag-1', lines: [
    { time: 1, text: 'Hello', tlyric: 'こんにちは' },
  ] }), { db, store });
  assert.equal(saved.status, 200);
  assert.equal(store.current().translation.language, 'ja');
  assert.equal((await saved.json()).data.lyrics.lines[0].tlyric, 'こんにちは');
  const read = await route(request(path()), { db, store, session: member });
  assert.equal((await read.json()).data.lyrics.lines[0].tlyric, 'こんにちは');
});

test('a broken instance lyric target never falls back to displaying an old Chinese translation', async () => {
  const songs = makeSongDb();
  const db = { prepare(sql) {
    if (sql.includes('instance_settings')) return { async first() { throw new Error('db offline'); } };
    return songs.prepare(sql);
  } };
  const response = await route(request(path()), { db, session: member });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'LYRIC_AI_CONFIG_UNAVAILABLE');
});

test('LRC import replaces a song asset and JSON restore brings back full word timing', async () => {
  const previous = makeReadyArtifact();
  const store = createMemoryLyricStore(previous);
  const imported = await route(request(path('/import'), 'POST', {
    etag: 'etag-1', lrc: '[00:02.250]Imported line\n[00:05.000]Second line',
  }), { store });
  assert.equal(imported.status, 200);
  assert.equal(store.current().original.source, 'manual');
  assert.equal(store.current().original.lines[0].time, 2.25);
  const restored = await route(request(path('/restore'), 'POST', { etag: 'etag-2', asset: previous }), { store });
  assert.equal(restored.status, 200);
  assert.equal(store.current().original.lines[0].words[0].text, 'Hello');
  const foreign = await route(request(path('/restore'), 'POST', {
    etag: 'etag-3', asset: { ...previous, songId: 'another-song' },
  }), { store });
  assert.equal(foreign.status, 422);
  assert.equal(store.calls.put, 2);
});

test('editor and timeline changes round-trip through validated R2 storage', async () => {
  const key = 'media/lyrics/song-1.json';
  const bucket = createMemoryR2Bucket({ initialObjects: { [key]: makeReadyArtifact() } });
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  const edited = await route(request(path('/document'), 'PUT', { etag: 'etag-0', lines: [
    { time: 1, endTime: 2, text: 'Hello', words: [{ text: 'Hello', startTime: 1, endTime: 2 }], tlyric: '你好' },
  ] }), { store });
  assert.equal(edited.status, 200);
  assert.equal(bucket.json(key).translation.lines[0], '你好');
  const shifted = await route(request(path('/timeline'), 'PATCH', { etag: 'etag-1', deltaMs: 125 }), { store });
  assert.equal(shifted.status, 200);
  assert.equal(bucket.json(key).original.lines[0].words[0].startTime, 1.125);
  assert.equal(bucket.json(key).offsetMs, 0);
  const fetched = await route(request(path()), { session: member, store });
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).data.lyrics.lines[0].tlyric, '你好');
});

test('editor preserves a canonical multiline original while rejecting multiline translation', async () => {
  const key = 'media/lyrics/song-1.json';
  const bucket = createMemoryR2Bucket({ initialObjects: { [key]: makeReadyArtifact() } });
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  const edited = await route(request(path('/document'), 'PUT', { etag: 'etag-0', lines: [
    { time: 1, text: 'First line\nSecond line', tlyric: '译文' },
  ] }), { store });
  assert.equal(edited.status, 200);
  assert.equal(bucket.json(key).original.lines[0].text, 'First line\nSecond line');
  const rejected = await route(request(path('/document'), 'PUT', { etag: 'etag-1', lines: [
    { time: 1, text: 'First line\nSecond line', tlyric: '译文\n第二行' },
  ] }), { store });
  assert.equal(rejected.status, 400);
  assert.equal(bucket.calls.put.length, 1);
});

test('two editors cannot overwrite a newer shared lyric with the original ETag', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  const first = await route(request(path('/document'), 'PUT', { etag: 'etag-1', lines: [
    { time: 1, text: 'Editor A' },
  ] }), { store });
  assert.equal(first.status, 200);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stale = await route(request(path('/document'), 'PUT', { etag: 'etag-1', lines: [
      { time: 1, text: 'Editor B stale draft' },
    ] }), { store });
    assert.equal(stale.status, 409);
  }
  assert.equal(store.current().original.lines[0].text, 'Editor A');
  assert.equal(store.calls.put, 1);
});

test('workspace resolves song metadata from local SQLite and lyric artifact from local R2 fake', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`CREATE TABLE instance_settings (key TEXT PRIMARY KEY, value_json TEXT);
      CREATE TABLE Songs (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT,
      album TEXT, duration REAL, language TEXT);
      INSERT INTO Songs VALUES ('song-1', 'Night Song', 'Singer', 'Album', 255, 'en');`);
    const db = { prepare(sql) { return { first: async () => sqlite.prepare(sql).get() ?? null,
      bind(...args) { return {
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
    }; } }; } };
    const bucket = createMemoryR2Bucket({ initialObjects: {
      'media/lyrics/song-1.json': makeReadyArtifact(),
    } });
    const response = await handleLocalLyricsManageRoute(request(path()),
      new URL(`https://tune.test${path()}`), db, {}, member,
      { MEDIA_BUCKET: bucket }, {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.song.title, 'Night Song');
    assert.deepEqual(bucket.calls.get, ['media/lyrics/song-1.json']);
  } finally { sqlite.close(); }
});

test('instrumental workspace never touches the bucket, provider, or completion service', async () => {
  let sideEffects = 0;
  const store = new Proxy({}, { get() { sideEffects += 1; throw new Error('R2 touched'); } });
  const db = makeSongDb([makeSong({ language: 'instrumental' })]);
  const cases = [
    [path(), 'GET', undefined, 200],
    [path('/candidates'), 'GET', undefined, 200],
    [path('/candidates/inspect'), 'POST', { candidates: [] }, 200],
    [path(), 'PUT', { source: 'auto', etag: null }, 422],
    [path('/offset'), 'PATCH', { offsetMs: 100, etag: null }, 422],
    [path(), 'DELETE', { etag: null }, 422],
    [path('/translation'), 'DELETE', { etag: null }, 422],
    [path('/ai-completion'), 'POST', {}, 422],
  ];
  for (const [urlPath, method, body, status] of cases) {
    const response = await route(request(urlPath, method, body), { db, store });
    assert.equal(response.status, status, `${method} ${urlPath}`);
  }
  assert.equal(sideEffects, 0);
});

test('candidate lookup and inspection filter provider-only fields and enforce request bounds', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  let lookupSong;
  const listed = await route(request(`${path('/candidates')}?title=Deep%20End&artist=Artist`), {
    store, deps: { listCandidates: async (song) => {
      lookupSong = song;
      return { candidates: [{ source: 'kugou', providerLyricId: 'kg-2', score: 12,
        content: 'private content', accesskey: 'private key' }], warnings: [] };
    } },
  });
  assert.equal(listed.status, 200);
  assert.equal(lookupSong.title, 'Deep End');
  const listedText = await listed.text();
  assert.equal(listedText.includes('private content'), false);
  assert.equal(listedText.includes('private key'), false);

  let inspected;
  const inspection = await route(request(path('/candidates/inspect'), 'POST', {
    candidates: [{ source: 'kugou', providerLyricId: 'kg-2' }], searchTitle: 'Deep End',
  }), { store, deps: { inspectCandidates: async (song, candidates, options) => {
    inspected = { song, candidates, maxBytes: options.maxResponseBytes };
    return { items: [{ source: 'kugou', providerLyricId: 'kg-2', state: 'ready',
      lyrics: { lines: [{ text: 'Hello' }] } }], truncated: false };
  } } });
  assert.equal(inspection.status, 200);
  assert.equal(inspected.song.title, 'Deep End');
  assert.ok(inspected.maxBytes > 0);
  assert.equal((await inspection.json()).data.results[0].state, 'ready');
  assert.equal(store.calls.put, 0);
  assert.equal((await route(request(path('/candidates/inspect'), 'POST', {
    candidates: [], leaked: 'field',
  }), { store })).status, 400);
});

test('administrator replaces a selected candidate with R2 conditional ETag and stale writes skip provider', async () => {
  const key = 'media/lyrics/song-1.json';
  const bucket = createMemoryR2Bucket({ initialObjects: { [key]: makeReadyArtifact() } });
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  let fetched = 0;
  const stale = await route(request(path(), 'PUT', {
    source: 'kugou', providerLyricId: 'kg-2', etag: 'wrong',
  }), { store, deps: { fetchDocument: async () => { fetched += 1; return makeLyricDocument(); } } });
  assert.equal(stale.status, 409);
  assert.equal(fetched, 0);
  const updated = await route(request(path(), 'PUT', {
    source: 'kugou', providerLyricId: 'kg-2', etag: 'etag-0',
  }), { store, deps: { fetchDocument: async (_source, _song, options) => {
    fetched += 1;
    return makeLyricDocument({ providerMeta: {
      providerLyricId: options.providerLyricId, matchedTitle: 'Night Song', matchedArtist: 'Singer',
      matchedDuration: 255,
    } });
  } } });
  assert.equal(updated.status, 200);
  assert.equal(fetched, 1);
  assert.equal(bucket.json(key).provenance.providerLyricId, 'kg-2');
  assert.deepEqual(bucket.calls.put[0].options.onlyIf, { etagMatches: 'etag-0' });
});

test('vanished candidate and concurrent R2 update cannot replace the selected lyric', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  const vanished = await route(request(path(), 'PUT', {
    source: 'kugou', providerLyricId: 'not-there', etag: 'etag-1',
  }), { store, deps: { fetchDocument: async () => {
    throw new LyricSourceError('not_found', 'kugou', 'selected-candidate', 'gone');
  } } });
  assert.equal(vanished.status, 422);
  assert.equal(store.calls.put, 0);

  const originalPut = store.putIfMatch;
  store.putIfMatch = async (songId, artifact, etag) => {
    if (store.calls.put === 0) {
      await originalPut(songId, makeReadyArtifact({ offsetMs: 350 }), etag);
    }
    return originalPut(songId, artifact, etag);
  };
  const conflict = await route(request(path(), 'PUT', {
    source: 'kugou', providerLyricId: 'kg-2', etag: 'etag-1',
  }), { store, deps: { fetchDocument: async () => makeLyricDocument() } });
  assert.equal(conflict.status, 409);
  assert.equal(store.current().offsetMs, 350);
});

test('offset, translation clear, reset, and completion are separate ETag-safe operations', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact({ translation: {
    source: 'kugou', originalTextHash: 'a'.repeat(64), lines: ['你好'],
    updatedAt: '2026-09-10T00:00:00.000Z',
  } }));
  const stale = await route(request(path('/offset'), 'PATCH', { offsetMs: 150, etag: 'stale' }), { store });
  assert.equal(stale.status, 409);
  assert.equal(store.calls.put, 0);
  const offset = await route(request(path('/offset'), 'PATCH', { offsetMs: 150, etag: 'etag-1' }), { store });
  assert.equal(offset.status, 200);
  assert.equal(store.current().offsetMs, 150);
  assert.ok(store.current().translation);
  const cleared = await route(request(path('/translation'), 'DELETE', { etag: 'etag-2' }), { store });
  assert.equal(cleared.status, 200);
  assert.equal(store.current().translation, null);
  const reset = await route(request(path(), 'DELETE', { etag: 'etag-3' }), { store });
  assert.equal(reset.status, 200);
  assert.equal(store.current().status, 'reset');
  assert.equal(store.calls.delete, 0);

  const completionStore = createMemoryLyricStore(makeReadyArtifact());
  let called = 0;
  const completion = await route(request(path('/ai-completion'), 'POST', {}), { store: completionStore,
    deps: { beginCompletion: async () => {
      called += 1;
      return { state: 'pending', etag: 'etag-1', artifact: makeReadyArtifact({
        aiCompletion: { status: 'pending', updatedAt: '2026-09-10T00:00:00.000Z' },
      }), task: null };
    } },
  });
  assert.equal(completion.status, 202);
  assert.equal(called, 1);
  assert.equal((await completion.json()).data.status, 'pending');
});

test('malformed methods, bodies, and ids never modify the lyric asset', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact());
  assert.equal((await route(request(path('/offset'), 'POST', {}), { store })).status, 405);
  assert.equal((await route(request(path(), 'PUT', { source: 'auto', etag: 'etag-1', user_sub: 'old' }), { store })).status, 400);
  assert.equal((await route(request(path('/offset'), 'PATCH', { offsetMs: 6000, etag: 'etag-1' }), { store })).status, 400);
  assert.equal((await route(request(path(), 'DELETE', { etag: 17 }), { store })).status, 400);
  assert.equal((await route(request('/api/lyrics/workspace/%00'), { store })).status, 400);
  assert.equal(store.calls.put, 0);
  assert.equal(store.calls.create, 0);
});
