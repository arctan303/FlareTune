import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPlaybackFavicon } from './usePlaybackPresentation.js';

test('private favicon uses only a validated Blob or the static icon', () => {
  const cover = '/media/cover/a.png';
  const registry = {
    isPrivateMediaUrl: (url) => url === cover,
    getReadySource: () => 'blob:validated',
  };
  assert.equal(selectPlaybackFavicon(cover, null, true, registry), '/favicon.svg');
  assert.equal(selectPlaybackFavicon(cover, cover, true, registry), '/favicon.svg');
  assert.equal(selectPlaybackFavicon(cover, 'blob:other', true, registry), '/favicon.svg');
  assert.equal(selectPlaybackFavicon(cover, 'blob:validated', true, registry), 'blob:validated');
  assert.equal(selectPlaybackFavicon(cover, 'blob:validated', false, registry), '/favicon.svg');
  assert.equal(selectPlaybackFavicon('https://images.example/a.png', null, true, registry), 'https://images.example/a.png');
});
