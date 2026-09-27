import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getFavoriteActionSuccessMessage } from './useFavoriteSongAction.js';

const readSource = (relativePath) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

test('favorite action uses one consistent success message contract', () => {
  const song = { id: 'song-1', title: '示例歌曲' };
  assert.equal(getFavoriteActionSuccessMessage(song, { isRemoving: true }), '已从我的收藏移除《示例歌曲》');
  assert.equal(getFavoriteActionSuccessMessage(song, { outcome: 'noop' }), '《示例歌曲》已在我的收藏中');
  assert.equal(getFavoriteActionSuccessMessage(song, { refreshFailed: true }), '已加入《示例歌曲》，列表刷新失败');
  assert.equal(getFavoriteActionSuccessMessage(song), '已将《示例歌曲》加入我的收藏');
});

test('favorite writes and search playlist submission have one production boundary', () => {
  const favoriteAction = readSource('./useFavoriteSongAction.js');
  const components = [
    '../components/SearchView.jsx',
    '../components/MainContent.jsx',
    '../components/PlayerBar.jsx',
    '../components/PlayerControls.jsx',
  ].map(readSource).join('\n');
  const search = readSource('../components/SearchView.jsx');

  assert.match(favoriteAction, /accountPlaylistsStore\.getState\(\)\.removeSong/);
  assert.match(favoriteAction, /accountPlaylistsStore\.getState\(\)\.addSongs/);
  assert.doesNotMatch(components, /accountPlaylistsStore\.getState\(\)\.(?:removeSong|addSongs)/);
  assert.match(components, /useFavoriteSongAction/);
  assert.match(search, /openAddToPlaylist\(selectedSong\)/);
  assert.doesNotMatch(search, /playlistPickerOpen|selectedTargetIds|addSelectionToPlaylists/);
});
