import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SEARCH_BULK_SELECTION,
  resolveSelectedSearchSongs,
  toggleSearchBulkSelection,
} from './searchBulkSelection.js';

test('search bulk selection selects and deselects multiple song ids in selection order', () => {
  let selectedIds = [];
  selectedIds = toggleSearchBulkSelection(selectedIds, 2).selectedIds;
  selectedIds = toggleSearchBulkSelection(selectedIds, '1').selectedIds;
  assert.deepEqual(selectedIds, ['2', '1']);

  const songs = [{ id: 1, title: 'one' }, { id: 2, title: 'two' }];
  assert.deepEqual(resolveSelectedSearchSongs(songs, selectedIds), [songs[1], songs[0]]);

  selectedIds = toggleSearchBulkSelection(selectedIds, 2).selectedIds;
  assert.deepEqual(selectedIds, ['1']);
});

test('search bulk selection keeps the established 100 song limit', () => {
  const selectedIds = Array.from({ length: MAX_SEARCH_BULK_SELECTION }, (_, index) => String(index));
  const result = toggleSearchBulkSelection(selectedIds, 'overflow');
  assert.equal(result.limitReached, true);
  assert.equal(result.selectedIds, selectedIds);
  assert.equal(result.selectedIds.length, MAX_SEARCH_BULK_SELECTION);
});

test('selected search songs omit results no longer present', () => {
  const songs = [{ id: 'current', title: 'current' }];
  assert.deepEqual(resolveSelectedSearchSongs(songs, ['stale', 'current']), [songs[0]]);
});
