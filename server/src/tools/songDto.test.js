import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSong } from './songDto.js';

test('normalizeSong preserves the canonical tool song DTO exactly', () => {
  assert.deepEqual(normalizeSong({
    id: 'song id/中文',
    title: '标题',
    artist: '歌手',
    album: '专辑',
    duration: '183',
    audio_url: 'audio/song.mp3',
    cover_url: 'cover/song.jpg',
    language: 'zh',
    ignored: 'not exposed',
  }), {
    id: 'song id/中文',
    title: '标题',
    artist: '歌手',
    album: '专辑',
    duration: 183,
    audio_url: 'audio/song.mp3',
    cover_url: 'cover/song.jpg',
    language: 'zh',
  });
});

test('normalizeSong keeps the existing empty-value coercions', () => {
  assert.deepEqual(normalizeSong({ id: 0 }), {
    id: '0',
    title: '',
    artist: '',
    album: '',
    duration: 0,
    audio_url: '',
    cover_url: '',
    language: null,
  });
});
