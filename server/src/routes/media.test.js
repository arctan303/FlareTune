import assert from 'node:assert/strict';
import test from 'node:test';
import { serveMediaObject, resolveMediaObjectKey } from './media.js';

test('media route maps deployment-local URLs into the configured R2 prefix', () => {
  assert.equal(resolveMediaObjectKey('/media/audio/song.mp3', { MEDIA_PREFIX: 'media' }), 'media/audio/song.mp3');
  assert.equal(resolveMediaObjectKey('/media/%E6%AD%8C%E6%9B%B2/cover.jpg', { MEDIA_PREFIX: 'library' }), 'library/歌曲/cover.jpg');
  assert.equal(resolveMediaObjectKey('/media/account-A/avatars/private.webp', { MEDIA_PREFIX: 'users' }), null);
  assert.equal(resolveMediaObjectKey('/media/avatars/private.webp', { MEDIA_PREFIX: 'users/account-A' }), null);
  for (const path of ['/media/', '/media//song.mp3', '/media/../secret', '/media/%2e%2e/secret', '/media/audio%2Fsong.mp3']) {
    assert.equal(resolveMediaObjectKey(path, { MEDIA_PREFIX: 'media' }), null, path);
  }
});

test('media route streams GET and HEAD from the bound bucket without exposing writes', async () => {
  const calls = [];
  const object = {
    body: 'audio',
    size: 5,
    httpEtag: '"etag"',
    writeHttpMetadata(headers) {
      headers.set('Content-Type', 'audio/mpeg');
      headers.set('Cache-Control', 'public, max-age=86400');
    },
  };
  const env = { MEDIA_PREFIX: 'media', MEDIA_BUCKET: {
    async get(key, options) { calls.push(['get', key, options.range.get('Range')]); return object; },
    async head(key) { calls.push(['head', key]); return object; },
  } };

  const get = await serveMediaObject(new Request('https://flaretune.example.test/media/audio/song.mp3', {
    headers: { Range: 'bytes=0-4' },
  }), '/media/audio/song.mp3', env);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(get.headers.get('ETag'), '"etag"');
  assert.equal(get.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(await get.text(), 'audio');

  const head = await serveMediaObject(new Request('https://flaretune.example.test/media/audio/song.mp3', {
    method: 'HEAD',
  }), '/media/audio/song.mp3', env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.deepEqual(calls, [
    ['get', 'media/audio/song.mp3', 'bytes=0-4'],
    ['head', 'media/audio/song.mp3'],
  ]);

  const write = await serveMediaObject(new Request('https://flaretune.example.test/media/audio/song.mp3', {
    method: 'PUT', body: 'x',
  }), '/media/audio/song.mp3', env);
  assert.equal(write.status, 405);
});

test('media route reports missing storage and objects without falling back externally', async () => {
  assert.equal((await serveMediaObject(new Request('https://flaretune.example.test/media/a'), '/media/a', {})).status, 503);
  const env = { MEDIA_PREFIX: 'media', MEDIA_BUCKET: { get: async () => null } };
  assert.equal((await serveMediaObject(new Request('https://flaretune.example.test/media/missing.mp3'), '/media/missing.mp3', env)).status, 404);
});
