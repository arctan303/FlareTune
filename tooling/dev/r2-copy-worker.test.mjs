import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const endpoint = 'http://127.0.0.1:8791/copy';
const request = (key) => new Request(endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key, optional: false }),
});

test('development media copy accepts sampled songs and the wallpaper poster, not retired player videos', async (t) => {
  const manifestUrl = new URL('../../server/dev/song-sample.json', import.meta.url);
  if (!existsSync(manifestUrl)) return t.skip('Requires generated development song sample');
  const [{ default: manifest }, { default: worker }] = await Promise.all([
    import(manifestUrl.href, { with: { type: 'json' } }), import('./r2-copy-worker.mjs'),
  ]);
  const writes = [];
  const source = { async head() { return { size: 4, etag: 'source' }; },
    async get() { return { body: new Uint8Array([1, 2, 3, 4]) }; } };
  const destination = { async head() { return writes.length ? { size: 4, etag: 'source' } : null; },
    async put(key) { writes.push(key); } };
  const env = { SOURCE_BUCKET: source, DEST_BUCKET: destination };
  for (const key of [`dist_music/${manifest.songs[0].audio_url}`,
    'dist_music/background/natural-scenery-poster.jpg']) {
    writes.length = 0;
    const response = await worker.fetch(request(key), env);
    assert.equal(response.status, 200, key);
    assert.deepEqual(writes, [key]);
  }
  for (const key of ['dist_music/background/natural-scenery-720.mp4',
    'dist_music/background/natural-scenery-1080.mp4',
    'dist_music/background/other.jpg', 'dist_music/background/../private',
    'dist_music/audio/private.mp3', 'dist_music/audio/ffffffffffffffff.mp3', 'other/path']) {
    writes.length = 0;
    const response = await worker.fetch(request(key), env);
    assert.equal(response.status, 400, key);
    assert.deepEqual(writes, []);
  }
  const browserRequest = request('dist_music/background/natural-scenery-poster.jpg');
  browserRequest.headers.set('Origin', 'http://127.0.0.1:3000');
  assert.equal((await worker.fetch(browserRequest, env)).status, 403);
  assert.deepEqual(writes, []);
});
