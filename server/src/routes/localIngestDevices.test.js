import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalIngestDevicesRoute } from './localIngestDevices.js';

const admin = { mode: 'normal', account: { role: 'admin' } };
const member = { mode: 'normal', account: { role: 'member' } };
const id = 'a'.repeat(32);
const root = '/api/admin/ingest/devices';
function bucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      const value = objects.get(key);
      return value ? { json: async () => structuredClone(value) } : null;
    },
    async head(key) {
      const value = objects.get(key);
      return value && typeof value.size === 'number' ? { size: value.size } : null;
    },
    async put(key, value) { objects.set(key, JSON.parse(value)); return { key }; },
    async delete(key) { objects.delete(key); },
    async list({ prefix, limit = 1000 }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix))
        .slice(0, limit).map((key) => ({ key })), truncated: false };
    },
  };
}
async function call(storage, path, { method = 'GET', body, session = admin, prefix = 'dist_music' } = {}) {
  const request = new Request('https://tune.test' + path, {
    method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  const response = await handleLocalIngestDevicesRoute(request, new URL(request.url), null, {}, session,
    { MEDIA_BUCKET: storage, MEDIA_PREFIX: prefix });
  return { status: response?.status, payload: response && await response.json() };
}

test('only admins can see and control a device; dev and production mailbox prefixes remain separate', async () => {
  const storage = bucket();
  const heartbeat = { name: '设备 S', roots: ['music'] };
  assert.equal((await call(storage, `${root}/${id}/heartbeat`,
    { method: 'POST', body: heartbeat, session: member })).status, 403);
  assert.equal(storage.objects.size, 0);
  assert.equal((await call(storage, `${root}/${id}/heartbeat`, { method: 'POST', body: heartbeat,
    session: { mode: 'must_change_password', account: { role: 'admin' } } })).status, 403);
  assert.equal((await call(storage, `${root}/${id}/heartbeat`,
    { method: 'POST', body: heartbeat })).status, 200);
  const dev = await call(storage, root);
  assert.equal(dev.payload.data.devices[0].name, '设备 S');
  assert.equal(dev.payload.data.devices[0].online, true);
  const production = await call(storage, root, { prefix: 'media' });
  assert.deepEqual(production.payload.data.devices, []);
});

test('updating transfer history retains the actual last scan time', async () => {
  const storage = bucket();
  await call(storage, `${root}/${id}/heartbeat`, { method: 'POST', body: { name: 'device', roots: ['music'] } });
  const files = [{ id: 'b'.repeat(32), path: 'music/song.mp3', name: 'song.mp3', size: 8 }];
  const manifestKey = `dist_music/ingest-devices/v1/${id}/manifest.json`;
  storage.objects.set(manifestKey, { files, scannedAt: 12345 });
  const update = await call(storage, `${root}/${id}/manifest`, { method: 'PUT',
    body: { files: [{ ...files[0], ingest: { audio: { status: 'done' } } }], preserveScanTime: true } });
  assert.equal(update.status, 200);
  assert.equal((await call(storage, `${root}/${id}/manifest`)).payload.data.scannedAt, 12345);
  await call(storage, `${root}/${id}/manifest`, { method: 'PUT', body: { files } });
  assert.ok((await call(storage, `${root}/${id}/manifest`)).payload.data.scannedAt > 12345);
});

test('browser enqueues a selected scanned file; agent reports a media URL and the pending item is cleared', async () => {
  const storage = bucket();
  const fileId = 'b'.repeat(32);
  await call(storage, `${root}/${id}/heartbeat`, {
    method: 'POST', body: { name: '设备 S', roots: ['music'] },
  });
  await call(storage, `${root}/${id}/manifest`, {
    method: 'PUT', body: { files: [{ id: fileId, name: 'A.mp3', path: 'music/zh/A.mp3',
      size: 12, common: { title: 'A' }, cover: null }] },
  });
  const manifest = await call(storage, `${root}/${id}/manifest`);
  assert.equal(manifest.payload.data.files.length, 1);
  assert.equal((await call(storage, `${root}/${id}/jobs`,
    { method: 'POST', body: { kind: 'audio', fileId: 'c'.repeat(32) } })).status, 409);
  const created = await call(storage, `${root}/${id}/jobs`,
    { method: 'POST', body: { kind: 'audio', fileId } });
  assert.equal(created.status, 201);
  const job = created.payload.data.job;
  assert.equal(job.expectedSize, 12);
  const polled = await call(storage, `${root}/${id}/poll`);
  assert.equal(polled.payload.data.jobs[0].id, job.id);
  assert.equal((await call(storage, `${root}/${id}/jobs/${job.id}/progress`, {
    method: 'PUT', body: { loaded: 6, total: 12 },
  })).status, 200);
  assert.deepEqual((await call(storage, `${root}/${id}/jobs/${job.id}`)).payload.data.job.progress,
    { kind: 'audio', loaded: 6, total: 12 });
  assert.equal((await call(storage, `${root}/${id}/jobs/${job.id}/progress`, {
    method: 'PUT', body: { loaded: 13, total: 12 },
  })).status, 400);
  assert.equal((await call(storage, `${root}/${id}/jobs/${job.id}`, {
    method: 'PUT', body: { status: 'done', url: '/media/audio/not-a-media-id.mp3' },
  })).status, 400);
  assert.equal((await call(storage, `${root}/${id}/jobs/${job.id}`, {
    method: 'PUT', body: { status: 'done', url: `/media/audio/${'c'.repeat(16)}.mp3` },
  })).status, 400);
  assert.equal((await call(storage, `${root}/${id}/jobs/${job.id}`, {
    method: 'PUT', body: { status: 'done', url: `/media/audio/${job.mediaId}.mp3` },
  })).status, 409);
  storage.objects.set(`dist_music/audio/${job.mediaId}.mp3`, { size: 12 });
  const completed = await call(storage, `${root}/${id}/jobs/${job.id}`, {
    method: 'PUT', body: { status: 'done', url: `/media/audio/${job.mediaId}.mp3` },
  });
  assert.equal(completed.status, 200);
  assert.equal((await call(storage, `${root}/${id}/poll`)).payload.data.jobs.length, 0);
  assert.equal((await call(storage, `${root}/${id}/jobs/${job.id}`)).payload.data.job.status, 'done');
});

test('retry of a failed device upload keeps its job and media ID', async () => {
  const storage = bucket();
  const fileId = 'b'.repeat(32);
  await call(storage, `${root}/${id}/heartbeat`, { method: 'POST', body: { name: '设备 S', roots: ['music'] } });
  await call(storage, `${root}/${id}/manifest`, { method: 'PUT', body: { files: [{
    id: fileId, name: 'A.mp3', path: 'music/A.mp3', size: 12, cover: null,
  }] } });
  const created = await call(storage, `${root}/${id}/jobs`, {
    method: 'POST', body: { kind: 'audio', fileId },
  });
  const original = created.payload.data.job;
  await call(storage, `${root}/${id}/jobs/${original.id}`, {
    method: 'PUT', body: { status: 'error', message: 'network failed' },
  });
  const retry = await call(storage, `${root}/${id}/jobs/${original.id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 201);
  assert.equal(retry.payload.data.job.id, original.id);
  assert.equal(retry.payload.data.job.mediaId, original.mediaId);
  assert.equal((await call(storage, `${root}/${id}/poll`)).payload.data.jobs.length, 1);
});
