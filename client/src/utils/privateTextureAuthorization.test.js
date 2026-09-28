import test from 'node:test';
import assert from 'node:assert/strict';
import { isTextureAuthorized } from './privateTextureAuthorization.js';

test('WebGL texture authorization accepts relative oversized source and expires across routes', () => {
  const cover = '/media/cover/large.png';
  let ready = cover;
  const registry = {
    isPrivateMediaUrl: (url) => url === cover,
    getReadySource: () => ready,
  };
  const authorization = { coverUrl: cover, routeRevision: 1, source: cover };
  assert.equal(isTextureAuthorized(cover, 1, authorization, registry), true);
  assert.equal(isTextureAuthorized(cover, 2, authorization, registry), false);
  ready = null;
  assert.equal(isTextureAuthorized(cover, 1, authorization, registry), false);
  assert.equal(isTextureAuthorized(cover, 1, { ...authorization, source: 'https://site.test/media/cover/large.png' }, registry), false);
});
