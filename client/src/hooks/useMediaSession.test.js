import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMediaSessionArtwork } from './useMediaSession.js';

test('media session artwork does not use an unverified private URL', () => {
  const cover = '/media/cover/a.png';
  const registry = {
    isPrivateMediaUrl: (url) => url === cover,
    getReadySource: () => 'blob:validated',
  };
  assert.equal(selectMediaSessionArtwork(cover, null, registry), '/favicon.png');
  assert.equal(selectMediaSessionArtwork(cover, cover, registry), '/favicon.png');
  assert.equal(selectMediaSessionArtwork(cover, 'blob:other', registry), '/favicon.png');
  assert.equal(selectMediaSessionArtwork(cover, 'blob:validated', registry), 'blob:validated');
  assert.equal(selectMediaSessionArtwork('https://images.example/a.png', null, registry), 'https://images.example/a.png');
});
