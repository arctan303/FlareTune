import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repairSongLanguages,
  resolveSongs,
  songHasValidLanguage,
  songsNeedLanguageRepair,
} from './resolveSongs.js';
import { useUIStore } from './store/useUIStore.js';

test('song resolver preserves ids and hydrates trusted song data', async () => {
  useUIStore.setState((state) => ({ authSession: { ...state.authSession, csrfToken: 'resolver-csrf' } }));
  let receivedBody;
  const result = await resolveSongs(['two', 'one', 'two', 'missing'], {
    apiBase: 'https://api.example.test',
    hydrateSong: (song) => ({ ...song, audio_url: `hydrated:${song.audio_url}` }),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.example.test/api/songs/resolve');
      assert.equal(options.credentials, 'include');
      assert.equal(options.headers['X-Requested-With'], 'FlareTune');
      assert.equal(options.headers['X-CSRF-Token'], 'resolver-csrf');
      receivedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        code: 200,
        data: {
          songs: [
            { id: 'two', title: 'Two', audio_url: 'two.mp3', language: 'en' },
            { id: 'one', title: 'One', audio_url: 'one.mp3', language: 'zh' },
          ],
          missing_ids: ['missing'],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.deepEqual(receivedBody, { song_ids: ['two', 'one', 'missing'] });
  assert.deepEqual(result.songs.map((song) => song.id), ['two', 'one']);
  assert.ok(result.songs.every((song) => song.audio_url.startsWith('hydrated:')));
  assert.deepEqual(result.missingSongIds, ['missing']);
});

test('song resolver returns an empty result without requesting', async () => {
  const result = await resolveSongs([], {
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.deepEqual(result, { songs: [], missingSongIds: [] });
});

test('language repair merges authoritative metadata without changing queue order or unresolved songs', async () => {
  const source = [
    { id: 'one', title: 'Old One', audio_url: 'cached-one.mp3', language: null },
    { id: 'two', title: 'Current Two', audio_url: 'alternate-two.mp3' },
    { id: 'gone', title: 'Gone', audio_url: 'gone.mp3' },
    { id: 'valid', title: 'Valid', audio_url: 'valid.mp3', language: 'ja' },
  ];
  let requestedIds;
  const result = await repairSongLanguages(source, {
    hydrateSong: (song) => song,
    fetchImpl: async (_url, options) => {
      requestedIds = JSON.parse(options.body).song_ids;
      return new Response(JSON.stringify({
        code: 200,
        data: {
          songs: [
            { id: 'one', title: 'One', audio_url: 'one.mp3', language: 'zh' },
            { id: 'two', title: 'Two', audio_url: 'two.mp3', language: 'en' },
          ],
          missing_ids: ['gone'],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.deepEqual(requestedIds, ['one', 'two', 'gone']);
  assert.deepEqual(result.songs.map((song) => song.id), ['one', 'two', 'gone', 'valid']);
  assert.equal(result.songs[0].title, 'One');
  assert.equal(result.songs[0].language, 'zh');
  assert.equal(result.songs[1].language, 'en');
  assert.equal(result.songs[1].audio_url, 'two.mp3');
  assert.strictEqual(result.songs[2], source[2]);
  assert.strictEqual(result.songs[3], source[3]);
  assert.deepEqual(result.repairedSongIds, ['one', 'two']);
  assert.deepEqual(result.unresolvedSongIds, ['gone']);
});

test('language repair skips the network when every song already has a valid language', async () => {
  const source = [{ id: 'one', audio_url: 'one.mp3', language: 'instrumental' }];
  const result = await repairSongLanguages(source, {
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });

  assert.strictEqual(result.songs, source);
  assert.equal(songHasValidLanguage(source[0]), true);
  assert.equal(songsNeedLanguageRepair(source), false);
});

test('fillSongMetadata uses only current authenticated memory sources', async () => {
  const { fillSongMetadata } = await import('./resolveSongs.js');
  const knownSongsMap = new Map([
    ['known-song', { id: 'known-song', language: 'zh', requires_login: 1 }],
  ]);
  const healed = fillSongMetadata({ id: 'known-song', title: 'Known Song' }, { knownSongsMap });
  assert.equal(healed.language, 'zh');
  assert.equal('requires_login' in healed, false);

  const healedFromPlayer = fillSongMetadata(
    { id: 'player-song', title: 'Player Song' },
    { playerState: { currentSong: { id: 'player-song', language: 'en', requires_login: 1 } } },
  );
  assert.equal(healedFromPlayer.language, 'en');
  assert.equal('requires_login' in healedFromPlayer, false);
});
