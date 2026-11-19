import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonTaskResponse, deferredJsonTaskResponse } from './jsonTaskResponse.js';
import { createPluginTransport } from '../../../client/src/plugins/transport.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('heartbeats keep the response open and the final body is ordinary JSON', async () => {
  const done = deferred();
  const response = jsonTaskResponse(() => done.promise, { heartbeatMs: 2 });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let body = decoder.decode((await reader.read()).value);
  body += decoder.decode((await reader.read()).value);
  assert.equal(body.trim(), '');
  done.resolve({ code: 200, data: { title: 'completed' } });
  while (true) { const row = await reader.read(); if (row.done) break; body += decoder.decode(row.value); }
  assert.deepEqual(JSON.parse(body), { code: 200, data: { title: 'completed' } });
});
test('ordinary results keep their real HTTP status without starting a stream', async () => {
  const response = await deferredJsonTaskResponse(async () => new Response('{"code":404}', { status: 404 }));
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { code: 404 });
});
test('an adopted AI task is held until completion rather than only waitUntil', async () => {
  const done = deferred();
  const response = await deferredJsonTaskResponse(async ({ onStart }) => { onStart(); await done.promise; return new Response('{"code":200,"data":"saved"}'); });
  const reader = response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value).trim(), '');
  done.resolve(); let text = ''; while (true) { const row = await reader.read(); if (row.done) break; text += new TextDecoder().decode(row.value); }
  assert.deepEqual(JSON.parse(text), { code: 200, data: 'saved' });
});
test('cancelling the body aborts the one running task', async () => {
  const done = deferred(); let signal;
  const response = jsonTaskResponse(async value => { signal = value; await done.promise; return { code: 200 }; });
  await Promise.resolve(); await response.body.cancel(); assert.equal(signal.aborted, true); done.resolve();
});
test('the plugin transport rejects late JSON errors even after HTTP headers were sent', async () => {
  const transport = createPluginTransport({ pluginId: 'lyrics-workbench', session: { user: { role: 'member', accountId: 'a' } },
    isCurrent: () => true, sessionStore: {}, pluginStore: {},
    fetchImpl: async () => jsonTaskResponse(async () => new Response('{"ok":false,"code":409,"error":"LYRIC_ASSET_CONFLICT"}', { status: 409 })) });
  await assert.rejects(transport.json('workspace/song'), error => error.status === 409 && error.code === 'LYRIC_ASSET_CONFLICT');
});
