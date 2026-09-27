import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogSong, deleteCatalogSong, listCatalogSongs, uploadCatalogMedia } from './catalogAdminApi.js';
import { useUIStore } from '../store/useUIStore.js';

const respond = (data, status = 200) => new Response(JSON.stringify({ ok: status < 400, data }), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('catalog mutations use the new admin namespace and local-account CSRF', async () => {
  useUIStore.setState({ authSession: { authenticated: true,
    user: { accountId: 'admin-1', role: 'admin' }, csrfToken: 'csrf-1' } });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond({}); };
  await createCatalogSong({ id: 's1', title: 'One', audio_url: '/media/audio/one.mp3' }, fetchImpl);
  await deleteCatalogSong('s1', 'v1', fetchImpl);
  assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [
    ['/api/admin/catalog/songs', 'POST'], ['/api/admin/catalog/songs/s1', 'DELETE'],
  ]);
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(calls[0].init.headers['X-FlareTune-Expected-Account'], 'admin-1');
  assert.deepEqual(JSON.parse(calls[1].init.body), { expectedVersion: 'v1', confirmDelete: true });
});

test('browser media upload declares file size and never uses a retired admin key', async () => {
  useUIStore.setState({ authSession: { authenticated: true,
    user: { accountId: 'admin-1', role: 'admin' }, csrfToken: 'csrf-1' } });
  const file = new File([Uint8Array.of(0xff, 0xd8, 0xff, 0x00)], 'cover.jpg', { type: 'image/jpeg' });
  let seen;
  const result = await uploadCatalogMedia('cover', file, async (url, init) => {
    seen = { url, init };
    return respond({ url: '/media/cover/test.jpg' }, 201);
  });
  assert.equal(result.url, '/media/cover/test.jpg');
  assert.match(seen.url, /^\/api\/admin\/catalog\/media\/cover\/[0-9a-f]{16}\.jpg$/);
  assert.equal(seen.init.headers['X-FlareTune-Media-Size'], '4');
  assert.equal(seen.init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(seen.init.headers['x-admin-api-key'], undefined);
});

test('media upload reports actual transferred bytes through XMLHttpRequest', async () => {
  useUIStore.setState({ authSession: { authenticated: true,
    user: { accountId: 'admin-1', role: 'admin' }, csrfToken: 'csrf-1' } });
  const original = globalThis.XMLHttpRequest;
  let request;
  class FakeUploadRequest {
    upload = {};
    headers = {};
    constructor() { request = this; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
      this.body = body;
      this.upload.onprogress({ lengthComputable: true, loaded: 2, total: 4 });
      this.status = 201;
      this.responseText = JSON.stringify({ ok: true, data: { url: '/media/audio/test.mp3' } });
      this.onload();
    }
  }
  globalThis.XMLHttpRequest = FakeUploadRequest;
  try {
    const file = new File([Uint8Array.of(1, 2, 3, 4)], 'test.mp3', { type: 'audio/mpeg' });
    const progress = [];
    const result = await uploadCatalogMedia('audio', file, undefined,
      (loaded, total) => progress.push([loaded, total]));
    assert.equal(result.url, '/media/audio/test.mp3');
    assert.deepEqual(progress, [[2, 4]]);
    assert.equal(request.withCredentials, true);
    assert.equal(request.headers['X-CSRF-Token'], 'csrf-1');
    assert.equal(request.headers['X-FlareTune-Media-Size'], '4');
    assert.equal(request.body, file);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('progress upload keeps the server error when the Worker rejects media', async () => {
  useUIStore.setState({ authSession: { authenticated: true,
    user: { accountId: 'admin-1', role: 'admin' }, csrfToken: 'csrf-1' } });
  const original = globalThis.XMLHttpRequest;
  class RejectedUploadRequest {
    upload = {};
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 413;
      this.responseText = JSON.stringify({ ok: false, message: '文件过大', error: 'MEDIA_TOO_LARGE' });
      this.onload();
    }
  }
  globalThis.XMLHttpRequest = RejectedUploadRequest;
  try {
    const file = new File([Uint8Array.of(1)], 'test.mp3', { type: 'audio/mpeg' });
    await assert.rejects(uploadCatalogMedia('audio', file, undefined, () => {}),
      (error) => error.message === '文件过大' && error.status === 413 && error.code === 'MEDIA_TOO_LARGE');
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('song search is encoded in the admin request', async () => {
  useUIStore.setState({ authSession: { authenticated: true,
    user: { accountId: 'admin-1', role: 'admin' }, csrfToken: 'csrf-1' } });
  let requestedUrl;
  await listCatalogSongs({ page: 2, q: 'Morning & jazz' }, async (url) => {
    requestedUrl = url;
    return respond({ songs: [], total: 0, page: 2, limit: 30 });
  });
  assert.equal(requestedUrl, '/api/admin/catalog/songs?page=2&limit=30&q=Morning%20%26%20jazz');
});
