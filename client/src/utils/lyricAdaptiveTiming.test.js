import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAdaptiveLineTiming,
  computeAdaptiveWordTiming,
  computeAdaptiveTranslationTiming,
} from './lyricAdaptiveTiming.js';

test('computeAdaptiveLineTiming handles standard pop scenario with 0.8s gaps', () => {
  const line = {
    startTime: 2.0,
    endTime: 6.0,
    words: [
      { text: '海', startTime: 2.0, endTime: 2.5 },
      { text: '阔', startTime: 2.5, endTime: 3.0 },
      { text: '天', startTime: 3.0, endTime: 4.0 },
      { text: '空', startTime: 4.0, endTime: 6.0 },
    ],
  };
  const prevLine = { startTime: 0, endTime: 1.2 }; // gap = 2.0 - 1.2 = 0.8s
  const nextLine = { startTime: 6.8, endTime: 10.0 }; // gap = 6.8 - 6.0 = 0.8s

  const timing = computeAdaptiveLineTiming({ line, prevLine, nextLine });
  assert.equal(timing.prevGap, 0.8);
  assert.equal(timing.nextGap, 0.8);
  assert.equal(timing.lineEnterMs, 280); // 0.8 * 350 = 280
  assert.equal(timing.lineDwellMs, 240); // 0.8 * 300 = 240
  assert.equal(timing.lineExitMs, 224);  // 0.8 * 280 = 224
  assert.ok(timing.avgWordDuration > 0.5);
});

test('computeAdaptiveLineTiming clamps tightly for fast rap scenario (0.15s gap)', () => {
  const line = {
    startTime: 1.0,
    endTime: 2.8,
    words: [
      { text: '快', startTime: 1.0, endTime: 1.15 },
      { text: '速', startTime: 1.15, endTime: 1.3 },
    ],
  };
  const prevLine = { startTime: 0, endTime: 0.85 }; // gap = 0.15s
  const nextLine = { startTime: 2.95, endTime: 4.0 }; // gap = 0.15s

  const timing = computeAdaptiveLineTiming({ line, prevLine, nextLine });
  assert.ok(Math.abs(timing.prevGap - 0.15) < 0.001);
  assert.ok(Math.abs(timing.nextGap - 0.15) < 0.001);
  // clamped to minimums
  assert.equal(timing.lineEnterMs, 150); // min 150
  assert.equal(timing.lineDwellMs, 100); // min 100
  assert.equal(timing.lineExitMs, 150);  // min 150
});

test('computeAdaptiveLineTiming stretches gracefully for ballad long interlude (3.2s gap)', () => {
  const line = {
    startTime: 10.0,
    endTime: 16.0,
    words: [{ text: '悠', startTime: 10.0, endTime: 16.0 }],
  };
  const prevLine = { startTime: 0, endTime: 6.8 }; // gap = 3.2s
  const nextLine = { startTime: 19.2, endTime: 25.0 }; // gap = 3.2s

  const timing = computeAdaptiveLineTiming({ line, prevLine, nextLine });
  assert.equal(timing.prevGap, 3.2);
  assert.equal(timing.nextGap, 3.2);
  // clamped to maximums
  assert.equal(timing.lineEnterMs, 440); // max 440
  assert.equal(timing.lineDwellMs, 850); // max 850
  assert.equal(timing.lineExitMs, 420);  // max 420
});

test('computeAdaptiveLineTiming uses explicit gaps when provided', () => {
  const timing = computeAdaptiveLineTiming({ prevGap: 0.5, nextGap: 1.0 });
  assert.equal(timing.prevGap, 0.5);
  assert.equal(timing.nextGap, 1.0);
  assert.equal(timing.lineEnterMs, 175);
  assert.equal(timing.lineDwellMs, 300);
  assert.equal(timing.lineExitMs, 280);
});

test('computeAdaptiveWordTiming calculates dynamic duration and lead-in correctly', () => {
  // 1. Fast word (0.12s)
  const fastWord = { text: '快', startTime: 1.0, endTime: 1.12 };
  const fastTiming = computeAdaptiveWordTiming(fastWord);
  assert.ok(Math.abs(fastTiming.wordDur - 0.12) < 0.001);
  assert.equal(fastTiming.wordAnimMs, 160); // 0.12 * 1.1 * 1000 = 132 -> clamped to 160
  assert.equal(fastTiming.wordLeadIn, 0.08); // 0.12 * 0.65 = 0.078 -> clamped to 0.08

  // 2. Medium word (0.35s)
  const medWord = { text: '中', startTime: 1.0, endTime: 1.35 };
  const medTiming = computeAdaptiveWordTiming(medWord);
  assert.ok(Math.abs(medTiming.wordDur - 0.35) < 0.001);
  assert.equal(medTiming.wordAnimMs, 385); // 0.35 * 1.1 * 1000 = 385
  assert.ok(Math.abs(medTiming.wordLeadIn - 0.2275) < 0.001);

  // 3. Long ballad word (1.2s)
  const longWord = { text: '长', startTime: 1.0, endTime: 2.2 };
  const longTiming = computeAdaptiveWordTiming(longWord);
  assert.ok(Math.abs(longTiming.wordDur - 1.2) < 0.001);
  assert.equal(longTiming.wordAnimMs, 460); // clamped to 460
  assert.equal(longTiming.wordLeadIn, 0.35); // clamped to 0.35
});

test('computeAdaptiveTranslationTiming returns bounded anim duration', () => {
  assert.equal(computeAdaptiveTranslationTiming(0.12).transAnimMs, 180);
  assert.equal(computeAdaptiveTranslationTiming(0.35).transAnimMs, 350);
  assert.equal(computeAdaptiveTranslationTiming(0.8).transAnimMs, 440);
});
