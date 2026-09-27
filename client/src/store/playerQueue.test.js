import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planInsertNext,
  planQueueEdit,
  reorderQueue,
  sanitizePlayableQueue,
} from './playerQueue.js';

const song = id => ({
  id,
  title: id,
  artist: 'Artist',
  audio_url: `https://media.test/${id}.mp3`,
});

test('planInsertNext queues after current song without changing the active identity', () => {
  const current = song('current');
  const target = song('target');
  const later = song('later');

  const result = planInsertNext([current, later], current, target);

  assert.equal(result.action, 'queue');
  assert.deepEqual(result.playlist.map(item => item.id), ['current', 'target', 'later']);
});

test('planInsertNext refuses to duplicate the current song', () => {
  const current = song('current');
  const later = song('later');

  const result = planInsertNext([current, later], current, current);

  assert.equal(result.action, 'noop');
  assert.deepEqual(result.playlist.map(item => item.id), ['current', 'later']);
});

test('planInsertNext starts a playable target and preserves the remaining queue when idle', () => {
  const target = song('target');
  const later = song('later');

  const result = planInsertNext([later], null, target);

  assert.equal(result.action, 'play');
  assert.deepEqual(result.playlist.map(item => item.id), ['target', 'later']);
});

test('planInsertNext rejects incomplete song objects and removes existing ghosts', () => {
  const current = song('current');
  const ghost = { id: 'ghost', title: 'Ghost' };

  const result = planInsertNext([current, ghost], current, ghost);

  assert.equal(result.action, 'reject');
  assert.deepEqual(result.playlist.map(item => item.id), ['current']);
});

test('sanitizePlayableQueue removes ghosts and duplicate ids while keeping order', () => {
  const first = song('first');
  const second = song('second');
  const duplicate = { ...first, title: 'duplicate' };

  const result = sanitizePlayableQueue([first, { id: 'ghost' }, second, duplicate]);

  assert.deepEqual(result.map(item => item.id), ['first', 'second']);
  assert.equal(result[0].title, 'first');
});

test('planInsertNext follows the current song at queue start, middle, and end', () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  const x = song('x');

  assert.deepEqual(planInsertNext([a, b, c], a, x).playlist.map(item => item.id), ['a', 'x', 'b', 'c']);
  assert.deepEqual(planInsertNext([a, b, c], b, x).playlist.map(item => item.id), ['a', 'b', 'x', 'c']);
  assert.deepEqual(planInsertNext([a, b, c], c, x).playlist.map(item => item.id), ['a', 'b', 'c', 'x']);
});

test('planInsertNext moves an existing target correctly from either side of current', () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  const d = song('d');

  assert.deepEqual(planInsertNext([a, b, c, d], c, a).playlist.map(item => item.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(planInsertNext([a, b, c, d], b, d).playlist.map(item => item.id), ['a', 'b', 'd', 'c']);
});

test('planQueueEdit inserts a batch after the current song without duplicates', () => {
  const current = song('a');
  const b = song('b');
  const c = song('c');
  const x = song('x');

  const result = planQueueEdit([current, b, x, c], current, [x, b], 'insert_next');

  assert.equal(result.action, 'update');
  assert.deepEqual(result.playlist.map((item) => item.id), ['a', 'x', 'b', 'c']);
  assert.deepEqual(result.affectedSongIds, ['x', 'b']);
});

test('planQueueEdit appends a batch and treats an identical result as noop', () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  assert.deepEqual(
    planQueueEdit([a, b], a, [c], 'append').playlist.map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.equal(planQueueEdit([a, b, c], a, [b, c], 'append').action, 'noop');
});

test('planQueueEdit reports only targets that were actually added or moved', () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  const x = song('x');
  const result = planQueueEdit([a, b, c], a, [c, x], 'append');
  assert.deepEqual(result.playlist.map((item) => item.id), ['a', 'b', 'c', 'x']);
  assert.deepEqual(result.affectedSongIds, ['x']);
});

test('reorderQueue moves items within bounds and handles invalid indices safely', () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  const d = song('d');
  const queue = [a, b, c, d];

  // 正常移动：从前向后 (0 -> 2) => b, c, a, d
  assert.deepEqual(
    reorderQueue(queue, 0, 2).map((s) => s.id),
    ['b', 'c', 'a', 'd']
  );

  // 正常移动：从后向前 (3 -> 1) => a, d, b, c
  assert.deepEqual(
    reorderQueue(queue, 3, 1).map((s) => s.id),
    ['a', 'd', 'b', 'c']
  );

  // 原地移动 => 返回不变
  assert.deepEqual(
    reorderQueue(queue, 2, 2).map((s) => s.id),
    ['a', 'b', 'c', 'd']
  );

  // 越界 targetIndex 自动 clamp
  assert.deepEqual(
    reorderQueue(queue, 0, 99).map((s) => s.id),
    ['b', 'c', 'd', 'a']
  );
  assert.deepEqual(
    reorderQueue(queue, 3, -10).map((s) => s.id),
    ['d', 'a', 'b', 'c']
  );

  // 非法 fromIndex 保持不变
  assert.deepEqual(
    reorderQueue(queue, -1, 2).map((s) => s.id),
    ['a', 'b', 'c', 'd']
  );
  assert.deepEqual(
    reorderQueue(queue, 10, 2).map((s) => s.id),
    ['a', 'b', 'c', 'd']
  );
  assert.deepEqual(
    reorderQueue(queue, '0', 2).map((s) => s.id),
    ['a', 'b', 'c', 'd']
  );

  // 空队列与单元素
  assert.deepEqual(reorderQueue([], 0, 1), []);
  assert.deepEqual(reorderQueue([a], 0, 0).map((s) => s.id), ['a']);
});
