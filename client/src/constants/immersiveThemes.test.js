import assert from 'node:assert/strict';
import test from 'node:test';
import { IMMERSIVE_THEMES } from './immersiveThemes.js';

test('the immersive presentation is dedicated to artist photos', () => {
  assert.equal(IMMERSIVE_THEMES.length, 1);
  assert.equal(IMMERSIVE_THEMES[0].id, 'artist-photo');
  assert.equal(IMMERSIVE_THEMES[0].name, '歌手写真');
  assert.equal('video1080Url' in IMMERSIVE_THEMES[0], false);
  assert.equal('posterUrl' in IMMERSIVE_THEMES[0], false);
});
