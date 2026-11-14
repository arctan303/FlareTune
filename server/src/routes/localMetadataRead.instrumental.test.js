import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';

test('the real instrumental lyrics HTTP route returns not_needed without touching lyric storage or providers', async t => {
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
  assert.deepEqual(calls, { get: 0, head: 0, put: 0, provider: 0 });
});
