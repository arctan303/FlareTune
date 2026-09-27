import assert from 'node:assert/strict';
import test from 'node:test';
import { createInsertNextWithFeedback } from './playerActionsCore.js';

test('insert-next action inserts once, reports the current playback state and emits bounce', () => {
  const notifications = [];
  let bounceCount = 0;
  const calls = [];
  const action = createInsertNextWithFeedback({
    getPlayerState: () => ({
      currentSong: { id: 'current' },
      insertAndPlay: (...args) => {
        calls.push(args);
        return true;
      },
    }),
    notify: (message) => notifications.push(message),
    emitBounce: () => { bounceCount += 1; },
  });

  assert.equal(action({ id: 'next', title: '下一首' }), true);
  assert.deepEqual(calls, [[{ id: 'next', title: '下一首' }, null]]);
  assert.deepEqual(notifications, ['已将《下一首》插播为下一首']);
  assert.equal(bounceCount, 1);
});

test('insert-next action starts idle playback and emits no feedback when insertion fails', () => {
  const notifications = [];
  let bounceCount = 0;
  let succeeds = true;
  const action = createInsertNextWithFeedback({
    getPlayerState: () => ({
      currentSong: null,
      insertAndPlay: () => succeeds,
    }),
    notify: (message) => notifications.push(message),
    emitBounce: () => { bounceCount += 1; },
  });

  assert.equal(action({ id: 'first', title: '第一首' }), true);
  assert.deepEqual(notifications, ['已开始播放《第一首》']);
  assert.equal(bounceCount, 1);

  succeeds = false;
  assert.equal(action({ id: 'failed', title: '失败歌曲' }), false);
  assert.equal(notifications.length, 1);
  assert.equal(bounceCount, 1);
});
