import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildReadyLyricArtifact } from '../services/lyricAssetWorkflow.js';
import { DEFAULT_LYRIC_AI_CONFIG } from '../utils/lyricAiConfig.js';
import { createMemoryLyricStore, makeReadyArtifact } from '../test/lyricAssetFixtures.js';
import { createLyricsResultFromResponse } from '../../../client/src/hooks/useLyricsFetcher.js';
import { handleLocalMetadataReadRoute } from './localMetadataRead.js';

class Statement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sqlite, this.sql, values); }
  async first() { return this.sqlite.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() { return this.sqlite.prepare(this.sql).run(...this.values); }
}

function baseline() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) { return new Statement(sqlite, sql); } };
}

function r2() {
  const objects = new Map();
  const calls = [];
  const bucket = {
    async get(key) {
      calls.push(key);
      const text = objects.get(key);
      return text === undefined ? null : { size: Buffer.byteLength(text), etag: 'local-etag', text: async () => text };
    },
    async put() { throw new Error('metadata GET must not write R2'); },
    async delete() { throw new Error('metadata GET must not delete R2'); },
  };
  return { objects, calls, bucket };
}

async function call(db, path, { accountId = 'owner', method = 'GET', bucket, deps } = {}) {
  const request = new Request(`https://flaretune.test${path}`, { method });
  const env = bucket ? { MEDIA_BUCKET: bucket } : {};
  return handleLocalMetadataReadRoute(request, new URL(request.url), db, { 'X-Test': 'metadata' }, accountId, env, deps);
}

test('route is closed without a normal local account and only handles canonical paths', async () => {
  const db = baseline();
  assert.equal(await call(db, '/api/artist-photos?name=Artist'), null);
  for (const path of ['/api/lyrics?songId=a', '/api/artist-photo?name=Artist']) {
    const response = await call(db, path, { accountId: '' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  assert.equal((await call(db, '/api/lyrics?songId=a', { method: 'POST' })).status, 405);
  assert.equal((await call(null, '/api/artist-photo?name=Artist')).status, 503);
});

test('empty baseline and malformed queries return stable private responses', async (t) => {
  const provider = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ artists: null, data: {} }), { status: 200 }));
  const db = baseline();
  const lyrics = await call(db, '/api/lyrics?songId=missing');
  assert.equal(lyrics.status, 404);
  assert.equal((await lyrics.json()).reason, 'song_not_found');
  const photo = await call(db, '/api/artist-photo?name=Unknown');
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('X-Test'), 'metadata');
  assert.deepEqual((await photo.json()).data, {
    artist: 'Unknown', artistNames: ['Unknown'], primary: '', photos: [],
    meta: { artistsCount: 1, totalPhotos: 0 },
  });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM Artist_Photos WHERE artist_name = 'Unknown'").get().count, 0);
  assert.equal(provider.mock.calls.length, 0);
  for (const path of [
    '/api/lyrics', '/api/lyrics?songId=a&songId=b', '/api/lyrics?songId=..',
    '/api/lyrics?songId=a%2Fb', '/api/lyrics?songId=a&source=remote',
    '/api/artist-photo', '/api/artist-photo?artist=Wrong',
    '/api/artist-photo?name=A&name=B', '/api/artist-photo?name=%00',
  ]) assert.equal((await call(db, path)).status, 400, path);
});

test('lyrics GET reuses ready assets and automatically searches a missing song', async () => {
  const db = baseline();
  db.sqlite.exec(`INSERT INTO Songs (id, title, artist, language) VALUES
    ('song-1', 'One', 'Artist', 'en'),
    ('instrumental', 'No vocals', 'Artist', 'instrumental')`);
  const store = r2();
  const ready = await buildReadyLyricArtifact({ id: 'song-1' }, {
    source: 'netease', format: 'lrc', lines: [{ time: 1, text: 'Hello', tlyric: '你好' }],
  });
  store.objects.set('media/lyrics/song-1.json', JSON.stringify(ready.artifact));
  const success = await call(db, '/api/lyrics?songId=song-1', { bucket: store.bucket });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('Cache-Control'), 'private, no-store');
  const result = await success.json();
  assert.equal(result.code, 200);
  assert.equal(result.data.version, 2);
  assert.equal(result.data.lines[0].text, 'Hello');
  assert.deepEqual(store.calls, ['media/lyrics/song-1.json']);

  const instrumental = await call(db, '/api/lyrics?songId=instrumental');
  assert.equal(instrumental.status, 200);
  assert.equal((await instrumental.json()).data.reason, 'instrumental');
  const missingStore = createMemoryLyricStore();
  const aiCalls = [];
  const absent = await call(db, '/api/lyrics?songId=song-1', { deps: {
    store: missingStore,
    fetchDocument: async (provider) => provider === 'lrclib'
      ? { source: 'lrclib', format: 'lrc', lines: [{ time: 1, text: 'Hello' }] } : null,
    beginCompletion: async ({ store: lyricStore }) => {
      aiCalls.push('started');
      return { artifact: (await lyricStore.get('song-1')).artifact, task: Promise.resolve() };
    },
  } });
  assert.equal(absent.status, 200);
  assert.equal((await absent.json()).data.lines[0].text, 'Hello');
  assert.equal(missingStore.calls.create, 1);
  assert.deepEqual(aiCalls, ['started']);
  assert.equal((await call(db, '/api/lyrics?songId=song-1')).status, 503);
});

test('manual lyric asset from the workbench reaches the player with its translation', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const store = r2();
  const ready = await buildReadyLyricArtifact({ id: 'song-1' }, {
    source: 'manual', format: 'lrc',
    lines: [{ time: 1, text: 'Hello', tlyric: '你好' }],
  });
  store.objects.set('media/lyrics/song-1.json', JSON.stringify(ready.artifact));
  const response = await call(db, '/api/lyrics?songId=song-1', { bucket: store.bucket });
  assert.equal(response.status, 200);
  const result = createLyricsResultFromResponse(await response.json(), response.status);
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'manual');
  assert.equal(result.lyrics[0].text, 'Hello');
  assert.equal(result.lyrics[0].translation, '你好');
});

test('an existing untranslated lyric automatically starts Worker AI for a member and does not repeat after completion', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const store = createMemoryLyricStore(makeReadyArtifact());
  const tasks = [];
  let aiCalls = 0;
  const deps = { store, ctx: { waitUntil: (task) => tasks.push(task) }, aiDeps: {
    reserveDailyQuota: async () => true,
    getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test', systemPrompt: '' }),
    resolveAiFeature: async () => null,
    askAI: async () => { aiCalls += 1; return { translations: [{ unitId: 0, text: '你好' }] }; },
  } };
  const first = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).data.translationState, 'pending');
  assert.equal(tasks.length, 1);
  await Promise.all(tasks);
  assert.equal(aiCalls, 1);
  const second = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps });
  assert.equal((await second.json()).data.translationState, 'ready');
  assert.equal(tasks.length, 1);
  assert.equal(store.current().translation.lines[0], '你好');
});

test('a provider Chinese translation is usable without starting automatic AI', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const store = createMemoryLyricStore(makeReadyArtifact({ translation: {
    source: 'kugou', originalTextHash: 'a'.repeat(64), lines: ['你好'],
    updatedAt: '2026-09-10T00:00:00.000Z',
  } }));
  let starts = 0;
  const response = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps: {
    store, beginCompletion: async () => { starts += 1; throw new Error('AI must not start'); },
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.translationState, 'ready');
  assert.equal(starts, 0);
  assert.equal(store.calls.put, 0);
});

test('automatic lyric completion switch leaves manual AI available while total switch hides AI state', async () => {
  for (const completionEnabled of [true, false]) {
    const db = baseline();
    db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
    db.sqlite.prepare(`INSERT INTO instance_settings
      (key, value_json, revision, updated_at, updated_by) VALUES (?, ?, 1, 1, 'test')`)
      .run('lyrics.ai', JSON.stringify({ ...DEFAULT_LYRIC_AI_CONFIG,
        completionEnabled, automaticCompletionEnabled: false }));
    const store = createMemoryLyricStore(makeReadyArtifact());
    let starts = 0;
    const response = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps: {
      store, beginCompletion: async () => { starts += 1; throw new Error('AI must not start'); },
    } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.translationState,
      completionEnabled ? 'missing' : 'unavailable');
    assert.equal(starts, 0);
  }
});

test('original lyrics in the target language do not start automatic AI', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'zh')");
  const store = createMemoryLyricStore();
  let starts = 0;
  const response = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps: {
    store,
    fetchDocument: async (provider) => provider === 'lrclib'
      ? { source: 'lrclib', format: 'lrc', lines: [{ time: 1, text: '我们一起唱歌' }] } : null,
    beginCompletion: async () => { starts += 1; throw new Error('AI must not start'); },
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.translationState, 'unavailable');
  assert.equal(starts, 0);
});

test('a changed target language clears the old AI translation before automatic replacement', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const config = { ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'ja' };
  db.sqlite.prepare(`INSERT INTO instance_settings
    (key, value_json, revision, updated_at, updated_by) VALUES (?, ?, 1, 1, 'test')`)
    .run('lyrics.ai', JSON.stringify(config));
  const base = makeReadyArtifact();
  const store = createMemoryLyricStore(makeReadyArtifact({
    translation: { source: 'ai', language: 'zh', originalTextHash: base.textHash,
      lines: ['你好'], updatedAt: base.updatedAt },
  }));
  const tasks = [];
  const response = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps: {
    store, ctx: { waitUntil: (task) => tasks.push(task) }, aiDeps: {
      reserveDailyQuota: async () => true,
      resolveAiFeature: async () => null,
      askAI: async () => ({ translations: [{ unitId: 0, text: 'こんにちは' }] }),
    },
  } });
  assert.equal((await response.json()).data.translationState, 'pending');
  assert.equal(store.current().translation, null);
  await Promise.all(tasks);
  assert.equal(store.current().translation.language, 'ja');
  assert.deepEqual(store.current().translation.lines, ['こんにちは']);
});

test('changing the target to the original language clears an old translation without AI', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const config = { ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'en' };
  db.sqlite.prepare(`INSERT INTO instance_settings
    (key, value_json, revision, updated_at, updated_by) VALUES (?, ?, 1, 1, 'test')`)
    .run('lyrics.ai', JSON.stringify(config));
  const base = makeReadyArtifact();
  const store = createMemoryLyricStore(makeReadyArtifact({
    translation: { source: 'ai', language: 'zh', originalTextHash: base.textHash,
      lines: ['你好'], updatedAt: base.updatedAt },
  }));
  let starts = 0;
  const response = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps: {
    store,
    beginCompletion: async () => { starts += 1; throw new Error('AI must not start'); },
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.translationState, 'unavailable');
  assert.equal(store.current().translation, null);
  assert.equal(starts, 0);
});

test('a concurrent stale-translation write is re-read before returning lyrics', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const config = { ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'en' };
  db.sqlite.prepare(`INSERT INTO instance_settings
    (key, value_json, revision, updated_at, updated_by) VALUES (?, ?, 1, 1, 'test')`)
    .run('lyrics.ai', JSON.stringify(config));
  const base = makeReadyArtifact();
  const oldTranslation = { source: 'ai', language: 'zh', originalTextHash: base.textHash,
    lines: ['你好'], updatedAt: base.updatedAt };
  const memory = createMemoryLyricStore(makeReadyArtifact({ translation: oldTranslation }));
  let conflicts = 0;
  const store = {
    ...memory,
    async putIfMatch(songId, next, etag) {
      if (conflicts++ === 0) {
        await memory.putIfMatch(songId, { ...next, translation: oldTranslation }, etag);
        return { state: 'conflict' };
      }
      return memory.putIfMatch(songId, next, etag);
    },
  };
  const response = await call(db, '/api/lyrics?songId=song-1', { deps: { store } });
  assert.equal(response.status, 200);
  assert.equal(conflicts, 2);
  assert.equal(memory.current().translation, null);
});

test('automatic AI records a no-translation result so later plays do not spend another request', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const store = createMemoryLyricStore(makeReadyArtifact());
  const tasks = [];
  let aiCalls = 0;
  const deps = { store, ctx: { waitUntil: (task) => tasks.push(task) }, aiDeps: {
    reserveDailyQuota: async () => true,
    getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test', systemPrompt: '' }),
    resolveAiFeature: async () => null,
    askAI: async () => { aiCalls += 1; return { notNeeded: true }; },
  } };
  await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps });
  await Promise.all(tasks);
  assert.equal(store.current().aiCompletion.status, 'completed');
  const putCount = store.calls.put;
  const again = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).data.translationState, 'unavailable');
  assert.equal(aiCalls, 1);
  assert.equal(store.calls.put, putCount);
});

test('a changed lyric AI target or processing switch retries completed analysis, including legacy markers', async () => {
  for (const { changedConfig, processingKey } of [
    { changedConfig: { ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'ja' }, processingKey: 'zh|1|1|1|0' },
    { changedConfig: { ...DEFAULT_LYRIC_AI_CONFIG, cleanDirtyLyrics: false }, processingKey: 'zh|1|1|1|0' },
    { changedConfig: DEFAULT_LYRIC_AI_CONFIG, processingKey: null },
  ]) {
    const db = baseline();
    db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
    const store = createMemoryLyricStore(makeReadyArtifact({
      aiCompletion: { status: 'completed', ...(processingKey ? { processingKey } : {}),
        updatedAt: '2026-09-25T00:00:00.000Z' },
    }));
    db.sqlite.prepare(`INSERT INTO instance_settings
      (key, value_json, revision, updated_at, updated_by) VALUES (?, ?, 1, 1, 'test')`)
      .run('lyrics.ai', JSON.stringify(changedConfig));
    const tasks = [];
    let aiCalls = 0;
    const deps = { store, ctx: { waitUntil: (task) => tasks.push(task) }, aiDeps: {
      reserveDailyQuota: async () => true,
      resolveAiFeature: async () => null,
      askAI: async () => { aiCalls += 1; return { translations: [{ unitId: 0, text: '訳文' }] }; },
    } };
    const first = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps });
    assert.equal((await first.json()).data.translationState, 'pending');
    await Promise.all(tasks);
    assert.equal(aiCalls, 1);
    assert.equal((await (await call(db, '/api/lyrics?songId=song-1',
      { accountId: 'member', deps })).json()).data.translationState, 'ready');
    assert.equal(aiCalls, 1);
  }
});

test('player lyric GET resolves a pending legacy cleanup without asking the listener', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  const base = makeReadyArtifact();
  const store = createMemoryLyricStore(makeReadyArtifact({
    original: { ...base.original, lines: [
      { time: 0, text: 'Lyrics by: Someone' }, base.original.lines[0],
    ] },
    translation: { source: 'ai', language: 'zh', originalTextHash: base.textHash,
      lines: ['', '你好'], updatedAt: base.updatedAt },
    aiCompletion: { status: 'review', candidateIndices: [0],
      reviewAccountId: 'different-account', updatedAt: base.updatedAt },
  }));
  const response = await call(db, '/api/lyrics?songId=song-1', { deps: { store } });
  assert.equal(response.status, 200);
  const result = createLyricsResultFromResponse(await response.json(), response.status);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.lyrics.map((line) => [line.text, line.translation]), [['Hello', '你好']]);
  assert.equal(store.current().aiCompletion, null);
  assert.equal(store.calls.put, 1);
});

test('a legacy cleanup and target change start translation on the same read', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title, artist, language) VALUES ('song-1', 'One', 'Artist', 'en')");
  db.sqlite.prepare(`INSERT INTO instance_settings
    (key, value_json, revision, updated_at, updated_by) VALUES (?, ?, 1, 1, 'test')`)
    .run('lyrics.ai', JSON.stringify({ ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'ja' }));
  const base = makeReadyArtifact();
  const store = createMemoryLyricStore(makeReadyArtifact({
    original: { ...base.original, lines: [
      { time: 0, text: 'Lyrics by: Someone' }, base.original.lines[0],
    ] },
    translation: { source: 'ai', language: 'zh', originalTextHash: base.textHash,
      lines: ['', '你好'], updatedAt: base.updatedAt },
    aiCompletion: { status: 'review', candidateIndices: [0],
      reviewAccountId: 'different-account', updatedAt: base.updatedAt },
  }));
  const tasks = [];
  const response = await call(db, '/api/lyrics?songId=song-1', { accountId: 'member', deps: {
    store, ctx: { waitUntil: (task) => tasks.push(task) }, aiDeps: {
      reserveDailyQuota: async () => true,
      resolveAiFeature: async () => null,
      askAI: async () => ({ translations: [{ unitId: 0, text: 'こんにちは' }] }),
    },
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.translationState, 'pending');
  assert.equal(tasks.length, 1);
  await Promise.all(tasks);
  assert.equal(store.current().translation.language, 'ja');
});

test('invalid, retired, and unavailable lyric assets fail closed without leaking storage data', async () => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs (id, title) VALUES ('song-1', 'One')");
  const store = r2();
  store.objects.set('media/lyrics/song-1.json', '{broken');
  let response = await call(db, '/api/lyrics?songId=song-1', { bucket: store.bucket });
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /broken/u);
  store.objects.set('media/lyrics/song-1.json', JSON.stringify({
    schemaVersion: 1, songId: 'song-1', status: 'reset', updatedAt: '2026-09-23T00:00:00.000Z',
  }));
  response = await call(db, '/api/lyrics?songId=song-1', { bucket: store.bucket,
    deps: { fetchDocument: async () => null } });
  assert.equal(response.status, 503);
  const failedBucket = { get: async () => { throw new Error('private bucket detail'); } };
  response = await call(db, '/api/lyrics?songId=song-1', { bucket: failedBucket });
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private bucket detail/u);
});

test('artist photos use local D1 cache, interleave artists, and discard unsafe URLs', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('cached photos must not fetch providers'); });
  const db = baseline();
  db.sqlite.prepare(`INSERT INTO Artist_Photos
    (artist_name, photo_url, photos, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`).run(
    'Alpha', 'https://images.test/fallback.jpg', JSON.stringify([
      { url: 'https://images.test/a.jpg', width: 1920, height: 1080, source: 'local' },
      { url: 'javascript:alert(1)' },
      { url: 'https://images.test/shared.jpg' },
    ]),
  );
  db.sqlite.prepare(`INSERT INTO Artist_Photos
    (artist_name, photo_url, photos, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`).run(
    'Beta', '', JSON.stringify([
      { url: 'https://images.test/b.jpg', width: 900, height: 900 },
      { url: 'https://images.test/shared.jpg' },
    ]),
  );
  const response = await call(db, '/api/artist-photo?name=Alpha%20%26%20Beta');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.artistNames, ['Alpha', 'Beta']);
  assert.deepEqual(data.photos.map((photo) => photo.url), [
    'https://images.test/a.jpg', 'https://images.test/b.jpg', 'https://images.test/shared.jpg',
  ]);
  assert.equal(data.primary, 'https://images.test/a.jpg');
  assert.equal(data.photos[0].artistName, 'Alpha');
  assert.equal(data.meta.totalPhotos, 3);
});

test('artist photos fetch real artwork on a cache miss and reuse the saved D1 gallery', async (t) => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs(id, title, artist) VALUES ('lady-song', 'One', 'Lady Gaga')");
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).includes('theaudiodb.com/api/')) {
      return Response.json({ artists: [
        { strArtist: 'Adele', strArtistFanart: 'https://images.test/wrong.jpg' },
        { strArtist: 'Lady Gaga', strArtistFanart: 'https://www.theaudiodb.com/images/lady-fanart.jpg' },
      ] });
    }
    if (String(url).includes('c.y.qq.com/')) {
      return Response.json({ data: { singer: { itemlist: [
        { mid: 'wrong1', name: 'Adele' }, { mid: 'wrong2', name: 'Adele' },
        { mid: 'wrong3', name: 'Adele' }, { mid: 'lady123', name: 'Lady Gaga' },
      ] } } });
    }
    throw new Error('album-cover fallback must not be fetched for artist photos');
  });
  const first = await call(db, '/api/artist-photo?name=Lady%20Gaga');
  assert.equal(first.status, 200);
  const firstData = (await first.json()).data;
  assert.equal(firstData.photos.length, 2);
  assert.equal(firstData.photos[0].url, 'https://www.theaudiodb.com/images/lady-fanart.jpg');
  assert.ok(firstData.photos.every((photo) => photo.isRealArtist === true));
  assert.equal(requests.length, 2);
  assert.match(requests[0], /\/api\/v1\/json\/123\/search\.php/u);
  const saved = db.sqlite.prepare('SELECT photos, data_version FROM Artist_Photos WHERE artist_name = ?').get('Lady Gaga');
  assert.equal(saved.data_version, 3);
  assert.equal(JSON.parse(saved.photos).length, 2);

  const second = await call(db, '/api/artist-photo?name=Lady%20Gaga');
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).data.photos, firstData.photos);
  assert.equal(requests.length, 2);
});

test('empty photo results are cached and multi-artist requests fetch at most two misses', async (t) => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs(id, title, artist) VALUES ('trio-song', 'One', 'Alpha & Beta & Gamma')");
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return Response.json(String(url).includes('theaudiodb.com') ? { artists: null } : { data: {} });
  });
  const first = await call(db, '/api/artist-photo?name=Alpha%20%26%20Beta%20%26%20Gamma');
  assert.equal(first.status, 200);
  assert.equal(requests.length, 4);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM Artist_Photos').get().count, 2);
  const repeat = await call(db, '/api/artist-photo?name=Alpha%20%26%20Beta');
  assert.equal(repeat.status, 200);
  assert.equal(requests.length, 4);
  const third = await call(db, '/api/artist-photo?name=Gamma');
  assert.equal(third.status, 200);
  assert.equal(requests.length, 6);
});

test('mismatched provider search suggestions are not saved as another artist', async (t) => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs(id, title, artist) VALUES ('lady-song', 'One', 'Lady Gaga')");
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(String(url).includes('theaudiodb.com')
    ? { artists: [{ strArtist: 'Adele', strArtistFanart: 'https://images.test/adele.jpg' }] }
    : { data: { singer: { itemlist: [{ mid: 'adele123', name: 'Adele' }] } } }));
  const response = await call(db, '/api/artist-photo?name=Lady%20Gaga');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.photos, []);
  const saved = db.sqlite.prepare('SELECT source, photos FROM Artist_Photos WHERE artist_name = ?').get('Lady Gaga');
  assert.equal(saved.source, 'none');
  assert.deepEqual(JSON.parse(saved.photos), []);
});

test('a failed D1 photo cache write does not report an uncached photo as success', async (t) => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs(id, title, artist) VALUES ('lady-song', 'One', 'Lady Gaga')");
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(String(url).includes('theaudiodb.com')
    ? { artists: [{ strArtist: 'Lady Gaga', strArtistFanart: 'https://images.test/lady.jpg' }] }
    : { data: {} }));
  const failingDb = { prepare(sql) {
    if (sql.includes('INSERT INTO Artist_Photos')) {
      return { bind: () => ({ run: async () => { throw new Error('injected D1 write failure'); } }) };
    }
    return db.prepare(sql);
  } };
  const response = await call(failingDb, '/api/artist-photo?name=Lady%20Gaga');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 503, message: 'Database unavailable' });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM Artist_Photos').get().count, 0);
});

test('a transient provider failure is retried instead of being cached as a missing artist', async (t) => {
  const db = baseline();
  db.sqlite.exec("INSERT INTO Songs(id, title, artist) VALUES ('lady-song', 'One', 'Lady Gaga')");
  const provider = t.mock.method(globalThis, 'fetch', async (url) => String(url).includes('theaudiodb.com')
    ? new Response('temporary error', { status: 503 })
    : Response.json({ data: { singer: { itemlist: [] } } }));
  const first = await call(db, '/api/artist-photo?name=Lady%20Gaga');
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).data.photos, []);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM Artist_Photos').get().count, 0);
  const second = await call(db, '/api/artist-photo?name=Lady%20Gaga');
  assert.equal(second.status, 200);
  assert.equal(provider.mock.calls.length, 4);
});

test('catalog membership finds a short exact artist after many unrelated substring matches', async (t) => {
  const db = baseline();
  const insert = db.sqlite.prepare('INSERT INTO Songs(id, title, artist) VALUES (?, ?, ?)');
  for (let index = 0; index < 120; index += 1) {
    insert.run(`noise-${index}`, 'Noise', `Artist${index}`);
  }
  insert.run('exact-a', 'Exact', 'A');
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(String(url).includes('theaudiodb.com')
    ? { artists: [{ strArtist: 'A', strArtistFanart: 'https://images.test/a.jpg' }] }
    : { data: {} }));
  const response = await call(db, '/api/artist-photo?name=A');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.photos.map((photo) => photo.url), ['https://images.test/a.jpg']);
});
