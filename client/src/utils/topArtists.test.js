import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTopArtists } from './topArtists.js';

test('top artist full view keeps every ranked artist rather than only preview cards', () => {
  const songs = [
    { artist: 'B', title: 'one', play_count: 2, cover_url: '/b.jpg' },
    { artist: 'A', title: 'two', play_count: 4, cover_url: '/placeholder-album.svg' },
    { artist: 'B', title: 'three', play_count: 3 },
    { artist: 'A', title: 'four', play_count: 1, cover_url: '/a.jpg' },
    { artist: 'C', title: 'five', play_count: 1 },
  ];
  const artists = deriveTopArtists(songs);
  assert.deepEqual(artists.map(({ name, playCount }) => [name, playCount]),
    [['B', 5], ['A', 5], ['C', 1]]);
  assert.equal(artists[1].coverUrl, '/a.jpg');
  assert.equal(artists.length, 3);
});
