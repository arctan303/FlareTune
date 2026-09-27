import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const noHtml = async (res) => assert.doesNotMatch((await res.clone().text()).toLowerCase(), /<!doctype html|<html/);
export async function verifyWorkerHttp(base = 'http://127.0.0.1:8790') {
  const homeResponse = await fetch(base + '/');
  assert.equal(homeResponse.status, 200);
  assert.match(homeResponse.headers.get('content-type') || '', /text\/html/);
  const homeHtml = await homeResponse.text();
  const scriptPath = homeHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]; const cssPath = homeHtml.match(/<link[^>]+href="([^"]+\.css)"/)?.[1]; assert.ok(scriptPath); assert.ok(cssPath);
  assert.match((await fetch(new URL(scriptPath, base))).headers.get('content-type') || '', /javascript/); assert.match((await fetch(new URL(cssPath, base))).headers.get('content-type') || '', /text\/css/);
  const status = await fetch(base + '/api/instance/status');
  assert.equal(status.status, 200);
  assert.match(status.headers.get('content-type') || '', /application\/json/);
  assert.equal(status.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await status.json(), { state: 'setup_required' });

  for (const [path, init] of [
    ['/api/init', undefined],
    ['/api/__preview_missing__', undefined],
    ['/auth/start', { redirect: 'manual' }],
    ['/api/account/playlists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ]) {
    const res = await fetch(base + path, init);
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
    const res = await fetch(base + path, init);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
  for (const path of ['/_worker.js', '/_worker.js.map', '/wrangler.toml', '/.dev.vars', '/schema.sql']) { const res = await fetch(base + path); assert.equal(res.status, 404, path); }
  const missingJs = await fetch(base + '/missing-preview.js'); assert.equal(missingJs.status, 404);
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) verifyWorkerHttp(process.argv[2]).then(() => console.log('worker HTTP smoke: PASS'));
