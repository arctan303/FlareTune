import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginsRequest } from './plugins.js';

test('plugin lists and installation use session-bound authenticated routes with revision and CSRF checks', async () => {
  const calls = [], session = { user: { accountId: 'A' }, csrfToken: 'csrf-A' }, signal = new AbortController().signal;
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return Response.json({ plugins: [] }); };
  await pluginsRequest(session, { fetchImpl, signal });
  await pluginsRequest(session, { admin: true, fetchImpl, signal });
  await pluginsRequest(session, { id: 'xiaomi-speaker', installed: true, revision: 4, fetchImpl, signal });
  assert.deepEqual(calls.map(call => call.url), ['/api/account/plugins', '/api/admin/plugins', '/api/admin/plugins/xiaomi-speaker']);
  assert.equal(calls[2].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[2].init.body), { installed: true, revision: 4 });
  for (const { init } of calls) { assert.equal(init.signal, signal); assert.equal(init.headers['X-FlareTune-Expected-Account'], 'A'); }
  assert.equal(calls[2].init.headers['X-CSRF-Token'], 'csrf-A');
});
