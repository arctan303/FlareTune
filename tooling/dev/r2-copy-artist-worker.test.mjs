import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const manifestUrl = new URL('../../server/dev/artist-showcase.json', import.meta.url);
const hasManifest = existsSync(manifestUrl);
const manifest = hasManifest ? (await import(manifestUrl.href, { with: { type: 'json' } })).default : null;
const worker = hasManifest ? (await import('./r2-copy-artist-worker.mjs')).default : null;
const song = manifest?.songs[0];
const requiredKey = song && `dist_music/${song.audio_url}`;
const optionalKey = song && `dist_music/lyrics/${song.id}.json`;

function bucket(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async head(key) {
      const value = values.get(key);
      return value && { size: value.body.length, etag: value.etag };
    },
    async get(key) {
      const value = values.get(key);
      if (!value) return null;
      const chunks = value.chunks || [value.body.length];
      let offset = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (offset >= value.body.length) return controller.close();
          const length = chunks.shift() || value.body.length - offset;
          controller.enqueue(value.body.slice(offset, offset + length));
          offset += length;
        },
      });
      return { body, size: value.body.length,
        httpMetadata: value.httpMetadata,
        customMetadata: value.customMetadata };
    },
    async put(key, body, metadata) {
      values.set(key, { body: new Uint8Array(await new Response(body).arrayBuffer()),
        etag: 'source-etag', ...metadata });
    },
    values,
  };
}

async function request(env, path, key, headers = {}) {
  const response = await worker.fetch(new Request(`http://127.0.0.1:8791${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ key }),
  }), env);
  return { status: response.status, body: await response.json() };
}

test('refuses unlisted keys and browser-origin writes', { skip: !hasManifest }, async () => {
  const env = { SOURCE_BUCKET: bucket(), DEST_BUCKET: bucket() };
  assert.equal((await request(env, '/copy', 'dist_music/audio/other.mp3')).status, 400);
  assert.equal((await request(env, '/copy', requiredKey, { Origin: 'http://example.test' })).status, 403);
  const remote = await worker.fetch(new Request('http://example.test/copy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: requiredKey }),
  }), env);
  assert.equal(remote.status, 404);
  assert.equal(env.DEST_BUCKET.values.size, 0);
});

test('copies only a missing allowlisted object and preserves metadata', { skip: !hasManifest }, async () => {
  const original = { body: new Uint8Array([1, 2, 3]), etag: 'source-etag',
    httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { sample: 'yes' } };
  const env = { SOURCE_BUCKET: bucket({ [requiredKey]: original }), DEST_BUCKET: bucket() };
  assert.equal((await request(env, '/inspect', requiredKey)).body.destination, null);
  assert.deepEqual((await request(env, '/copy', requiredKey)), {
    status: 200, body: { status: 'copied', size: 3, etagMatched: true },
  });
  assert.deepEqual(env.DEST_BUCKET.values.get(requiredKey), original);
  assert.equal((await request(env, '/copy', requiredKey)).body.status, 'already_present');
});

test('rejects a conflicting destination and tolerates absent optional lyrics', { skip: !hasManifest }, async () => {
  const env = {
    SOURCE_BUCKET: bucket({ [requiredKey]: { body: new Uint8Array([1]), etag: 'expected' } }),
    DEST_BUCKET: bucket({ [requiredKey]: { body: new Uint8Array([2]), etag: 'different' } }),
  };
  assert.equal((await request(env, '/copy', requiredKey)).status, 409);
  assert.deepEqual([...env.DEST_BUCKET.values.get(requiredKey).body], [2]);
  assert.equal((await request(env, '/copy', optionalKey)).body.status, 'missing_optional');
});

test('accepts identical bytes with different ETags and rejects same-size changed bytes', { skip: !hasManifest }, async () => {
  const env = {
    SOURCE_BUCKET: bucket({ [requiredKey]: { body: new Uint8Array([1, 2, 3]),
      chunks: [1, 2], etag: 'multipart-2' } }),
    DEST_BUCKET: bucket({ [requiredKey]: { body: new Uint8Array([1, 2, 3]),
      chunks: [2, 1], etag: 'single-part' } }),
  };
  assert.equal((await request(env, '/inspect', requiredKey)).body.contentMatched, true);
  assert.equal((await request(env, '/copy', requiredKey)).body.status, 'already_present');
  env.DEST_BUCKET.values.set(requiredKey, { body: new Uint8Array([1, 2, 4]), etag: 'single-part' });
  assert.equal((await request(env, '/inspect', requiredKey)).body.contentMatched, false);
  assert.equal((await request(env, '/copy', requiredKey)).status, 409);
});

test('reads back newly copied bytes when the destination ETag changes', { skip: !hasManifest }, async () => {
  const env = {
    SOURCE_BUCKET: bucket({ [requiredKey]: { body: new Uint8Array([4, 5, 6]),
      chunks: [1, 2], etag: 'multipart-2' } }),
    DEST_BUCKET: bucket(),
  };
  assert.deepEqual((await request(env, '/copy', requiredKey)), {
    status: 200, body: { status: 'copied', size: 3, etagMatched: false },
  });
  assert.equal((await request(env, '/inspect', requiredKey)).body.contentMatched, true);
});
