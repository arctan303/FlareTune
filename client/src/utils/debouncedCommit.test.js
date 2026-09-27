import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncedCommit } from './debouncedCommit.js';

const createFakeTimers = () => {
  const callbacks = new Map();
  const cleared = [];
  let nextId = 1;

  return {
    callbacks,
    cleared,
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      cleared.push(id);
      callbacks.delete(id);
    },
  };
};

test('debounced commit waits for silence and only commits the latest seek', () => {
  const commits = [];
  const timers = createFakeTimers();
  const scheduler = createDebouncedCommit(
    (value) => commits.push(value),
    120,
    timers.setTimer,
    timers.clearTimer,
  );

  scheduler.schedule(10);
  scheduler.schedule(20);
  scheduler.schedule(30);

  assert.deepEqual(commits, []);
  assert.deepEqual(timers.cleared, [1, 2]);
  assert.equal(timers.callbacks.size, 1);
  const pending = timers.callbacks.values().next().value;
  assert.equal(pending.delay, 120);
  pending.callback();
  assert.deepEqual(commits, [30]);
});

test('debounced commit flushes the final seek immediately', () => {
  const commits = [];
  const timers = createFakeTimers();
  const scheduler = createDebouncedCommit(
    (value) => commits.push(value),
    120,
    timers.setTimer,
    timers.clearTimer,
  );

  scheduler.schedule(18);
  scheduler.flush();

  assert.equal(timers.callbacks.size, 0);
  assert.deepEqual(commits, [18]);
});

test('debounced commit flush without a pending seek is a no-op', () => {
  const commits = [];
  const timers = createFakeTimers();
  const scheduler = createDebouncedCommit(
    (value) => commits.push(value),
    120,
    timers.setTimer,
    timers.clearTimer,
  );

  scheduler.flush();
  assert.deepEqual(commits, []);
});

test('debounced commit cancel drops a pending seek', () => {
  const commits = [];
  const timers = createFakeTimers();
  const scheduler = createDebouncedCommit(
    (value) => commits.push(value),
    120,
    timers.setTimer,
    timers.clearTimer,
  );

  scheduler.schedule(42);
  scheduler.cancel();

  assert.equal(timers.callbacks.size, 0);
  assert.deepEqual(commits, []);
});
