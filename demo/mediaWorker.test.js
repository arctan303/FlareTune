import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './mediaWorker.js';
import catalog from './catalog.json' with { type: 'json' };
const song = catalog[0];
const bytes = Uint8Array.from({ length: song.bytes }, (_, index) => index % 251);
let calls;
const env = { ASSETS: { fetch: async request => { calls.push(request); return new Response(bytes); } } };
const request = (headers = {}, method = 'GET', path = song.audio_url) => new Request(`https://demo.example.com${path}`, { method, headers });
test('demo media returns exact full, bounded, open and suffix bytes; HEAD is metadata-only', async () => {
  calls = [];
  const head = await worker.fetch(request({}, 'HEAD'), env);
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(song.bytes)); assert.equal(calls.length, 0);
  for (const [range, first, last] of [['bytes=100-199',100,199], ['bytes=100-',100,song.bytes-1], ['bytes=-20',song.bytes-20,song.bytes-1], ['bytes=0-99999999',0,song.bytes-1]]) {
    const response = await worker.fetch(request({ Range: range, Cookie: 'private', Authorization: 'private' }), env);
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), `bytes ${first}-${last}/${song.bytes}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(first, last+1));
    assert.equal(calls.at(-1).headers.get('Cookie'), null); assert.equal(calls.at(-1).headers.get('Range'), null);
  }
  const whole = await worker.fetch(request({Range:'bytes=1-2','If-Range':'"stale"'}), env);
  assert.equal(whole.status,200); assert.equal((await whole.arrayBuffer()).byteLength,song.bytes);
});
test('demo rejects invalid ranges, unknown media and writes; supports revalidation', async () => {
  calls = [];
  for (const range of ['bytes=99999999-', 'bytes=-0', 'bytes=2-1', 'bytes=0-1,4-5', 'bad']) {
    const response = await worker.fetch(request({Range:range}),env); assert.equal(response.status,416); assert.equal(response.headers.get('Content-Range'),`bytes */${song.bytes}`);
  }
  assert.equal((await worker.fetch(request({},'POST'),env)).status,405);
  assert.equal((await worker.fetch(request({},'GET','/media/missing.mp3'),env)).status,404);
  assert.equal((await worker.fetch(request({'If-None-Match':`"${song.sha256}"`}),env)).status,304);
  assert.equal(calls.length,0);
});

test('matching cache validators precede valid and unsatisfiable ranges for GET and HEAD', async () => {
  const etag = `"${song.sha256}"`;
  for (const method of ['GET', 'HEAD']) {
    for (const validator of [etag, `W/${etag}`, `"stale", W/${etag}`, '*']) {
      for (const range of [undefined, 'bytes=0-99', 'bytes=99999999-']) {
        calls = [];
        const headers = { 'If-None-Match': validator, ...(range ? { Range: range } : {}) };
        const response = await worker.fetch(request(headers, method), env);
        assert.equal(response.status, 304, `${method} ${validator} ${range || ''}`);
        assert.equal(response.headers.get('ETag'), etag);
        assert.equal(response.headers.get('Content-Range'), null);
        assert.equal(await response.text(), '');
        assert.equal(calls.length, 0, 'cache hit must not read packaged audio');
      }
    }
  }
});

test('nonmatching validators preserve ordinary full, range and HEAD responses', async () => {
  for (const [method, range, status] of [['GET', undefined, 200], ['GET', 'bytes=100-199', 206], ['HEAD', 'bytes=100-199', 200]]) {
    calls = [];
    const response = await worker.fetch(request({ 'If-None-Match': 'W/"stale"', ...(range ? { Range: range } : {}) }, method), env);
    assert.equal(response.status, status);
    assert.equal((await response.arrayBuffer()).byteLength, method === 'HEAD' ? 0 : range ? 100 : song.bytes);
    assert.equal(calls.length, method === 'HEAD' ? 0 : 1);
  }
});
