import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricDocument } from '../utils/lyricDocument.js';
import {
  LYRIC_CANDIDATE_INSPECTION_LIMITS,
  LyricCandidateInspectionError,
  inspectLyricCandidates,
} from './lyricCandidateInspection.js';

const song = { id: 'song-1', title: 'Song', artist: 'Artist', duration: 180 };

const candidate = (source, providerLyricId) => ({ source, providerLyricId });

const documentFor = (source, providerLyricId, {
  syncMode = 'word',
  translation = true,
  text = 'Hello',
} = {}) => createLyricDocument({
  source,
  format: syncMode === 'word' ? 'krc' : 'lrc',
  providerMeta: {
    providerLyricId,
    matchedTitle: 'Song',
    matchedArtist: 'Artist',
  },
  lines: syncMode === 'word'
    ? [{
        time: 0,
        endTime: 1,
        text,
        ...(translation ? { tlyric: '你好' } : {}),
        words: [{ text, startTime: 0, endTime: 1 }],
      }]
    : [{ time: 0, text, ...(translation ? { tlyric: '你好' } : {}) }],
});

const snapshotFactory = ({ idsBySource, load } = {}) => async (source) => ({
  providerLyricIds: idsBySource?.[source] || [],
  loadDocument: (providerLyricId, options) => load(source, providerLyricId, options),
});

test('inspection accepts only twelve source/id pairs and rejects bodies or duplicates', async () => {
  const createProviderSnapshot = snapshotFactory({ idsBySource: {}, load: async () => null });
  await assert.rejects(
    inspectLyricCandidates(song, Array.from({ length: 13 }, (_, index) => candidate('kugou', `id-${index}`)), {
      createProviderSnapshot,
    }),
    (error) => error instanceof LyricCandidateInspectionError && error.code === 'too_many_candidates',
  );
  await assert.rejects(
    inspectLyricCandidates(song, [{ ...candidate('kugou', 'id-1'), lyrics: 'private body' }], {
      createProviderSnapshot,
    }),
    (error) => error.code === 'invalid_candidate',
  );
  await assert.rejects(
    inspectLyricCandidates(song, [candidate('kugou', 'id-1'), candidate('kugou', 'id-1')], {
      createProviderSnapshot,
    }),
    (error) => error.code === 'duplicate_candidate',
  );
});

test('inspection searches each provider once, revalidates ids, and limits downloads to two', async () => {
  const searches = [];
  let active = 0;
  let peak = 0;
  const inputs = [
    candidate('kugou', 'kg-1'),
    candidate('lrclib', 'lr-1'),
    candidate('kugou', 'kg-2'),
    candidate('lrclib', 'forged'),
  ];
  const result = await inspectLyricCandidates(song, inputs, {
    createProviderSnapshot: async (source) => {
      searches.push(source);
      return {
        providerLyricIds: source === 'kugou' ? ['kg-1', 'kg-2'] : ['lr-1'],
        loadDocument: async (providerLyricId) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return documentFor(source, providerLyricId);
        },
      };
    },
  });

  assert.deepEqual(searches.sort(), ['kugou', 'lrclib']);
  assert.equal(peak, 2);
  assert.deepEqual(result.items.map(({ state }) => state), ['ready', 'ready', 'ready', 'error']);
  assert.equal(result.items[3].error.code, 'candidate_not_found');
});

test('safe projection separates original and static translation and strips provider metadata', async () => {
  const createProviderSnapshot = snapshotFactory({
    idsBySource: { kugou: ['kg-1'], lrclib: ['lr-1'] },
    load: async (source, providerLyricId) => documentFor(source, providerLyricId, {
      syncMode: source === 'kugou' ? 'word' : 'line',
      translation: source === 'kugou',
    }),
  });
  const result = await inspectLyricCandidates(song, [
    candidate('kugou', 'kg-1'), candidate('lrclib', 'lr-1'),
  ], { createProviderSnapshot });

  assert.equal(result.truncated, false);
  assert.deepEqual(result.items[0].translation, { lines: ['你好'] });
  assert.equal(result.items[0].lyrics.lines[0].tlyric, undefined);
  assert.equal(result.items[0].lyrics.providerMeta, undefined);
  assert.equal(JSON.stringify(result).includes('accesskey'), false);
  assert.equal(result.items[1].translation, null);
  assert.equal(result.items[1].syncMode, 'line');
  assert.deepEqual(result.items[1].warnings, ['no_word_timing']);
});

test('candidate/document identity mismatch is isolated as a safe item error', async () => {
  const result = await inspectLyricCandidates(song, [candidate('kugou', 'kg-1')], {
    createProviderSnapshot: snapshotFactory({
      idsBySource: { kugou: ['kg-1'] },
      load: async () => documentFor('kugou', 'another-id'),
    }),
  });
  assert.deepEqual(result.items[0], {
    source: 'kugou',
    providerLyricId: 'kg-1',
    state: 'error',
    error: { code: 'download_failed' },
  });
});

test('provider and candidate failures stay partial and never expose upstream messages', async () => {
  const secret = 'https://lyrics.example/download?accesskey=do-not-leak';
  const result = await inspectLyricCandidates(song, [
    candidate('kugou', 'kg-1'), candidate('lrclib', 'lr-1'), candidate('lrclib', 'lr-2'),
  ], {
    createProviderSnapshot: async (source) => {
      if (source === 'kugou') {
        const error = new Error(secret);
        error.kind = 'network';
        throw error;
      }
      return {
        providerLyricIds: ['lr-1', 'lr-2'],
        loadDocument: async (providerLyricId) => {
          if (providerLyricId === 'lr-1') throw new Error(secret);
          return documentFor('lrclib', providerLyricId, { translation: false });
        },
      };
    },
  });

  assert.deepEqual(result.items.map((item) => item.state), ['error', 'error', 'ready']);
  assert.equal(result.items[0].error.code, 'search_network');
  assert.equal(result.items[1].error.code, 'download_failed');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('single-upstream and whole-batch deadlines return safe per-item failures', async () => {
  const never = () => new Promise(() => {});
  const upstream = await inspectLyricCandidates(song, [candidate('kugou', 'kg-1')], {
    createProviderSnapshot: never,
    upstreamTimeoutMs: 10,
    batchTimeoutMs: 100,
  });
  assert.equal(upstream.items[0].error.code, 'search_timeout');

  const batch = await inspectLyricCandidates(song, [candidate('kugou', 'kg-1')], {
    createProviderSnapshot: async () => ({ providerLyricIds: ['kg-1'], loadDocument: never }),
    upstreamTimeoutMs: 100,
    batchTimeoutMs: 10,
  });
  assert.equal(batch.items[0].error.code, 'batch_timeout');
});

test('caller abort stops inspection even when an injected upstream ignores its signal', async () => {
  const controller = new AbortController();
  const pending = inspectLyricCandidates(song, [candidate('kugou', 'kg-1')], {
    createProviderSnapshot: () => new Promise(() => {}),
    signal: controller.signal,
    upstreamTimeoutMs: 1_000,
    batchTimeoutMs: 2_000,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof LyricCandidateInspectionError && error.code === 'aborted',
  );
});

test('oversized previews degrade to compact item errors below the response cap', async () => {
  const hugeText = 'A'.repeat(2_000);
  const result = await inspectLyricCandidates(song, [candidate('kugou', 'kg-1')], {
    createProviderSnapshot: snapshotFactory({
      idsBySource: { kugou: ['kg-1'] },
      load: async () => documentFor('kugou', 'kg-1', {
        text: hugeText,
        syncMode: 'line',
        translation: false,
      }),
    }),
    maxResponseBytes: 400,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].error.code, 'response_too_large');
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 400);
});

test('response budgeting accounts for the extra byte in the final false truncated flag', async () => {
  const options = {
    createProviderSnapshot: snapshotFactory({
      idsBySource: { kugou: ['kg-1'] },
      load: async () => documentFor('kugou', 'kg-1', { translation: false }),
    }),
  };
  const full = await inspectLyricCandidates(song, [candidate('kugou', 'kg-1')], options);
  const oneByteBelowFull = new TextEncoder().encode(JSON.stringify({ ...full, truncated: true })).byteLength;
  const bounded = await inspectLyricCandidates(song, [candidate('kugou', 'kg-1')], {
    ...options,
    maxResponseBytes: oneByteBelowFull,
  });

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.items[0].error.code, 'response_too_large');
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= oneByteBelowFull);
});

test('published limits preserve the Phase 73 safety budget', () => {
  assert.deepEqual(LYRIC_CANDIDATE_INSPECTION_LIMITS, {
    maxCandidates: 12,
    downloadConcurrency: 2,
    upstreamTimeoutMs: 5_000,
    batchTimeoutMs: 15_000,
    maxResponseBytes: 2 * 1024 * 1024,
  });
});

test('callers may tighten but cannot relax concurrency, timeout, or response limits', async () => {
  const inputs = [candidate('kugou', 'kg-1')];
  const createProviderSnapshot = snapshotFactory({ idsBySource: {}, load: async () => null });
  for (const options of [
    { downloadConcurrency: 3 },
    { upstreamTimeoutMs: 5_001 },
    { batchTimeoutMs: 15_001 },
    { maxResponseBytes: (2 * 1024 * 1024) + 1 },
  ]) {
    await assert.rejects(
      inspectLyricCandidates(song, inputs, { createProviderSnapshot, ...options }),
      (error) => error instanceof LyricCandidateInspectionError
        && ['invalid_concurrency', 'invalid_limit'].includes(error.code),
    );
  }
});

test('candidate projection treats translation as binary available/absent and never emits partial_translation', async () => {
  const lyricsWithUntranslatedMetadata = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    providerMeta: {
      providerLyricId: 'kg-meta',
      matchedTitle: 'Come Into My World',
      matchedArtist: 'Alexandra Stan, NERVO',
    },
    lines: [
      { time: 0, endTime: 1, text: 'Come Into My World - Alexandra Stan/NERVO', tlyric: '以下歌词翻译由文曲大模型提供', words: [{ text: 'Come Into My World', startTime: 0, endTime: 1 }] },
      { time: 1, endTime: 2, text: 'Lyrics by: Ummet Ozcan/Liv Nervo/Mim Nervo', words: [{ text: 'Lyrics', startTime: 1, endTime: 2 }] },
      { time: 2, endTime: 3, text: 'Composed by: Ummet Ozcan/Liv Nervo/Mim Nervo', words: [{ text: 'Composed', startTime: 2, endTime: 3 }] },
      { time: 3, endTime: 4, text: 'I want you to come into my world', tlyric: '我想要你走进我的世界', words: [{ text: 'I want you to come into my world', startTime: 3, endTime: 4 }] },
    ],
  });

  const result = await inspectLyricCandidates(song, [candidate('kugou', 'kg-meta')], {
    createProviderSnapshot: snapshotFactory({
      idsBySource: { kugou: ['kg-meta'] },
      load: async () => lyricsWithUntranslatedMetadata,
    }),
  });

  assert.equal(result.items[0].state, 'ready');
  assert.equal(result.items[0].translationAvailable, true);
  assert.equal(result.items[0].warnings.includes('partial_translation'), false);
  assert.deepEqual(result.items[0].warnings, []);
});

test('inspection emits version_mismatch warning when candidate document has version mismatch', async () => {
  const mismatchedDoc = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    providerMeta: {
      providerLyricId: 'kg-mismatch',
      matchedTitle: '很任性',
      matchedArtist: '千百顺',
      versionMismatch: true,
    },
    lines: [
      { time: 0, endTime: 1, text: '千百顺 - 很任性 (DJ小鱼儿版)', words: [{ text: '千百顺', startTime: 0, endTime: 1 }] },
    ],
  });

  const result = await inspectLyricCandidates(song, [candidate('kugou', 'kg-mismatch')], {
    createProviderSnapshot: snapshotFactory({
      idsBySource: { kugou: ['kg-mismatch'] },
      load: async () => mismatchedDoc,
    }),
  });

  assert.equal(result.items[0].state, 'ready');
  assert.equal(result.items[0].warnings.includes('version_mismatch'), true);
});


