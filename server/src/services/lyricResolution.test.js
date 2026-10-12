import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricDocument } from '../utils/lyricDocument.js';
import {
  applyLyricOffset,
  listLyricsResolutionCandidates,
  mergeLyricsResolutionCandidates,
} from './lyricResolution.js';
import { LyricSourceError } from './lyricSourceLoader.js';

const wordDocument = () => createLyricDocument({
  source: 'custom_krc',
  format: 'krc',
  providerMeta: { providerLyricId: 'one', matchedTitle: 'Song', matchedArtist: 'Artist', durationDelta: 0.2 },
  lines: [{
    time: 0.1,
    endTime: 1,
    text: 'Hello',
    tlyric: '你好',
    words: [
      { text: 'Hel', startTime: 0.1, endTime: 0.5 },
      { text: 'lo', startTime: 0.5, endTime: 1 },
    ],
  }],
});

test('offset clamps a negative axis without losing word timing or translation', () => {
  const shifted = applyLyricOffset(wordDocument(), -500);
  assert.equal(shifted.syncMode, 'word');
  assert.deepEqual(shifted.lines[0], {
    time: 0,
    endTime: 0.5,
    text: 'Hello',
    tlyric: '你好',
    words: [
      { text: 'Hel', startTime: 0, endTime: 0 },
      { text: 'lo', startTime: 0, endTime: 0.5 },
    ],
  });
  assert.equal(shifted.lrc, '[00:00.000]Hello');
});

test('offset validation remains bounded to the supported calibration range', () => {
  for (const invalid of [-5001, 5001, 0.5, Number.NaN]) {
    assert.throws(() => applyLyricOffset(wordDocument(), invalid), RangeError);
  }
});

test('candidate discovery returns configured providers and isolates a provider failure', async () => {
  const song = { id: 'song-1', title: 'Song', artist: 'Artist' };
  const result = await listLyricsResolutionCandidates(song, {
    listCandidates: async (source) => {
      if (source === 'lrclib') throw new LyricSourceError('unavailable', source, 'search', 'down');
      return [{ source, providerLyricId: 'candidate' }];
    },
  });
  assert.deepEqual(result.candidates, [
    { source: 'custom_krc', providerLyricId: 'candidate' },
    { source: 'custom_lrc', providerLyricId: 'candidate' },
  ]);
  assert.deepEqual(result.warnings, [{ source: 'lrclib', code: 'unavailable' }]);
});

test('candidate discovery globally ranks providers and retains every summary', async () => {
  const song = { id: 'song-1', title: 'Song', artist: 'Artist' };
  const calls = [];
  const custom_krcCandidates = Array.from({ length: 13 }, (_, index) => ({
    source: 'custom_krc',
    providerLyricId: `kg-${String(index).padStart(2, '0')}`,
    score: 120 - index,
    durationDelta: index + 1,
  }));
  const result = await listLyricsResolutionCandidates(song, {
    listCandidates: async (source) => {
      calls.push(source);
      return source === 'custom_krc'
        ? custom_krcCandidates
        : [{ source, providerLyricId: `${source}-best`, score: 175, durationDelta: 0.1 }];
    },
  });

  assert.deepEqual(calls, ['custom_krc', 'custom_lrc', 'lrclib']);
  assert.equal(result.candidates[0].providerLyricId, 'custom_lrc-best');
  assert.equal(result.candidates.length, 15);
  assert.equal(result.candidates.some(({ providerLyricId }) => providerLyricId === 'kg-12'), true);
});

test('source filter only queries the selected provider and rejects unsupported sources', async () => {
  const calls = [];
  const listCandidates = async source => { calls.push(source); return [{ source, providerLyricId: 'one' }]; };
  const result = await listLyricsResolutionCandidates({}, { source: 'custom_lrc', listCandidates });
  assert.deepEqual(calls, ['custom_lrc']);
  assert.equal(result.candidates[0].source, 'custom_lrc');
  await assert.rejects(listLyricsResolutionCandidates({}, { source: 'unknown', listCandidates }), RangeError);
  assert.deepEqual(calls, ['custom_lrc']);
});

test('candidate merge deduplicates provider identities and has deterministic cross-provider ties', () => {
  const duplicatedCustomKrc = {
    source: 'custom_krc', providerLyricId: 'shared-id', score: 150, durationDelta: 0.2,
  };
  const candidates = [
    [
      { source: 'custom_krc', providerLyricId: 'z-last', score: 150, durationDelta: null },
      duplicatedCustomKrc,
      { ...duplicatedCustomKrc, score: 140, durationDelta: 0.1 },
    ],
    [
      { source: 'lrclib', providerLyricId: 'shared-id', score: 150, durationDelta: 0.2 },
      { source: 'lrclib', providerLyricId: 'a-first', score: 150, durationDelta: 0.2 },
    ],
  ];

  const expected = [
    'custom_krc:shared-id',
    'lrclib:a-first',
    'lrclib:shared-id',
    'custom_krc:z-last',
  ];
  const identities = (value) => value.map(({ source, providerLyricId }) => `${source}:${providerLyricId}`);

  assert.deepEqual(identities(mergeLyricsResolutionCandidates(candidates)), expected);
  assert.deepEqual(identities(mergeLyricsResolutionCandidates([
    [...candidates[1]].reverse(),
    [...candidates[0]].reverse(),
  ])), expected);
});
