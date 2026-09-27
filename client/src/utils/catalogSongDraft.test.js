import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogSongBody } from './catalogSongDraft.js';

const draft = {
  id: 'song_123', title: ' Song ', artist: ' Artist ', album: '', duration: 203,
  language: 'en', audio_url: '/media/audio/original.mp3', cover_url: '/media/cover/new.webp',
};

test('editing a catalog song only submits metadata and cover', () => {
  assert.deepEqual(catalogSongBody(draft, false), {
    title: 'Song', artist: 'Artist', album: null, duration: 203,
    language: 'en', cover_url: '/media/cover/new.webp',
  });
});

test('creating a catalog song includes generated identity and uploaded audio', () => {
  assert.deepEqual(catalogSongBody(draft, true), {
    id: 'song_123', title: 'Song', artist: 'Artist', album: null, duration: 203,
    language: 'en', audio_url: '/media/audio/original.mp3', cover_url: '/media/cover/new.webp',
  });
});
