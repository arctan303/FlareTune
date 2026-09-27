import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { activateInlineAssistantSong, playAssistantInlineSong } from './assistantInlinePlayback.js';

const song = { id: 'song-1', title: '星河', audio_url: '/media/audio/song-1.mp3', language: 'zh' };
const fixture = (overrides = {}) => {
  const calls = [];
  const deps = {
    fetchSong: async (id) => { calls.push(['fetch', id]); return song; },
    repairSongs: async (songs) => { calls.push(['repair', songs[0].id]); return { songs }; },
    hydrateSong: (value) => value,
    validLanguage: () => true,
    getState: () => ({ currentSong: null, isPlaying: false }),
    playSong: async (value) => { calls.push(['play', value.id]); return { ok: true }; },
    apiBase: () => 'https://tune.example',
    notify: (message) => calls.push(['toast', message]),
    ...overrides,
  };
  return { calls, deps };
};

test('assistant inline song plays only after an explicit call, via authenticated song fetch', async () => {
  const { calls, deps } = fixture();
  assert.deepEqual(calls, []);
  assert.deepEqual(await playAssistantInlineSong('song-1', deps), { ok: true, outcome: 'started' });
  assert.deepEqual(calls.slice(0, 3), [['fetch', 'song-1'], ['repair', 'song-1'], ['play', 'song-1']]);
  assert.match(calls.at(-1)[1], /正在播放《星河》/);
});

test('current inline song resumes without refetch; an already-playing song is left alone', async () => {
  let toggles = 0;
  const paused = fixture({ getState: () => ({ currentSong: song, isPlaying: false,
    togglePlay: () => { toggles += 1; } }) });
  assert.deepEqual(await playAssistantInlineSong('song-1', paused.deps), { ok: true, outcome: 'resumed' });
  assert.equal(toggles, 1);
  assert.deepEqual(paused.calls, []);
  const playing = fixture({ getState: () => ({ currentSong: song, isPlaying: true,
    togglePlay: () => { toggles += 1; } }) });
  assert.deepEqual(await playAssistantInlineSong('song-1', playing.deps), { ok: true, outcome: 'already_playing' });
  assert.equal(toggles, 1);
  assert.deepEqual(playing.calls, []);
});

test('invalid, absent, unplayable and failed songs never issue a play action', async () => {
  const invalid = fixture();
  assert.equal((await playAssistantInlineSong('', invalid.deps)).reason, 'invalid_song_id');
  assert.deepEqual(invalid.calls, []);
  for (const [overrides, reason] of [
    [{ fetchSong: async () => null }, 'song_not_found'],
    [{ validLanguage: () => false }, 'song_unplayable'],
    [{ playSong: async () => ({ ok: false }) }, 'playback_failed'],
    [{ fetchSong: async () => { throw new Error('network'); } }, 'song_unavailable'],
  ]) {
    const { calls, deps } = fixture(overrides);
    assert.equal((await playAssistantInlineSong('song-1', deps)).reason, reason);
    assert.equal(calls.some(([kind]) => kind === 'play'), false);
  }
});

test('markdown click and keyboard paths call the same explicit playback helper without a global event', () => {
  const source = readFileSync(new URL('../components/AssistantMarkdown.jsx', import.meta.url), 'utf8');
  assert.match(source, /onClick=\{handleClick\}/);
  assert.match(source, /onKeyDown=\{handleKeyDown\}/);
  assert.match(source, /activateInlineAssistantSong\(e\)/);
  assert.match(source, /activateInlineAssistantSong\(e, \{ keyboard: true \}\)/);
  assert.doesNotMatch(source, /music-play-song-id|dispatchEvent/);

  const actions = [];
  const event = (key) => ({
    key,
    target: { closest: (selector) => selector === '.xiaoa-inline-song'
      ? { getAttribute: () => 'song-1' } : null },
    preventDefault: () => actions.push('prevent'),
    stopPropagation: () => actions.push('stop'),
  });
  const playSong = (id) => actions.push(id);
  assert.equal(activateInlineAssistantSong(event(), { playSong }), true);
  assert.equal(activateInlineAssistantSong(event('Enter'), { keyboard: true, playSong }), true);
  assert.equal(activateInlineAssistantSong(event(' '), { keyboard: true, playSong }), true);
  assert.equal(activateInlineAssistantSong(event('Escape'), { keyboard: true, playSong }), false);
  assert.deepEqual(actions, [
    'prevent', 'stop', 'song-1',
    'prevent', 'stop', 'song-1',
    'prevent', 'stop', 'song-1',
  ]);
});
