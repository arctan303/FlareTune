import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent } from '../../test/lyricCandidateHarness.js';
import { createLyricPlaybackClock } from '../../services/lyricPlaybackClock.js';
import * as timeline from '../../utils/lyricTimeline.js';
import * as adaptive from '../../utils/lyricAdaptiveTiming.js';

test('real word renderer acquires RAF only while active, visible and text-matched, then releases it', () => {
  let nextId = 0;
  const frames = new Map();
  const timers = new Map();
  const motionListeners = new Set();
  const mediaQuery = { matches: false,
    addEventListener: (_type, listener) => motionListeners.add(listener),
    removeEventListener: (_type, listener) => motionListeners.delete(listener),
  };
  const clock = createLyricPlaybackClock({ document: null,
    raf: (callback) => { const id = ++nextId; frames.set(id, callback); return id; },
    caf: (id) => frames.delete(id),
    setTimeout: (callback) => { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const audio = { currentTime: 0.5, duration: 10, paused: false, playbackRate: 1,
    addEventListener() {}, removeEventListener() {} };
  clock.attach(audio);
  const harness = hookComponent({ file: fileURLToPath(new URL('./SyncedLyricText.jsx', import.meta.url)),
    modules: {
      '../../services/lyricPlaybackClock.js': { lyricPlaybackClock: clock },
      '../../utils/lyricTimeline.js': timeline,
      '../../utils/lyricAdaptiveTiming.js': adaptive,
      './synced-lyric-text.css': {},
    },
    globals: { window: { matchMedia: () => mediaQuery, addEventListener() {}, removeEventListener() {} } },
  });
  const props = { line: { time: 0, text: 'AB', words: [
    { text: 'A', startTime: 0, endTime: 1 }, { text: 'B', startTime: 1, endTime: 2 },
  ] }, syncMode: 'word', visible: true, active: false };
  harness.render(props);
  assert.equal(frames.size, 0);
  harness.render({ ...props, active: true });
  assert.equal(frames.size, 1);
  harness.render({ ...props, active: true, visible: false });
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  harness.render({ ...props, active: true, text: 'Different' });
  assert.equal(frames.size, 0);
  harness.render({ ...props, active: true });
  assert.equal(frames.size, 1);
  audio.paused = true;
  clock.sample('pause');
  assert.equal(frames.size, 0);
  audio.paused = false;
  clock.sample('play');
  assert.equal(frames.size, 1);
  for (const listener of motionListeners) listener({ matches: true });
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 1);
  for (const listener of motionListeners) listener({ matches: false });
  assert.equal(frames.size, 1);
  audio.currentTime = 2;
  clock.sample('boundary');
  assert.equal(frames.size, 0, 'a completed visible row must not retain per-frame work through the interlude');
  audio.currentTime = 0;
  harness.render({ ...props, active: true, line: { ...props.line, words: [
    { text: 'A', startTime: 4, endTime: 5 }, { text: 'B', startTime: 5, endTime: 6 },
  ] } });
  assert.equal(frames.size, 0, 'pre-vocal static text waits for its exact boundary');
  audio.currentTime = 4;
  clock.sample('boundary');
  assert.equal(frames.size, 1);
  harness.unmount();
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
});
