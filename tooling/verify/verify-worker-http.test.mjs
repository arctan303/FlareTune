import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent } from 'undici';
import { verifyWorkerHttp } from './verify-worker-http.mjs';

async function fixture(t, { leakMedia = false } = {}) {
  const calls = [];
  const rejectedSockets = new WeakSet();
  const server = createServer((request, response) => {
    calls.push({ path: request.url, method: request.method, socket: request.socket });
    // Model workerd's Windows service-binding reset after an unread POST body:
    // a subsequent request on that old connection loses its response.
    if (rejectedSockets.has(request.socket)) { request.socket.destroy(); return; }
    const path = request.url;
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script src="/assets/main.js"></script><link href="/assets/main.css">');
    } else if (path.startsWith('/assets/')) {
      response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'application/javascript' : 'text/css' });
      response.end('fixture asset');
    } else if (path === '/api/instance/status') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store' });
      response.end(JSON.stringify({ state: 'setup_required', schemaVersion: 0, targetVersion: 2 }));
    } else if (path.startsWith('/api/') || path === '/auth/start') {
      if (request.method === 'POST') rejectedSockets.add(request.socket);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'setup_required' }));
    } else if (path.startsWith('/media/')) {
      response.writeHead(503, { 'cache-control': 'private, no-store' });
      response.end(leakMedia ? 'private media must not be returned' : '');
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dispatcher = new Agent({ connections: 1, pipelining: 1 });
  t.after(async () => {
    await dispatcher.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { calls, origin: `http://127.0.0.1:${server.address().port}`,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher }) };
}

test('HTTP smoke preserves the rejection and opens a fresh media connection after a refused POST body', async t => {
  const { origin, fetchImpl, calls } = await fixture(t);
  assert.deepEqual(await verifyWorkerHttp(origin, { fetchImpl }), { ok: true });
  const postIndex = calls.findIndex(call => call.path === '/api/account/playlists');
  assert.equal(calls[postIndex].method, 'POST');
  assert.equal(calls[postIndex + 1].path, '/media/audio/fixture-song.mp3');
  assert.notEqual(calls[postIndex].socket, calls[postIndex + 1].socket);
});

test('HTTP smoke rejects a private media body even when its status and cache policy look correct', async t => {
  const { origin, fetchImpl } = await fixture(t, { leakMedia: true });
  await assert.rejects(verifyWorkerHttp(origin, { fetchImpl }), /denied media must have an empty body/);
});
