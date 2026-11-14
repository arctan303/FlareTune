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


test('local artist aggregation is unchanged while a same-name YouTube artist retains its own identity', () => {
  const artists=deriveTopArtists([
    {id:'local-a',artist:'Same',play_count:2},
    {id:'local-b',artist:'Same',play_count:3},
    {id:'yt:QBtVFL0Qefs',source:'youtube',artist:'Same',play_count:4,artists:[{id:'yt:artist:UCtest',name:'Same'}]},
    {id:'yt:4D7u5KF7SP8',source:'youtube',artist:'Same',play_count:2,artists:[{id:'yt:artist:UCtest',name:'Same'}]},
  ]);
  assert.equal(artists.length,2);
  assert.equal(artists[0].id,'yt:artist:UCtest');assert.equal(artists[0].source,'youtube');
  assert.equal(artists[0].playCount,6);assert.equal(artists[0].songs.length,2);
  assert.equal(artists[1].name,'Same');assert.equal(artists[1].playCount,5);assert.equal(artists[1].songs.length,2);
});


test('source identity cannot collide with a local artist display name', () => {
  const result=deriveTopArtists([
    {id:'local',artist:'yt:artist:UCtest',play_count:1},
    {id:'yt:QBtVFL0Qefs',source:'youtube',artist:'A',artists:[{id:'yt:artist:UCtest',name:'A'}],play_count:1},
  ]);
  assert.equal(result.length,2);
});
