import test from 'node:test';
import assert from 'node:assert/strict';
import { albumColumnsForWidth, albumGridLayout } from './albumGridLayout.js';

test('album overview and full list use identical card columns at the same width', () => {
  const columns = albumColumnsForWidth(884);
  assert.equal(columns, 4);
  const overview = albumGridLayout(columns, 10);
  const full = albumGridLayout(columns, 10, Infinity);
  assert.equal(overview.columns, full.columns);
  assert.equal(overview.maxWidth, full.maxWidth);
  assert.equal(overview.visibleCount, 8);
  assert.equal(full.visibleCount, 10);
});

test('album grid adds columns as space grows and keeps later cards in reading order', () => {
  assert.equal(albumColumnsForWidth(884), 4);
  assert.equal(albumColumnsForWidth(1200), 5);
  assert.equal(albumColumnsForWidth(400), 2);
  assert.equal(albumGridLayout(2, 7, Infinity).visibleCount, 7);
});
