import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLyricSurfacePresentation } from './lyricSurfacePresentation.js';
import { getInterludeState } from '../../utils/interludeState.js';

const lyrics = [
  {
    time: 4,
    text: '『はい喜んで』',
    translation: '乐意效劳',
    words: [{ text: '『はい喜んで』', startTime: 4.5, endTime: 6 }],
  },
  { time: 7, text: '『あなた方のため』' },
];
const legacyIntro = { time: 0, text: 'こっちのけんと - はいよろこんで' };

for (const syncMode of ['line', 'word']) {
  test(`${syncMode} lyrics keep the real first row before and through its vocal start`, () => {
    for (const currentTime of [0, 3, 4, 4.499, 4.5, 5, 6.999]) {
      const presentation = resolveLyricSurfacePresentation({
        lyrics,
        lyricIntro: legacyIntro,
        currentLyricIndex: 0,
        currentTime,
        usePreciseIndex: syncMode === 'word',
      });
      assert.deepEqual(presentation, { kind: 'line', index: 0, line: lyrics[0] }, `time=${currentTime}`);
      assert.equal(presentation.line.translation, '乐意效劳');
    }
    assert.equal(lyrics.length, 2);
    assert.equal(lyrics[1].text, '『あなた方のため』');
  });
}

test('long prelude dots hand back directly to the real first lyric, including backward seeks', () => {
  const longPrelude = [
    { time: 12, text: lyrics[0].text, words: [{ text: lyrics[0].text, startTime: 12, endTime: 13 }] },
    { time: 14, text: lyrics[1].text },
  ];
  for (const [currentTime, dotsVisible] of [[0, true], [9.999, true], [10, false], [11.999, false], [12, false], [0, true], [10, false]]) {
    const interlude = getInterludeState({
      currentTime, lyrics: longPrelude, currentLyricIndex: 0, lineIndex: 0, syncMode: 'word',
    });
    assert.equal(interlude.isInterlude, dotsVisible, `time=${currentTime}`);
    assert.deepEqual(resolveLyricSurfacePresentation({
      lyrics: longPrelude, lyricIntro: legacyIntro, currentTime, usePreciseIndex: true,
    }), { kind: 'line', index: 0, line: longPrelude[0] });
  }
});

test('precise word presentation still advances at the next vocal start and rewinds to row zero', () => {
  for (const [currentTime, index] of [[7, 1], [8, 1], [0, 0], [4.5, 0]]) {
    assert.deepEqual(resolveLyricSurfacePresentation({
      lyrics, currentLyricIndex: 0, currentTime, usePreciseIndex: true,
    }), { kind: 'line', index, line: lyrics[index] });
  }
});

test('line-only presentation retains the low-frequency canonical index', () => {
  assert.deepEqual(resolveLyricSurfacePresentation({
    lyrics,
    currentLyricIndex: 1,
    currentTime: 4.5,
    usePreciseIndex: false,
  }), { kind: 'line', index: 1, line: lyrics[1] });
});

test('missing lyrics remain empty and unavailable clock time retains the canonical row', () => {
  assert.deepEqual(resolveLyricSurfacePresentation({ lyrics: [] }), { kind: 'none', index: -1, line: null });
  for (const currentTime of [null, undefined, NaN]) {
    assert.deepEqual(resolveLyricSurfacePresentation({
      lyrics, lyricIntro: legacyIntro, currentTime, usePreciseIndex: true,
    }), { kind: 'line', index: 0, line: lyrics[0] });
  }
});
