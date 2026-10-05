import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIC_LYRIC_SCROLL_MS, classicLyricEase } from './classicLyricMotion.js';
import { getInterludeDotProgress, INTERLUDE_CONFIG } from '../utils/interludeState.js';

test('scroll starts fast, continuously slows and reaches the target without overshoot at any refresh rate', () => {
    for (const hz of [60, 120, 144]) {
        const values = Array.from({ length: Math.ceil(CLASSIC_LYRIC_SCROLL_MS * hz / 1000) + 1 },
            (_, frame) => classicLyricEase(frame * 1000 / hz / CLASSIC_LYRIC_SCROLL_MS));
        assert.equal(values[0], 0);
        assert.equal(values.at(-1), 1);
        assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
        assert.ok(values.every((value, index) => index === 0 || value >= values[index - 1]));
        const speeds = values.slice(1).map((value, index) => value - values[index]);
        assert.ok(speeds.every((speed, index) => index === 0 || speed <= speeds[index - 1] + 1e-10));
    }
});

test('long interludes continuously fill one dot at a time and use the existing completion milestone', () => {
    const window = { start: 10, duration: 90 };
    assert.deepEqual(getInterludeDotProgress(10, window), [0, 0, 0]);
    assert.deepEqual(getInterludeDotProgress(25, window), [0.5, 0, 0]);
    assert.deepEqual(getInterludeDotProgress(40, window), [1, 0, 0]);
    assert.deepEqual(getInterludeDotProgress(55, window), [1, 0.5, 0]);
    const halfThird = 70 + (30 - INTERLUDE_CONFIG.STAGE_3_LEAD_SECONDS) / 2;
    const third = getInterludeDotProgress(halfThird, window);
    assert.deepEqual(third.slice(0, 2), [1, 1]);
    assert.ok(Math.abs(third[2] - 0.5) < 1e-10);
    assert.deepEqual(getInterludeDotProgress(99.4, window), [1, 1, 1]);
    const samples = [10, 12, 15, 20, 25, 30].map(time => getInterludeDotProgress(time, window)[0]);
    assert.ok(samples.every((fill, index) => index === 0 || fill > samples[index - 1]));
    assert.deepEqual(getInterludeDotProgress(0, window), [0, 0, 0]);
    assert.deepEqual(getInterludeDotProgress(25, window), [0.5, 0, 0], 'backward seeks derive fresh progress');
    assert.deepEqual(getInterludeDotProgress(110, window), [1, 1, 1]);
    assert.deepEqual(getInterludeDotProgress(NaN, window), [0, 0, 0]);
    assert.deepEqual(getInterludeDotProgress(10, { start: 0, duration: 0 }), [0, 0, 0]);
});
