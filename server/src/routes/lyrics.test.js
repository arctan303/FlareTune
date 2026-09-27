import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLyricsRoute } from './lyrics.js';
import {
  buildLyricArtifactMarker,
  createLyricArtifactStore,
  LyricArtifactStoreError,
} from '../services/lyricArtifactStore.js';
import {
  createMemoryLyricStore,
  createMemoryR2Bucket,
  makeLyricDocument,
  makeReadyArtifact,
  makeSong,
  makeSongDb,
} from '../test/lyricAssetFixtures.js';

const headers = { 'Content-Type': 'application/json; charset=utf-8' };
let requestSequence = 1;
const requestFor = (query = 'songId=song-1') => new Request(`https://music.example/api/lyrics?${query}`, {
  headers: { 'CF-Connecting-IP': `198.51.100.${requestSequence++}` },
});

test('lyrics GET returns one R2 asset with original and existing translation without provider or AI', async () => {
  const artifact = makeReadyArtifact({
    translation: {
      source: 'kugou',
      originalTextHash: 'a'.repeat(64),
      lines: ['你好'],
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
  });
  const store = createMemoryLyricStore(artifact);
  let providerCalls = 0;
  let aiCalls = 0;
  const response = await handleLyricsRoute(
    requestFor(),
    new URL(requestFor().url),
    headers,
    makeSongDb(),
    {
      env: {},
      store,
      fetchLyricsDocument: async () => { providerCalls += 1; },
      runLyricAssetAiCompletion: async () => { aiCalls += 1; },
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.lines[0].tlyric, '你好');
  assert.equal(payload.data.tlyric, '[00:01.000]你好');
  assert.equal(payload.data.translationAvailable, true);
  assert.equal(payload.data.translationState, 'ready');
  assert.equal(payload.data.translationStartedAt, null);
  assert.equal(providerCalls, 0);
  assert.equal(aiCalls, 0);
});

test('lyrics GET reports target-language config failure instead of showing a fallback translation', async () => {
  const songs = makeSongDb();
  const db = { prepare(sql) {
    if (sql.includes('instance_settings')) return { async first() { throw new Error('db unavailable'); } };
    return songs.prepare(sql);
  } };
  const request = requestFor();
  const response = await handleLyricsRoute(request, new URL(request.url), headers, db,
    { env: {}, store: createMemoryLyricStore(makeReadyArtifact()) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'LYRIC_AI_CONFIG_UNAVAILABLE');
});

test('lyrics GET accepts only songId and rejects retired source selection', async () => {
  const response = await handleLyricsRoute(
    requestFor('songId=song-1&source=kugou'),
    new URL(requestFor('songId=song-1&source=kugou').url),
    headers,
    makeSongDb(),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Only songId/u);
});

test('instrumental songs short-circuit before R2, provider, and AI', async () => {
  const song = makeSong({ language: 'instrumental' });
  let storeCalls = 0;
  let providerCalls = 0;
  let aiCalls = 0;
  const response = await handleLyricsRoute(
    requestFor(),
    new URL(requestFor().url),
    headers,
    makeSongDb([song]),
    {
      env: {},
      store: { get: async () => { storeCalls += 1; } },
      fetchLyricsDocument: async () => { providerCalls += 1; },
      runLyricAssetAiCompletion: async () => { aiCalls += 1; },
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.reason, 'instrumental');
  assert.equal(payload.data.translationState, 'unavailable');
  assert.deepEqual([storeCalls, providerCalls, aiCalls], [0, 0, 0]);
});

test('cold miss persists without scheduling AI completion', async () => {
  const store = createMemoryLyricStore();
  const scheduled = [];
  const response = await handleLyricsRoute(
    requestFor(),
    new URL(requestFor().url),
    headers,
    makeSongDb(),
    {
      env: {},
      store,
      fetchLyricsDocument: async () => makeLyricDocument(),
      now: () => Date.parse('2026-09-10T01:00:00.000Z'),
      runLyricAssetAiCompletion: async (options) => { scheduled.push(options.textHash); },
      ctx: { waitUntil(task) { scheduled.push(task); } },
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(store.calls.create, 1);
  assert.equal(store.current().status, 'ready');
  assert.equal(payload.data.translationAvailable, false);
  assert.equal(payload.data.translationState, 'missing');
  assert.equal(payload.data.translationStartedAt, null);
  assert.equal(store.current().aiCompletion, null);
  assert.equal(scheduled.length, 0);
});

test('lyrics GET lazily replaces a known legacy object and returns canonical lyrics', async () => {
  const key = 'media/lyrics/song-1.json';
  const bucket = createMemoryR2Bucket({
    initialObjects: {
      [key]: {
        success: true,
        data: {
          source: 'Netease',
          type: 'synced',
          lyrics: '[00:01.00]Legacy lyric',
          translated_lyrics: '',
        },
      },
    },
  });
  const response = await handleLyricsRoute(
    requestFor(),
    new URL(requestFor().url),
    headers,
    makeSongDb(),
    {
      env: {},
      store: createLyricArtifactStore({ MEDIA_BUCKET: bucket }),
      fetchLyricsDocument: async () => makeLyricDocument(),
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.version, 2);
  assert.equal(payload.data.source, 'kugou');
  assert.equal(payload.data.lines[0].text, 'Hello');
  assert.deepEqual(bucket.calls.put[0].options.onlyIf, { etagMatches: 'etag-0' });
  assert.equal(bucket.json(key).status, 'ready');
});

test('confirmed no-lyrics result is persisted as not_found and returned as 404', async () => {
  const store = createMemoryLyricStore();
  let providerCalls = 0;
  const deps = {
    env: {},
    store,
    fetchLyricsDocument: async () => { providerCalls += 1; return null; },
  };
  const first = await handleLyricsRoute(requestFor(), new URL(requestFor().url), headers, makeSongDb(), deps);
  const second = await handleLyricsRoute(requestFor(), new URL(requestFor().url), headers, makeSongDb(), deps);
  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(store.current().status, 'not_found');
  assert.equal(providerCalls, 3);
});

test('R2 failures are retryable and never masquerade as not_found', async () => {
  const response = await handleLyricsRoute(
    requestFor(),
    new URL(requestFor().url),
    headers,
    makeSongDb(),
    {
      env: {},
      store: {
        async get() { throw new LyricArtifactStoreError('r2_read_failed', 'get', 'offline'); },
      },
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error, 'r2_read_failed');
  assert.notEqual(payload.reason, 'lyrics_not_found');
});

test('deleting is retryable while reset is rebuilt as a cold miss', async () => {
  const deletingStore = createMemoryLyricStore(buildLyricArtifactMarker('song-1', 'deleting', {
    operationId: 'delete-1',
  }));
  let deletingProviderCalls = 0;
  const deleting = await handleLyricsRoute(
    requestFor(),
    new URL(requestFor().url),
    headers,
    makeSongDb(),
    {
      env: {},
      store: deletingStore,
      fetchLyricsDocument: async () => { deletingProviderCalls += 1; return makeLyricDocument(); },
    },
  );
  assert.equal(deleting.status, 503);
  assert.equal((await deleting.json()).error, 'lyric_asset_deleting');
  assert.equal(deletingProviderCalls, 0);

  const resetStore = createMemoryLyricStore(buildLyricArtifactMarker('song-1', 'reset'));
  let resetProviderCalls = 0;
  let resetAiCalls = 0;
  const reset = await handleLyricsRoute(
    requestFor(),
    new URL(requestFor().url),
    headers,
    makeSongDb(),
    {
      env: {},
      store: resetStore,
      fetchLyricsDocument: async () => { resetProviderCalls += 1; return makeLyricDocument(); },
      runLyricAssetAiCompletion: async () => { resetAiCalls += 1; },
    },
  );
  assert.equal(reset.status, 200);
  assert.equal(resetStore.current().status, 'ready');
  assert.equal(resetProviderCalls, 3);
  assert.equal(resetStore.current().aiCompletion, null);
  assert.equal(resetAiCalls, 0);
});

test('unknown songs remain unavailable before R2 access', async () => {
  let storeCalls = 0;
  const response = await handleLyricsRoute(
    requestFor('songId=missing'),
    new URL(requestFor('songId=missing').url),
    headers,
    makeSongDb([]),
    { env: {}, store: { get: async () => { storeCalls += 1; } } },
  );
  assert.equal(response.status, 404);
  assert.equal(storeCalls, 0);
});
