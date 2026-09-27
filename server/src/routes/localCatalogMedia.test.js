import assert from 'node:assert/strict';
import test from 'node:test';
import { createValidatedMediaStream, handleLocalCatalogMediaRoute } from './localCatalogMedia.js';

const base = '/api/admin/catalog/media';
const id = '0123456789abcdef';
const admin = { mode: 'normal', account: { accountId: 'owner', role: 'admin' } };
const member = { mode: 'normal', account: { accountId: 'member', role: 'member' } };
const mp3 = Uint8Array.of(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00);
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00);

// Node's Web Streams do not expose Cloudflare's FixedLengthStream. This shim
// preserves its exact-size contract for in-memory R2 tests; real Miniflare is
// exercised separately by the Worker HTTP smoke test.
globalThis.FixedLengthStream ??= class FixedLengthStreamForTest {
  constructor(length) {
    let written = 0;
    const stream = new TransformStream({
      transform(chunk, controller) {
        written += chunk.byteLength;
        if (written > length) throw new Error('FixedLengthStream overflow');
        controller.enqueue(chunk);
      },
      flush() {
        if (written !== length) throw new Error('FixedLengthStream underflow');
      },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
};

function memoryBucket() {
  const objects = new Map();
  const puts = [];
  return {
    objects,
    puts,
    async put(key, stream, options) {
      puts.push({ key, options });
      assert.equal(options.onlyIf.get('If-None-Match'), '*');
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      // This represents R2's atomic conditional put after stream consumption.
      if (objects.has(key)) return null;
      const object = { size: bytes.byteLength, etag: `etag-${puts.length}` };
      objects.set(key, { bytes, options, object });
      return object;
    },
  };
}

async function call(path, {
  method = 'PUT', body = mp3, contentType = 'audio/mpeg',
  session = admin, bucket = memoryBucket(), headers = {}, env = {}, omitContentLength = false,
} = {}) {
  const request = new Request(`https://tune.example${path}`, {
    method,
    headers: {
      'Content-Type': contentType,
      ...(!omitContentLength && !['GET', 'HEAD'].includes(method) ? { 'Content-Length': String(body?.byteLength ?? 0) } : {}),
      ...headers,
    },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body }),
  });
  const response = await handleLocalCatalogMediaRoute(
    request, new URL(request.url), null, { 'X-Test': 'media' }, session,
    { MEDIA_BUCKET: bucket, ...env },
  );
  return { response, bucket, body: response && await response.json() };
}

test('route only handles the new catalog media namespace and never relies on an admin key', async () => {
  assert.equal((await call(`/api/admin/media/audio/${id}.mp3`)).response, null);
  assert.equal((await call('/api/manage/media/upload')).response, null);
  const bucket = memoryBucket();
  for (const session of [null, member, { ...admin, mode: 'must_change_password' }]) {
    const result = await call(`${base}/audio/${id}.mp3`, { session, bucket });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error, 'FORBIDDEN');
  }
  assert.equal(bucket.puts.length, 0);
});

test('admin upload creates a bounded fixed-key media object with private response', async () => {
  const bucket = memoryBucket();
  const result = await call(`${base}/audio/${id}.mp3`, { bucket });
  assert.equal(result.response.status, 201);
  assert.equal(result.response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(result.response.headers.get('X-Test'), 'media');
  assert.deepEqual(result.body.data, {
    path: `audio/${id}.mp3`, url: `/media/audio/${id}.mp3`, objectKey: `media/audio/${id}.mp3`,
    size: mp3.byteLength, etag: 'etag-1',
  });
  assert.deepEqual(bucket.objects.get(`media/audio/${id}.mp3`).bytes, mp3);
  assert.equal(bucket.puts[0].options.httpMetadata.contentType, 'audio/mpeg');
});

test('browser upload may declare file size without setting Content-Length', async () => {
  const result = await call(`${base}/audio/${id}.mp3`, {
    omitContentLength: true, headers: { 'X-FlareTune-Media-Size': String(mp3.byteLength) },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.data.url, `/media/audio/${id}.mp3`);
  const mismatch = await call(`${base}/audio/${id}.mp3`, {
    headers: { 'X-FlareTune-Media-Size': String(mp3.byteLength + 1) },
  });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.body.error, 'MEDIA_SIZE_MISMATCH');
});

test('cover upload accepts the exact type and collision returns 409 without overwrite', async () => {
  const bucket = memoryBucket();
  const path = `${base}/cover/${id}.png`;
  const first = await call(path, { body: png, contentType: 'image/png', bucket });
  assert.equal(first.response.status, 201);
  const second = await call(path, { body: png, contentType: 'image/png', bucket });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error, 'MEDIA_EXISTS');
  assert.deepEqual(bucket.objects.get(`media/cover/${id}.png`).bytes, png);
});

test('upload follows configured R2 prefix while keeping the stable media URL', async () => {
  const bucket = memoryBucket();
  const result = await call(`${base}/audio/${id}.mp3`, { bucket, env: { MEDIA_PREFIX: 'private-media/music' } });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.data.objectKey, `private-media/music/audio/${id}.mp3`);
  assert.equal(result.body.data.url, `/media/audio/${id}.mp3`);
  assert.deepEqual(bucket.objects.get(`private-media/music/audio/${id}.mp3`).bytes, mp3);
});

test('path, extension, method, media type and Content-Length are rejected before R2 write', async () => {
  const bucket = memoryBucket();
  const cases = [
    [`${base}/audio/%2e%2e/secret.mp3`, {}, 400],
    [`${base}/audio/not-hex.mp3`, {}, 400],
    [`${base}/audio/${id}.exe`, {}, 415],
    [`${base}/audio/${id}.mp3?overwrite=true`, {}, 400],
    [`${base}/audio/${id}.mp3`, { contentType: 'application/octet-stream' }, 415],
    [`${base}/audio/${id}.mp3`, { omitContentLength: true }, 411],
    [`${base}/audio/${id}.mp3`, { headers: { 'Content-Length': String(100 * 1024 * 1024 + 1) } }, 413],
    [`${base}/audio/${id}.mp3`, { method: 'POST' }, 405],
  ];
  for (const [path, options, status] of cases) {
    const result = await call(path, { ...options, bucket });
    assert.equal(result.response.status, status, path);
  }
  assert.equal(bucket.puts.length, 0);
});

test('empty or mismatched file content aborts the R2 stream without writing', async () => {
  const bucket = memoryBucket();
  const empty = await call(`${base}/audio/${id}.mp3`, { body: new Uint8Array(), bucket });
  assert.equal(empty.response.status, 400);
  const wrong = await call(`${base}/cover/${id}.png`, { body: mp3, contentType: 'image/png', bucket });
  assert.equal(wrong.response.status, 415);
  const short = await call(`${base}/audio/${id}.flac`, { body: Uint8Array.of(0x66, 0x4c), contentType: 'audio/flac', bucket });
  assert.equal(short.response.status, 415);
  assert.equal(bucket.objects.size, 0);
});

test('stream validator enforces the actual byte limit when Content-Length is unavailable or wrong', async () => {
  const chunks = [mp3.subarray(0, 2), mp3.subarray(2)];
  const input = new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
  });
  const validated = createValidatedMediaStream(input, { extension: 'mp3', maxBytes: 6 });
  await assert.rejects(new Response(validated.stream).arrayBuffer());
  assert.equal(validated.error().code, 'MEDIA_TOO_LARGE');
  assert.equal(validated.byteCount(), 2);
});

test('missing R2 binding and upload failures do not reveal storage details', async () => {
  const missing = await call(`${base}/audio/${id}.mp3`, { env: { MEDIA_BUCKET: null } });
  assert.equal(missing.response.status, 503);
  const broken = await call(`${base}/audio/${id}.mp3`, { bucket: { async put() { throw new Error('secret bucket location'); } } });
  assert.equal(broken.response.status, 502);
  assert.equal(JSON.stringify(broken.body).includes('secret bucket location'), false);
});
