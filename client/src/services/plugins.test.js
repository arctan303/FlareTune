import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginsRequest } from './plugins.js';
import { pluginDeliveryRequest } from './pluginDelivery.js';
import { getLocale, setUiLanguage } from '../i18n/index.js';

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
  assert.equal(calls[2].init.headers['Accept-Language'], getLocale());
});

test('installation and build selection send the current UI language without changing request-body contracts', async t => {
  await setUiLanguage('ja', { load: async () => ({ default: {} }) });
  t.after(() => setUiLanguage('en'));
  const session = { authenticated: true, user: { accountId: 'A', role: 'admin' }, csrfToken: 'csrf-A' }, calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return Response.json({}); };
  await pluginsRequest(session, { id: 'youtube-music', installed: true, revision: 2, fetchImpl });
  await pluginDeliveryRequest(session, '/selection', { method: 'PUT',
    body: { pluginId: 'lyrics-workbench', installed: true, revision: 3 }, fetchImpl });
  for (const { init } of calls) {
    assert.equal(init.headers['Accept-Language'], 'ja');
    assert.equal(init.headers['X-CSRF-Token'], 'csrf-A');
    assert.equal(init.headers['X-FlareTune-Expected-Account'], 'A');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(Object.hasOwn(JSON.parse(init.body), 'uiLanguage'), false, 'language is request metadata, not an unrecognized mutation body field');
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { installed: true, revision: 2 });
  assert.deepEqual(JSON.parse(calls[1].init.body), { pluginId: 'lyrics-workbench', installed: true, revision: 3 });
});
