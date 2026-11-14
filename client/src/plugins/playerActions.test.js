import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchScopedPlayerAction } from './playerActions.js';

function fixture() {
  let current = true, listener, resolvePlay, paused = 0;
  const notices = [], state = { currentSong: null, playlist: [], isPlaying: false,
    setShouldAutoPlay() {}, setProgress() {}, setIsPlaying(value) { state.isPlaying = value; },
    playSong(song, queue) { state.currentSong = song; state.playlist = queue; audio.src = song.audio_url; return true; } };
  const audio = { src: '', currentTime: 0, duration: 200, pause() { paused++; },
    play: () => new Promise(resolve => { resolvePlay = resolve; }) };
  state.audioRef = { current: audio };
  const options = { playerStore: { getState: () => state }, isCurrent: () => current,
    subscribe(fn) { listener = fn; return () => { listener = null; }; }, notify: notice => notices.push(notice) };
  return { options, state, audio, notices, resolve: () => resolvePlay(), get paused() { return paused; },
    retire() { current = false; listener?.(); } };
}
const song = { id: 'one', title: 'Fixture', audio_url: 'https://fixture.test/one.mp3' };
const action = { type: 'play_now', action: 'play_song', song };
test('scoped player actions retain a stable audio identity and normal accepted playback', async () => {
  const f = fixture(), pending = dispatchScopedPlayerAction(action, f.options);
  await new Promise(resolve => setImmediate(resolve)); f.resolve();
  assert.equal((await pending).ok, true); assert.equal(f.state.isPlaying, true); assert.equal(f.notices.length, 0);
});
test('retired pending native play cannot resume sound or publish a success', async () => {
  const f = fixture(), pending = dispatchScopedPlayerAction(action, f.options);
  await new Promise(resolve => setImmediate(resolve)); f.retire(); f.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(f.paused > 0); assert.equal(f.state.isPlaying, false); assert.equal(f.notices.length, 0);
  assert.equal(f.state.playlist.length, 1);
});
test('retiring an old player intent never pauses a replacement song', async () => {
  const f = fixture(), pending = dispatchScopedPlayerAction(action, f.options);
  await new Promise(resolve => setImmediate(resolve));
  f.state.currentSong = { id: 'new' }; f.audio.src = 'https://fixture.test/new.mp3'; f.state.isPlaying = true;
  f.retire(); f.resolve(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.paused, 0); assert.equal(f.state.isPlaying, true);
});
