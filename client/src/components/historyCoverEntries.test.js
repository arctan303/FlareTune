import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileHistoryCoverEntries } from './historyCoverEntries.js';

const song = (id) => ({ id, cover_url: `/covers/${id}.jpg` });

test('replaying the second cover keeps both images ready after A → B → A', () => {
  const a = song('a');
  const b = song('b');
  const c = song('c');
  const first = reconcileHistoryCoverEntries([a, b, c]);

  const bArrival = { key: 'arrival-1', song: b, ready: true };
  const afterB = reconcileHistoryCoverEntries([b, a, c], first, bArrival);
  assert.deepEqual(afterB.map((entry) => entry.key), ['arrival-1', 'song-a', 'song-c']);
  assert.equal(afterB[0].ready, true);

  const aArrival = { key: 'arrival-2', song: a, ready: true };
  const afterA = reconcileHistoryCoverEntries([a, b, c], afterB, aArrival);
  assert.deepEqual(afterA.map((entry) => entry.key), ['arrival-2', 'arrival-1', 'song-c']);
  assert.equal(afterA[1].ready, true);
  assert.equal(new Set(afterA.map((entry) => entry.key)).size, 3);
});
