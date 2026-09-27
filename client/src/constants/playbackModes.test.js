import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaybackMode, PLAYBACK_MODE_NAMES, PLAYBACK_MODES } from './playbackModes.js';

test('playback modes expose one canonical order and label map', () => {
  assert.deepEqual(PLAYBACK_MODES, ['sequence', 'loop', 'single', 'random']);
  assert.equal(isPlaybackMode('single'), true);
  assert.equal(isPlaybackMode('legacy'), false);
  assert.equal(PLAYBACK_MODE_NAMES.random, '随机播放');
});
