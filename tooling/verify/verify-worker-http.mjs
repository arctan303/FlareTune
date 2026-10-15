import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const noHtml = async (res) => assert.doesNotMatch((await res.clone().text()).toLowerCase(), /<!doctype html|<html/);
export async function verifyWorkerHttp(base = 'http://127.0.0.1:8790', { fetchImpl = globalThis.fetch } = {}) {
  const homeResponse = await fetchImpl(base + '/');
  assert.equal(homeResponse.status, 200);
  assert.match(homeResponse.headers.get('content-type') || '', /text\/html/);
  const homeHtml = await homeResponse.text();
  const scriptPath = homeHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]; const cssPath = homeHtml.match(/<link[^>]+href="([^"]+\.css)"/)?.[1]; assert.ok(scriptPath); assert.ok(cssPath);
  for (const [path, contentType] of [[scriptPath, /javascript/], [cssPath, /text\/css/]]) {
    const response = await fetchImpl(new URL(path, base));
    assert.match(response.headers.get('content-type') || '', contentType);
    await response.arrayBuffer();
  }
  const status = await fetchImpl(base + '/api/instance/status');
  assert.equal(status.status, 200);
  assert.match(status.headers.get('content-type') || '', /application\/json/);
  assert.equal(status.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await status.json(), { state: 'setup_required', schemaVersion: 0, targetVersion: 2 });

  for (const [path, init] of [
    ['/api/init', undefined],
    ['/api/__preview_missing__', undefined],
    ['/auth/start', { redirect: 'manual' }],
    // Miniflare/workerd can reset a Windows socket after rejecting an unread
    // POST body across a service binding (cloudflare/workerd#7634). Finish this
    // one connection instead of reusing it for the next media assertion.
    ['/api/account/playlists', { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: '{}' }],
  ]) {
    const res = await fetchImpl(base + path, init);
    assert.equal(res.status, 503, path);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    await noHtml(res);
    assert.deepEqual(await res.json(), { error: 'setup_required' });
  }

  for (const [path, init] of [
    ['/media/audio/fixture-song.mp3', { headers: { range: 'bytes=0-3' } }],
    ['/media/audio/fixture-song.mp3', { method: 'HEAD' }],
    ['/media/audio%2ffixture-song.mp3', undefined],
    ['/media/%5c..', undefined],
    ['/media/audio/missing.mp3', undefined],
    ['/media/audio/fixture-song.mp3', { method: 'POST' }],
  ]) {
    const res = await fetchImpl(base + path, init);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal((await res.arrayBuffer()).byteLength, 0, 'denied media must have an empty body: ' + path);
  }
  for (const path of ['/_worker.js', '/_worker.js.map', '/wrangler.toml', '/.dev.vars', '/schema.sql']) { const res = await fetchImpl(base + path); assert.equal(res.status, 404, path); await res.arrayBuffer(); }
  const missingJs = await fetchImpl(base + '/missing-preview.js'); assert.equal(missingJs.status, 404); await missingJs.arrayBuffer();
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) verifyWorkerHttp(process.argv[2]).then(() => console.log('worker HTTP smoke: PASS'));
