import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';
import { buildReadyLyricArtifact } from '../services/lyricAssetWorkflow.js';

test('the real instrumental lyrics HTTP route checks for a processed file before skipping providers', async t => {
  const f = await fixture(); t.after(f.close);
  f.sqlite.prepare("UPDATE Songs SET language='instrumental' WHERE id='s1'").run();
  const calls = { get: 0, head: 0, put: 0, provider: 0 };
  for (const method of ['get', 'head', 'put']) {
    const original = f.env.MEDIA_BUCKET[method].bind(f.env.MEDIA_BUCKET);
    f.env.MEDIA_BUCKET[method] = (...args) => { calls[method]++; return original(...args); };
  }
  t.mock.method(globalThis, 'fetch', async () => { calls.provider++; throw Error('An instrumental song has no lyric-provider request'); });
  const response = await f.api('lyrics?songId=s1');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.reason, 'instrumental');
  assert.equal(body.data.translation.state, 'not_needed');
  assert.deepEqual(body.data.lines, []);
  assert.deepEqual(calls, { get: 1, head: 0, put: 0, provider: 0 });
});

test('the real lyrics HTTP route returns a processed file and its translation before an older instrumental tag', async t => {
  const f = await fixture(); t.after(f.close);
  const song = f.sqlite.prepare("SELECT * FROM Songs WHERE id='s1'").get();
  const artifact = (await buildReadyLyricArtifact({ ...song, language: 'en' }, { source: 'manual', format: 'lrc',
    lines: [{ time: 1, text: 'We sing beneath the summer sky' }] })).artifact;
  artifact.translation = { source: 'manual', language: 'zh', originalTextHash: artifact.textHash,
    lines: ['我们在夏日的天空下歌唱'], updatedAt: artifact.updatedAt };
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  f.objects.set('media/lyrics/s1.json', { bytes, type: 'application/json' });
  f.sqlite.prepare("UPDATE Songs SET language='instrumental' WHERE id='s1'").run();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('a processed file needs no provider or model'));
  const response = await f.api('lyrics?songId=s1');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.lines[0].text, artifact.original.lines[0].text);
  assert.equal(body.data.translation.state, 'ready');
  assert.deepEqual(body.data.translation.lines, artifact.translation.lines);
  assert.deepEqual(f.objects.get('media/lyrics/s1.json').bytes, bytes);
});
