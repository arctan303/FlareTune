import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuickSongPatch } from './quickSongEditPatch.js';

test('quick song edit sends only changed metadata and optional cover', () => {
  const song = { id: 'track-1', title: 'Old', artist: 'Artist', album: 'Album', language: 'zh', audio_url: 'audio-original', cover_url: 'cover-original' };
  assert.deepEqual(createQuickSongPatch(song, { title: ' New ', artist: 'Artist', album: '', language: 'zh' }), {
    title: 'New', album: null,
  });
  assert.deepEqual(createQuickSongPatch(song, { title: 'Old', artist: 'Artist', album: 'Album', language: 'zh' }, 'cover-new'), {
    cover_url: 'cover-new',
  });
});
