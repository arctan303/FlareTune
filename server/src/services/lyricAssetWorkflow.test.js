import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLyricArtifactMarker,
  createLyricArtifactStore,
  LyricArtifactStoreError,
} from './lyricArtifactStore.js';
import {
  buildReadyLyricArtifact,
  projectLyricArtifact,
  readOrCreateLyricArtifact,
  resolveLyricTranslationState,
  shouldAiCompleteLyrics,
} from './lyricAssetWorkflow.js';
import {
  createMemoryLyricStore,
  createMemoryR2Bucket,
  makeLyricDocument,
  makeReadyArtifact,
  makeSong,
} from '../test/lyricAssetFixtures.js';

test('ready asset strips Kugou tlyric from original and stores aligned translation once', async () => {
  const document = makeLyricDocument({
    lines: [
      { time: 1, endTime: 2, text: 'Hello', tlyric: '你好', words: [{ text: 'Hello', startTime: 1, endTime: 2 }] },
      { time: 3, endTime: 4, text: 'world', tlyric: '世界', words: [{ text: 'world', startTime: 3, endTime: 4 }] },
    ],
  });
  const result = await buildReadyLyricArtifact(makeSong(), document, {
    now: Date.parse('2026-09-10T00:00:00.000Z'),
  });
  assert.deepEqual(result.artifact.translation.lines, ['你好', '世界']);
  assert.equal(result.artifact.translation.source, 'kugou');
  assert.equal(Object.hasOwn(result.artifact.original.lines[0], 'tlyric'), false);
  assert.equal(result.artifact.provenance.matchedDuration, 255);
});

test('ready asset preserves valid translation from netease source and strips tlyric from original', async () => {
  const document = makeLyricDocument({
    source: 'netease',
    format: 'lrc',
    syncMode: 'line',
    lines: [
      { time: 1, endTime: 2, text: 'Hello', tlyric: '你好' },
      { time: 3, endTime: 4, text: 'world', tlyric: '世界' },
    ],
    providerMeta: {
      providerLyricId: 'ne-101',
      matchedTitle: 'Night Song',
      matchedArtist: 'Singer',
      matchedDuration: 255,
      durationDelta: 0,
    },
  });
  const result = await buildReadyLyricArtifact(makeSong(), document, {
    now: Date.parse('2026-09-10T00:00:00.000Z'),
  });
  assert.ok(result.artifact.translation);
  assert.equal(result.artifact.translation.source, 'netease');
  assert.deepEqual(result.artifact.translation.lines, ['你好', '世界']);
  assert.equal(Object.hasOwn(result.artifact.original.lines[0], 'tlyric'), false);
  assert.equal(result.artifact.provenance.providerLyricId, 'ne-101');
});

test('manual LRC import keeps aligned translation in the shared asset', async () => {
  const document = makeLyricDocument({
    source: 'manual', format: 'lrc', syncMode: 'line',
    lines: [{ time: 1, text: 'Hello', tlyric: '你好' }],
  });
  const result = await buildReadyLyricArtifact(makeSong(), document);
  assert.deepEqual(result.artifact.translation.lines, ['你好']);
  assert.equal(result.artifact.translation.source, 'manual');
  assert.equal(Object.hasOwn(result.artifact.original.lines[0], 'tlyric'), false);
});

test('ready asset discards derived tlyric outside the trusted Kugou KRC path', async () => {
  for (const document of [
    makeLyricDocument({
      source: 'lrclib',
      format: 'lrc',
      lines: [{ time: 1, text: 'Hello', tlyric: '你好' }],
      providerMeta: { providerLyricId: 'lr-1' },
    }),
    makeLyricDocument({
      source: 'kugou',
      format: 'lrc',
      lines: [{ time: 1, text: 'Hello', tlyric: '你好' }],
    }),
  ]) {
    const result = await buildReadyLyricArtifact(makeSong(), document, {
      now: Date.parse('2026-09-10T00:00:00.000Z'),
    });
    assert.equal(result.artifact.translation, null);
    assert.equal(Object.hasOwn(result.artifact.original.lines[0], 'tlyric'), false);
  }
});

test('foreign lyrics without provider translation remain idle until explicitly requested', async () => {
  const result = await buildReadyLyricArtifact(makeSong(), makeLyricDocument(), {
    now: Date.parse('2026-09-10T00:00:00.000Z'),
  });
  assert.equal(result.artifact.translation, null);
  assert.equal(result.artifact.aiCompletion, null);
  assert.equal(resolveLyricTranslationState(result.artifact, makeSong()), 'missing');
});

test('actual Chinese content wins over an incorrect foreign database language', async () => {
  const original = { lines: [{ time: 1, text: '我们一起唱歌' }] };
  assert.equal(shouldAiCompleteLyrics(original, makeSong({ language: 'en' })), false);
  const result = await buildReadyLyricArtifact(
    makeSong({ language: 'en' }),
    makeLyricDocument({
      lrc: '[00:01.000]我们一起唱歌',
      lines: [{ time: 1, endTime: 2, text: '我们一起唱歌' }],
    }),
  );
  assert.equal(result.artifact.aiCompletion, null);
  assert.equal(resolveLyricTranslationState(result.artifact, makeSong({ language: 'en' })), 'unavailable');
});

test('cold miss loser re-reads a different winner and does not claim AI work', async () => {
  const winner = makeReadyArtifact({
    original: {
      source: 'lrclib',
      format: 'lrc',
      syncMode: 'line',
      lines: [{ time: 1, text: 'Winner' }],
    },
    provenance: {},
  });
  let reads = 0;
  const store = {
    async get() {
      reads += 1;
      return reads < 3
        ? { state: 'missing', artifact: null, etag: null }
        : { state: 'found', artifact: winner, etag: 'winner-etag' };
    },
    singleflight(_songId, task) { return task(); },
    async createIfAbsent() { return { state: 'conflict', artifact: null, etag: null }; },
  };
  const result = await readOrCreateLyricArtifact({
    env: {},
    song: makeSong(),
    store,
    fetchDocument: async () => makeLyricDocument(),
  });
  assert.equal(result.artifact.original.lines[0].text, 'Winner');
  assert.equal(Object.hasOwn(result, 'needsAiCompletion'), false);
});

test('reset marker is a cold miss that is rebuilt with marker ETag CAS', async () => {
  const reset = buildLyricArtifactMarker('song-1', 'reset', {
    now: Date.parse('2026-09-10T00:00:00.000Z'),
  });
  const store = createMemoryLyricStore(reset);
  let providerCalls = 0;
  const result = await readOrCreateLyricArtifact({
    env: {},
    song: makeSong(),
    store,
    fetchDocument: async () => { providerCalls += 1; return makeLyricDocument(); },
  });
  assert.equal(result.artifact.status, 'ready');
  assert.equal(providerCalls, 3);
  assert.equal(store.calls.create, 0);
  assert.equal(store.calls.put, 1);
});

test('a stale not-found lyric result is searched again without deleting its marker', async () => {
  const store = createMemoryLyricStore({ schemaVersion: 1, songId: 'song-1',
    status: 'not_found', updatedAt: '2026-09-25T00:00:00.000Z' });
  const result = await readOrCreateLyricArtifact({ env: {}, song: makeSong(), store,
    now: () => Date.parse('2026-09-26T00:00:00.000Z'),
    fetchDocument: async (provider) => provider === 'lrclib' ? makeLyricDocument({
      source: 'lrclib', format: 'lrc', lines: [{ time: 1, text: 'Found later' }],
    }) : null });
  assert.equal(result.artifact.status, 'ready');
  assert.equal(result.artifact.original.lines[0].text, 'Found later');
  assert.equal(store.calls.put, 1);
  assert.equal(store.calls.create, 0);
});

test('known legacy object is rebuilt with its ETag instead of create-if-absent', async () => {
  const key = 'media/lyrics/song-1.json';
  const bucket = createMemoryR2Bucket({
    initialObjects: {
      [key]: {
        success: true,
        data: {
          source: 'Netease',
          type: 'synced',
          lyrics: '[00:01.00]Legacy lyric',
          translated_lyrics: '[00:01.00]旧译文',
        },
      },
    },
  });
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });

  const result = await readOrCreateLyricArtifact({
    env: {},
    song: makeSong(),
    store,
    fetchDocument: async () => makeLyricDocument(),
  });

  assert.equal(result.artifact.status, 'ready');
  assert.equal(bucket.calls.put.length, 1);
  assert.deepEqual(bucket.calls.put[0].options.onlyIf, { etagMatches: 'etag-0' });
  assert.equal(bucket.json(key).status, 'ready');
});

test('deleting marker wins against an already-started legacy migration', async () => {
  const key = 'media/lyrics/song-1.json';
  const bucket = createMemoryR2Bucket({
    initialObjects: {
      [key]: {
        success: false,
        data: { source: '', type: 'plain', lyrics: '', translated_lyrics: '' },
      },
    },
  });
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const deleting = buildLyricArtifactMarker('song-1', 'deleting', { operationId: 'delete-legacy-1' });

  const request = readOrCreateLyricArtifact({
    env: {},
    song: makeSong(),
    store,
    fetchDocument: async () => {
      providerStarted();
      await providerGate;
      return makeLyricDocument();
    },
  });
  await started;
  assert.equal((await store.putIfMatch('song-1', deleting, 'etag-0')).state, 'updated');
  releaseProvider();

  await assert.rejects(request, (error) => (
    error instanceof LyricArtifactStoreError && error.code === 'lyric_asset_deleting'
  ));
  assert.equal(bucket.json(key).status, 'deleting');
});

test('deleting marker is retryable and blocks provider access', async () => {
  const store = createMemoryLyricStore(buildLyricArtifactMarker('song-1', 'deleting', {
    operationId: 'delete-1',
  }));
  let providerCalls = 0;
  await assert.rejects(readOrCreateLyricArtifact({
    env: {},
    song: makeSong(),
    store,
    fetchDocument: async () => { providerCalls += 1; return makeLyricDocument(); },
  }), (error) => error instanceof LyricArtifactStoreError && error.code === 'lyric_asset_deleting');
  assert.equal(providerCalls, 0);
});

test('song deletion marker wins against an already-started cold miss', async () => {
  const store = createMemoryLyricStore();
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const request = readOrCreateLyricArtifact({
    env: {},
    song: makeSong(),
    store,
    fetchDocument: async () => {
      providerStarted();
      await providerGate;
      return makeLyricDocument();
    },
  });
  await started;
  assert.equal((await store.createIfAbsent('song-1', buildLyricArtifactMarker('song-1', 'deleting', {
    operationId: 'delete-1',
  }))).state, 'created');
  releaseProvider();
  await assert.rejects(request, (error) => (
    error instanceof LyricArtifactStoreError && error.code === 'lyric_asset_deleting'
  ));
  assert.equal(store.current().status, 'deleting');
});

test('projected lyrics apply offset while preserving translation line alignment', () => {
  const artifact = makeReadyArtifact({
    offsetMs: 500,
    translation: {
      source: 'ai',
      originalTextHash: 'a'.repeat(64),
      lines: ['你好'],
      updatedAt: '2026-09-10T00:00:00.000Z',
    },
  });
  const projected = projectLyricArtifact(artifact);
  assert.equal(projected.lines[0].time, 1.5);
  assert.equal(projected.lines[0].words[0].startTime, 1.5);
  assert.equal(projected.lines[0].tlyric, '你好');
  assert.equal(projected.tlyric, '[00:01.500]你好');
  assert.equal(projected.translationState, 'ready');
  assert.equal(projected.translationStartedAt, null);
});

test('a changed instance target language does not present the previous AI translation as the new language', () => {
  const artifact = makeReadyArtifact({ translation: {
    source: 'ai', originalTextHash: 'a'.repeat(64), lines: ['你好'],
    language: 'zh', updatedAt: '2026-09-10T00:00:00.000Z',
  } });
  const chinese = projectLyricArtifact(artifact, { song: makeSong(), targetLanguage: 'zh' });
  const english = projectLyricArtifact(artifact, { song: makeSong(), targetLanguage: 'en' });
  assert.equal(chinese.lines[0].tlyric, '你好');
  assert.equal(english.lines[0].tlyric, undefined);
  assert.equal(english.translationAvailable, false);
});

test('song-language write failure stays retryable even when the new translation is available', () => {
  const artifact = makeReadyArtifact({
    translation: { source: 'ai', originalTextHash: 'a'.repeat(64), lines: ['Hello'],
      language: 'en', updatedAt: '2026-09-10T00:00:00.000Z' },
    aiCompletion: { status: 'failed', errorCode: 'language_update_failed',
      updatedAt: '2026-09-10T00:00:00.000Z' },
  });
  const projected = projectLyricArtifact(artifact, { song: makeSong({ language: 'en' }), targetLanguage: 'en' });
  assert.equal(projected.lines[0].tlyric, 'Hello');
  assert.equal(projected.translationState, 'failed');
});

test('building an asset never starts AI completion', async () => {
  const result = await buildReadyLyricArtifact(makeSong(), makeLyricDocument());
  assert.equal(result.artifact.aiCompletion, null);
});

test('translation state is derived from lyric content before song metadata', async () => {
  const foreign = await buildReadyLyricArtifact(
    makeSong({ language: 'zh' }),
    makeLyricDocument(),
  );
  assert.equal(resolveLyricTranslationState(foreign.artifact, makeSong({ language: 'zh' })), 'missing');

  const chinese = await buildReadyLyricArtifact(
    makeSong({ language: 'en' }),
    makeLyricDocument({
      lrc: '[00:01.000]我们一起唱歌',
      lines: [{ time: 1, endTime: 2, text: '我们一起唱歌' }],
    }),
  );
  assert.equal(resolveLyricTranslationState(chinese.artifact, makeSong({ language: 'en' })), 'unavailable');
});

test('public translation state honors pending freshness and old-translation fallback', () => {
  const now = Date.parse('2026-09-10T00:00:20.000Z');
  const pending = makeReadyArtifact({
    aiCompletion: { status: 'pending', updatedAt: '2026-09-10T00:00:00.000Z' },
  });
  const projected = projectLyricArtifact(pending, { song: makeSong(), now });
  assert.equal(projected.translationState, 'pending');
  assert.equal(projected.translationStartedAt, '2026-09-10T00:00:00.000Z');
  assert.equal(Object.hasOwn(projected, 'aiCompletion'), false);
  assert.doesNotMatch(JSON.stringify(projected), /errorCode/u);

  assert.equal(resolveLyricTranslationState(pending, makeSong(), now - 21_000), 'failed');
  assert.equal(resolveLyricTranslationState(pending, makeSong(), now + 11_000), 'failed');
  const failedProjection = projectLyricArtifact(makeReadyArtifact({
    aiCompletion: {
      status: 'failed',
      errorCode: 'configuration_unavailable',
      updatedAt: '2026-09-10T00:00:20.000Z',
    },
  }), { song: makeSong(), now });
  assert.equal(failedProjection.translationState, 'failed');
  assert.equal(failedProjection.translationStartedAt, null);
  assert.doesNotMatch(JSON.stringify(failedProjection), /configuration_unavailable/u);
  const previous = {
    source: 'ai',
    originalTextHash: 'a'.repeat(64),
    lines: ['旧译文'],
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
  assert.equal(resolveLyricTranslationState(makeReadyArtifact({
    translation: previous,
    aiCompletion: { status: 'failed', errorCode: 'ai_timeout', updatedAt: '2026-09-10T00:00:20.000Z' },
  }), makeSong(), now), 'ready');
});
