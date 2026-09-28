import test from 'node:test';
import assert from 'node:assert/strict';
import { managePlaylistTool } from './managePlaylist.js';

test('manage_playlist exposes all server actions and is not a client-only tool', () => {
  assert.deepEqual(managePlaylistTool.parameters.properties.action.enum, [
    'list', 'read', 'create', 'add_songs', 'remove_songs', 'clear', 'replace_songs', 'reorder_songs', 'update_metadata', 'delete',
  ]);
  assert.equal(managePlaylistTool.clientOnly, undefined);
});
