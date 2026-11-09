import assert from 'node:assert/strict';
import test from 'node:test';
import { pauseRetiredMusicSourcePlayback } from './musicSourcePlayback.js';

function playback(currentSong, { paused = false } = {}) {
  let pauses = 0, cancels = 0;
  const audio = { paused, pause() { this.paused = true; pauses++; } };
  const state = { currentSong, isPlaying: !paused, shouldAutoPlay: true, audioRef: { current: audio },
    cancelPendingPlayback() { cancels++; state.isPlaying = false; state.shouldAutoPlay = false; } };
  return { state, audio, store: { getState: () => state }, counts: () => ({ pauses, cancels }) };
}

test('source retirement cancels only matching media while preserving local playback and its queue', () => {
  const matches = song => song.source === 'fixture-source';
  const local = playback({ id: 'local', source: 'r2' });
  assert.equal(pauseRetiredMusicSourcePlayback(local.store, matches), false);
  assert.deepEqual(local.counts(), { pauses: 0, cancels: 0 });
  assert.equal(local.audio.paused, false);
  const source = playback({ id: 'external', source: 'fixture-source' });
  source.state.playlist = [source.state.currentSong];
  assert.equal(pauseRetiredMusicSourcePlayback(source.store, matches), true);
  assert.equal(source.audio.paused, true);
  assert.equal(source.state.isPlaying, false);
  assert.equal(source.state.shouldAutoPlay, false);
  assert.equal(source.state.playlist.length, 1);
  assert.equal(source.state.currentSong.id, 'external');
  assert.deepEqual(source.counts(), { pauses: 1, cancels: 1 });
});

test('retirement also revokes autoplay while the matching element is already paused waiting for canplay', () => {
  const source = playback({ id: 'external', source: 'fixture-source' }, { paused: true });
  assert.equal(pauseRetiredMusicSourcePlayback(source.store, () => true), true);
  assert.equal(source.state.shouldAutoPlay, false);
  assert.equal(source.audio.paused, true);
});

test('source matchers receive detached metadata and cannot alter host song metadata', () => {
  const source = playback({ id: 'external', metadata: { title: 'Original' } });
  const matched = pauseRetiredMusicSourcePlayback(source.store, song => {
    song.metadata.title = 'Changed by predicate';
    return true;
  });
  assert.equal(matched, true);
  assert.equal(source.state.currentSong.metadata.title, 'Original');
});

test('a broken matcher or a replaced selection cannot pause another current song', () => {
  const source = playback({ id: 'external' });
  assert.equal(pauseRetiredMusicSourcePlayback(source.store, () => { throw new Error('Broken source'); }), false);
  assert.equal(pauseRetiredMusicSourcePlayback(source.store, () => {
    source.state.currentSong = { id: 'new-local', source: 'r2' };
    return true;
  }), false);
  assert.deepEqual(source.counts(), { pauses: 0, cancels: 0 });
});
