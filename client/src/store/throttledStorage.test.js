import test from 'node:test';
import assert from 'node:assert/strict';
import { createThrottledStorage } from './throttledStorage.js';

const makeStorage = () => {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); writes.push([key, value]); },
    removeItem: (key) => values.delete(key),
  };
};

test('throttled storage coalesces pending writes and skips identical values', async () => {
  const storage = makeStorage();
  const throttled = createThrottledStorage(storage, 10);
  throttled.setItem('player', 'one');
  throttled.setItem('player', 'two');
  throttled.setItem('player', 'two');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(storage.writes, [['player', 'one'], ['player', 'two']]);

  throttled.setItem('player', 'two');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(storage.writes.length, 2);
});

test('throttled storage removal cancels a pending write', async () => {
  const storage = makeStorage();
  const throttled = createThrottledStorage(storage, 20);
  throttled.setItem('player', 'one');
  throttled.setItem('player', 'two');
  throttled.removeItem('player');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(storage.values.has('player'), false);
  assert.deepEqual(storage.writes, [['player', 'one']]);
});
