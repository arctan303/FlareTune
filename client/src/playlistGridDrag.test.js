import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestPlaylistSlot } from './playlistGridDrag.js';

const slots = [
  { index: 0, left: 0, right: 100, top: 0, bottom: 100 },
  { index: 1, left: 120, right: 220, top: 0, bottom: 100 },
  { index: 2, left: 0, right: 100, top: 120, bottom: 220 },
  { index: 3, left: 120, right: 220, top: 120, bottom: 220 },
];

test('playlist drag resolves horizontal and vertical gaps to nearby grid slots', () => {
  assert.equal(nearestPlaylistSlot(115, 50, slots), 1);
  assert.equal(nearestPlaylistSlot(50, 115, slots), 2);
  assert.equal(nearestPlaylistSlot(115, 115, slots), 3);
  assert.equal(nearestPlaylistSlot(55, 185, slots), 2);
});

test('playlist drag ignores invalid pointer positions', () => {
  assert.equal(nearestPlaylistSlot(NaN, 50, slots), -1);
  assert.equal(nearestPlaylistSlot(50, 50, []), -1);
});
