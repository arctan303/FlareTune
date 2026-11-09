import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidMusicInitData } from './musicDataCache.js';

const validData = {
  default_playlist: {
    id: 'liked',
    name: '精选',
    songs: [{ id: 'song-1', title: 'Song', language: 'ja' }],
  },
  other_playlists: [{ id: 'playlist-1', name: 'Playlist' }],
};

test('accepts the current authenticated /api/init response shape', () => {
  assert.equal(isValidMusicInitData(validData), true);
});

test('rejects malformed init responses but accepts a fresh empty library', () => {
  assert.equal(isValidMusicInitData({ default_playlist: { songs: {} }, other_playlists: {} }), false);
  assert.equal(isValidMusicInitData({ default_playlist: { id: 'favorite', songs: [] }, other_playlists: [] }), true);
});

test('requires authoritative language metadata for every initialized song', () => {
  const missingLanguage = structuredClone(validData);
  delete missingLanguage.default_playlist.songs[0].language;
  const invalidLanguage = structuredClone(validData);
  invalidLanguage.default_playlist.songs[0].language = 'unknown-code';

  assert.equal(isValidMusicInitData(missingLanguage), false);
  assert.equal(isValidMusicInitData(invalidLanguage), false);
});

test('reopens favorites containing a trusted YT reference with unknown language', () => {
  const mixed = structuredClone(validData);
  mixed.default_playlist.songs.push({ id: 'yt:CnlMTBwsBHs', source: 'youtube',
    sourceId: 'CnlMTBwsBHs', title: 'External song', language: null });
  assert.equal(isValidMusicInitData(mixed), true);
  mixed.default_playlist.songs[1].sourceId = 'another-id';
  assert.equal(isValidMusicInitData(mixed), false);
  mixed.default_playlist.songs[1] = { id: 'yt:invalid', source: 'youtube', sourceId: 'invalid', language: null };
  assert.equal(isValidMusicInitData(mixed), false);
});
