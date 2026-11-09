import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePlaybackCleanup } from './playbackCleanup.js';

function fixture() {
  let pauses = 0, cancellations = 0;
  const audio = { src: 'https://media.test/one.mp3', paused: false, pause() { pauses++; this.paused = true; } };
  const state = { audioRef: { current: audio }, currentSong: { id: 'one' }, playbackOwnershipGeneration: 1,
    shouldAutoPlay: true, isPlaying: true, cancelPendingPlayback() {
      cancellations++; state.shouldAutoPlay = false; state.isPlaying = false;
    } };
  const store = { getState: () => state };
  return { audio, state, cleanup: capturePlaybackCleanup(store), get pauses() { return pauses; }, get cancellations() { return cancellations; } };
}
test('captured cleanup stops old playback and cancels already-paused autoplay after retirement', () => {
  for (const paused of [true, false]) {
    const f = fixture(); f.audio.paused = paused;
    assert.equal(f.cleanup(), true); assert.equal(f.state.shouldAutoPlay, false); assert.equal(f.state.isPlaying, false);
    assert.equal(f.pauses, paused ? 0 : 1); assert.equal(f.cancellations, 1);
    assert.equal(f.cleanup(), false); assert.equal(f.cancellations, 1);
  }
});
test('captured cleanup cannot stop replacement audio, song, source or a new playback owner', () => {
  for (const change of [
    f => { f.state.audioRef = { current: { ...f.audio } }; },
    f => { f.state.currentSong = { id: 'two' }; },
    f => { f.audio.src = 'https://media.test/two.mp3'; },
    f => { f.state.playbackOwnershipGeneration++; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(f.cleanup(), false); assert.equal(f.pauses, 0); assert.equal(f.cancellations, 0);
    assert.equal(f.state.isPlaying, true); assert.equal(f.state.shouldAutoPlay, true);
  }
});
