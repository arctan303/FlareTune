import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSingleSong } from './singleSongIngest.js';

test('single song save retries metadata failure without uploading media twice', async () => {
  const audioFile = { name: 'song.mp3' };
  const coverFile = { name: 'cover.jpg' };
  const uploads = [];
  const savedSongs = [];
  let uploaded = { audio: null, cover: null };
  let failSave = true;
  const options = {
    audioFile, coverFile,
    draft: { id: 'song_1', title: 'Song', artist: 'Artist', album: '', duration: '120', language: 'en' },
    uploadMedia: async (kind, file) => { uploads.push([kind, file]); return { url: `/media/${kind}/1` }; },
    createSong: async (song) => {
      savedSongs.push(song);
      if (failSave) throw new Error('temporary failure');
    },
    onUploaded: (next) => { uploaded = next; },
    onStage: () => {},
  };
  await assert.rejects(saveSingleSong({ ...options, uploaded }), /temporary failure/);
  assert.deepEqual(uploads.map(([kind]) => kind), ['audio', 'cover']);
  failSave = false;
  await saveSingleSong({ ...options, uploaded });
  assert.equal(uploads.length, 2);
  assert.equal(savedSongs.length, 2);
  assert.deepEqual(savedSongs[1], {
    id: 'song_1', title: 'Song', artist: 'Artist', album: null,
    duration: 120, language: 'en', audio_url: '/media/audio/1', cover_url: '/media/cover/1',
  });
});

test('replacement keeps target ID and old cover while swapping audio through versioned update', async () => {
  const audioFile = { name: 'new.mp3' };
  const updates = [];
  await saveSingleSong({ audioFile, coverFile: null,
    draft: { id: 'new-id', title: 'New title', artist: 'Artist', duration: '121', language: 'en' },
    uploaded: {}, replaceTarget: { id: 'existing-id', version: 'a'.repeat(64), cover_url: '/media/cover/old.jpg' },
    uploadMedia: async () => ({ url: '/media/audio/new.mp3' }),
    createSong: async () => { throw new Error('must update, not create'); },
    updateSong: async (...args) => { updates.push(args); },
    onUploaded: () => {}, onStage: () => {},
  });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], ['existing-id', {
    title: 'New title', artist: 'Artist', album: null, duration: 121, language: 'en',
    cover_url: '/media/cover/old.jpg', audio_url: '/media/audio/new.mp3', expectedVersion: 'a'.repeat(64),
  }]);
});
