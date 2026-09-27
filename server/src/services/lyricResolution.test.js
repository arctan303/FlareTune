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
  source: 'kugou',
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
    { source: 'kugou', providerLyricId: 'candidate' },
    { source: 'netease', providerLyricId: 'candidate' },
  ]);
  assert.deepEqual(result.warnings, [{ source: 'lrclib', code: 'unavailable' }]);
});

test('candidate discovery globally ranks providers before the workspace takes its first 12', async () => {
  const song = { id: 'song-1', title: 'Song', artist: 'Artist' };
  const calls = [];
  const kugouCandidates = Array.from({ length: 13 }, (_, index) => ({
    source: 'kugou',
    providerLyricId: `kg-${String(index).padStart(2, '0')}`,
    score: 120 - index,
    durationDelta: index + 1,
  }));
  const result = await listLyricsResolutionCandidates(song, {
    listCandidates: async (source) => {
      calls.push(source);
      return source === 'kugou'
        ? kugouCandidates
        : [{ source, providerLyricId: `${source}-best`, score: 175, durationDelta: 0.1 }];
    },
  });

  assert.deepEqual(calls, ['kugou', 'netease', 'lrclib']);
  assert.equal(result.candidates[0].providerLyricId, 'netease-best');
  assert.equal(result.candidates.slice(0, 12).some(({ providerLyricId }) => providerLyricId === 'netease-best'), true);
  assert.equal(result.candidates.slice(0, 12).some(({ providerLyricId }) => providerLyricId === 'kg-11'), false);
});

test('candidate merge deduplicates provider identities and has deterministic cross-provider ties', () => {
  const duplicatedKugou = {
    source: 'kugou', providerLyricId: 'shared-id', score: 150, durationDelta: 0.2,
  };
  const candidates = [
    [
      { source: 'kugou', providerLyricId: 'z-last', score: 150, durationDelta: null },
      duplicatedKugou,
      { ...duplicatedKugou, score: 140, durationDelta: 0.1 },
    ],
    [
      { source: 'lrclib', providerLyricId: 'shared-id', score: 150, durationDelta: 0.2 },
      { source: 'lrclib', providerLyricId: 'a-first', score: 150, durationDelta: 0.2 },
    ],
  ];

  const expected = [
    'kugou:shared-id',
    'lrclib:a-first',
    'lrclib:shared-id',
    'kugou:z-last',
  ];
  const identities = (value) => value.map(({ source, providerLyricId }) => `${source}:${providerLyricId}`);

  assert.deepEqual(identities(mergeLyricsResolutionCandidates(candidates)), expected);
  assert.deepEqual(identities(mergeLyricsResolutionCandidates([
    [...candidates[1]].reverse(),
    [...candidates[0]].reverse(),
  ])), expected);
});
