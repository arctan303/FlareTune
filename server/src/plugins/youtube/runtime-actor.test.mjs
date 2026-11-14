import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from '../../auth/local/index.js';
import { createYouTubeRuntimeHandler, YouTubeRuntime } from './runtime-actor.mjs';

const id = 'QBtVFL0Qefs';
const epoch = 'installation-fixture:binding-fixture';
const connection = () => ({ epoch, credentials: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret', refreshToken: 'fixture-refresh' },
  record: { epoch: 'installation-fixture' } });
const request = (path = '/audio/' + id, init = {}) => new Request('https://yt-runtime.internal' + path,
  { ...init, headers: { 'X-FlareTune-YT-Epoch': epoch, ...init.headers } });

test('private actor forwards only media context and checks connection before and after streaming', async () => {
  let reads = 0, storageAccesses = 0, streamed = 0;
  const ctx = new Proxy({ waitUntil() {} }, { get(target, key) {
    if (key === 'storage') { storageAccesses++; throw new Error('storage must not be used'); }
    return target[key];
  } });
  const env = {};
  const actor = createYouTubeRuntimeHandler({ env, ctx, getBinding: async () => { reads++; return connection(); },
    createService(options) {
      assert.equal(options.env, env); assert.equal(options.ctx, ctx); assert.equal(options.epoch, epoch);
      assert.equal(options.credentials.clientId, 'fixture-client-id');
      return { async stream(input, videoId) {
        streamed++; assert.equal(videoId, id); assert.equal(input.headers.get('Range'), 'bytes=2-5');
        assert.equal(input.headers.get('If-Range'), 'fixture-etag'); assert.equal(input.headers.get('User-Agent'), 'Fixture browser');
        for (const key of ['Cookie', 'Authorization', 'X-FlareTune-YT-Epoch', 'X-API-Key']) assert.equal(input.headers.has(key), false);
        return new Response('2345', { status: 206, headers: { 'Content-Type': 'audio/webm', 'Content-Range': 'bytes 2-5/16', 'Accept-Ranges': 'bytes' } });
      } };
    } });
  new YouTubeRuntime(ctx, env);
  const result = await actor(request('/audio/' + id + '?codec=opus&itag=774', { headers: { Range: 'bytes=2-5', 'If-Range': 'fixture-etag',
    'User-Agent': 'Fixture browser', Cookie: 'private-browser-cookie', Authorization: 'Bearer private', 'X-API-Key': 'private' } }));
  assert.equal(result.status, 206); assert.equal(await result.text(), '2345');
  assert.equal(result.headers.get('Content-Range'), 'bytes 2-5/16');
  assert.equal(reads, 2); assert.equal(streamed, 1); assert.equal(storageAccesses, 0);
});

test('private actor rejects invalid method/path/query and missing capabilities before source access', async () => {
  let reads = 0, streamed = 0;
  const actor = createYouTubeRuntimeHandler({ env: {}, ctx: {}, getBinding: async () => { reads++; return connection(); },
    createService: () => ({ stream: async () => { streamed++; return new Response(); } }) });
  for (const [input, expected] of [
    [request('/audio/' + id, { method: 'POST' }), 405], [request('/api/search'), 404], [request('/audio/invalid'), 404],
    [request('/audio/' + id + '?url=https://private.example/'), 400], [request('/audio/' + id + '?codec=opus&codec=aac'), 400],
    [request('/audio/' + id + '?codec='), 400], [request('/audio/' + id + '?itag=999'), 400],
    [new Request('https://yt-runtime.internal/audio/' + id), 403],
  ]) assert.equal((await actor(input)).status, expected);
  assert.equal(reads, 0); assert.equal(streamed, 0);
  assert.equal((await actor(request('/audio/' + id, { headers: { 'X-FlareTune-YT-Epoch': 'wrong-generation' } }))).status, 403);
  assert.equal(reads, 1); assert.equal(streamed, 0);
});

test('connection or plugin generation changes before headers cancel the source body', async () => {
  for (const change of ['binding', 'installation', 'uninstall']) {
    let reads = 0, cancelled = 0;
    const actor = createYouTubeRuntimeHandler({ env: {}, ctx: {}, getBinding: async () => {
      reads++;
      if (reads === 1) return connection();
      if (change === 'uninstall') throw new AuthError('PLUGIN_NOT_INSTALLED', 409);
      return { ...connection(), ...(change === 'binding' ? { epoch: 'installation-fixture:replacement-binding' } : { record: { epoch: 'new-installation' } }) };
    }, createService: () => ({ stream: async () => new Response(new ReadableStream({ cancel() { cancelled++; } }),
      { headers: { 'Content-Type': 'audio/webm' } }) }) });
    const response = await actor(request());
    assert.equal(response.status, 409); assert.equal(cancelled, 1);
    assert.equal((await response.json()).error, change === 'uninstall' ? 'PLUGIN_NOT_INSTALLED' : 'YOUTUBE_CONNECTION_CHANGED');
  }
});

test('private actor sanitizes unexpected failures and HEAD errors have no body', async () => {
  const actor = createYouTubeRuntimeHandler({ env: {}, ctx: {}, getBinding: async () => { throw new Error('private token signed-url and response body'); } });
  const response = await actor(request());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'YOUTUBE_RUNTIME_UNAVAILABLE' });
  const head = await actor(request('/audio/' + id, { method: 'HEAD' }));
  assert.equal(head.status, 503); assert.equal(await head.text(), '');
});
