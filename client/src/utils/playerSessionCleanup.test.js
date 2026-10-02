import test from 'node:test';
import assert from 'node:assert/strict';
import { stopSessionPlayback } from './playerSessionCleanup.js';

test('ending the session stops audio, pending autoplay, OS metadata and transport actions', () => {
  const calls = [];
  let state = { isPlaying: true, shouldAutoPlay: true, audioRef: { current: {
    pause: () => calls.push('pause'), removeAttribute: (name) => calls.push(name), load: () => calls.push('load'),
  } } };
  const media = { metadata: { title: 'Private title' }, playbackState: 'playing',
    setPositionState: () => calls.push('position'), setActionHandler: (action, handler) => {
      assert.equal(handler, null); calls.push(action);
    } };
  stopSessionPlayback({ getState: () => state, setState: (value) => { state = { ...state, ...value }; } }, media);
  assert.equal(state.isPlaying, false);
  assert.equal(state.shouldAutoPlay, false);
  assert.equal(media.metadata, null);
  assert.equal(media.playbackState, 'none');
  assert.deepEqual(calls.slice(0, 4), ['pause', 'src', 'load', 'position']);
  assert.equal(calls.length, 12);
});
