import test from 'node:test';
import assert from 'node:assert/strict';
import { clampTimelineShift, projectTimelineShift, stepTimelineShift, timelineShiftAtY } from './lyricTimelineShift.js';

test('vertical adjustment maps upward to earlier and downward to later in 50 ms steps', () => {
  assert.equal(stepTimelineShift(0, -1), -50);
  assert.equal(stepTimelineShift(0, 1), 50);
  assert.equal(timelineShiftAtY(0, 0, 100), -5000);
  assert.equal(timelineShiftAtY(50, 0, 100), 0);
  assert.equal(timelineShiftAtY(100, 0, 100), 5000);
  assert.equal(clampTimelineShift(6000), 5000);
});

test('preview shifts line and word times together without changing the saved document', () => {
  const original = [{ time: 1, endTime: 1.6, text: 'hello', words: [
    { startTime: 1, endTime: 1.2, text: 'he' },
    { startTime: 1.2, endTime: 1.6, text: 'llo' },
  ] }];
  const shifted = projectTimelineShift(original, -50);
  assert.equal(shifted[0].time, 0.95);
  assert.equal(shifted[0].words[1].startTime, 1.15);
  assert.equal(shifted[0].endTime, 1.55);
  assert.equal(original[0].time, 1);
  assert.equal(original[0].words[1].startTime, 1.2);
  assert.equal(projectTimelineShift([{ time: 0.02, text: 'start' }], -50)[0].time, 0);
});
