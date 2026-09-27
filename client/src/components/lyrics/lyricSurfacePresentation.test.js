import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getFirstVocalStart,
  resolveLyricSurfacePresentation,
} from './lyricSurfacePresentation.js';

const lyrics = [
  {
    time: 10,
    text: 'Hello',
    words: [{ text: 'Hello', startTime: 11, endTime: 12 }],
  },
  { time: 20, text: 'World' },
];
const intro = { time: 0, text: 'Artist - Song' };

test('independent intro occupies canonical row zero without changing lyric indices', () => {
  const presentation = resolveLyricSurfacePresentation({
    lyrics,
    lyricIntro: intro,
    currentLyricIndex: 0,
    currentTime: 10.9,
    usePreciseIndex: true,
  });
  assert.deepEqual(presentation, { kind: 'intro', index: 0, line: intro });
  assert.equal(lyrics.length, 2);
  assert.equal(lyrics[0].text, 'Hello');
});

test('intro hands over at the first non-whitespace word start', () => {
  assert.equal(getFirstVocalStart(lyrics), 11);
  assert.deepEqual(resolveLyricSurfacePresentation({
    lyrics,
    lyricIntro: intro,
    currentTime: 11,
    usePreciseIndex: true,
  }), { kind: 'line', index: 0, line: lyrics[0] });
});

test('line-only presentation retains the low-frequency canonical index', () => {
  assert.deepEqual(resolveLyricSurfacePresentation({
    lyrics,
    currentLyricIndex: 1,
    currentTime: 11,
    usePreciseIndex: false,
  }), { kind: 'line', index: 1, line: lyrics[1] });
});

test('surface hook filters per-frame clock notifications down to presentation changes', () => {
  const source = readFileSync(new URL('./lyricSurfacePresentation.js', import.meta.url), 'utf8');
  assert.match(source, /if \(nextKey === lastKey\) return/);
  assert.match(source, /React\.useSyncExternalStore/);
  assert.match(source, /surfaceVisible[\s\S]*lyricSyncMode === 'word' \|\| lyricIntro/);
  assert.doesNotMatch(source, /useState|usePlayerStore/);
});
