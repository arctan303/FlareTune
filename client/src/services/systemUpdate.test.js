import test from 'node:test';
import assert from 'node:assert/strict';
import { systemUpdateRequest, systemUpdateErrorMessage, recheckSystemUpdateStatus, SYSTEM_UPDATE_STATUS_EVENT } from './systemUpdate.js';

const admin = { authenticated: true, csrfToken: 'csrf-fixture', user: { role: 'admin', accountId: 'admin-fixture' } };
test('system update writes bind the authenticated administrator and preserve request cancellation', async () => {
  const calls = [], controller = new AbortController();
  const result = await systemUpdateRequest(admin, '/start', { method: 'POST', body: { revision: 3, releaseId: 'release-fixture' },
    signal: controller.signal, fetchImpl: async (url, init) => {
      calls.push({ url, init }); return new Response(JSON.stringify({ revision: 4, job: { status: 'queued' } }));
    } });
  assert.equal(result.revision, 4);
  assert.equal(calls[0].url, '/api/admin/system-update/start');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['X-CSRF-Token'], admin.csrfToken);
  assert.equal(calls[0].init.headers['X-FlareTune-Expected-Account'], admin.user.accountId);
  assert.equal(calls[0].init.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), { revision: 3, releaseId: 'release-fixture' });
});

test('members and anonymous clients never send system update requests', async () => {
  let calls = 0;
  for (const owner of [null, { authenticated: false }, { ...admin, user: { ...admin.user, role: 'member' } },
    { ...admin, mustChangePassword: true }]) {
    await assert.rejects(systemUpdateRequest(owner, '/check', { fetchImpl: async () => { calls++; } }), error => error.status === 403);
  }
  assert.equal(calls, 0);
});

test('unsafe upstream errors are mapped to useful messages without leaking raw contents', () => {
  assert.equal(systemUpdateErrorMessage({ code: 'SYSTEM_UPDATE_PLUGIN_PENDING' }), '请先完成或撤销待应用的插件变更。');
  assert.equal(systemUpdateErrorMessage({ code: 'SYSTEM_UPDATE_RESULT_UNKNOWN' }), '新版本的部署结果尚未确认，请继续核实同一任务。');
  assert.equal(systemUpdateErrorMessage({ code: 'untrusted raw secret fixture' }), '系统更新未完成，请刷新核实状态。');
});

test('only confirmed system update maintenance requests a gate refresh', async () => {
  const events = [], target = { dispatchEvent: event => events.push(event.type) };
  for (const body of [{ state: 'ready' }, { state: 'maintenance', reason: 'migration_pending' },
    { state: 'maintenance', reason: 'untrusted' }, { state: 'recovery_required', reason: 'system_update_running' }]) {
    assert.equal(await recheckSystemUpdateStatus({ target, fetchImpl: async () => new Response(JSON.stringify(body)) }), false);
  }
  assert.deepEqual(events, []);
  const urls = [];
  assert.equal(await recheckSystemUpdateStatus({ target, fetchImpl: async url => {
    urls.push(url); return new Response(JSON.stringify({ state: 'maintenance', reason: 'system_update_running' }));
  } }), true);
  assert.deepEqual(urls, ['/api/instance/status']); assert.deepEqual(events, [SYSTEM_UPDATE_STATUS_EVENT]);
});

test('failed, aborted or stale account checks never emit a maintenance event', async () => {
  const events = [], target = { dispatchEvent: event => events.push(event.type) };
  assert.equal(await recheckSystemUpdateStatus({ target, fetchImpl: async () => { throw Error('offline'); } }), false);
  for (const mode of ['aborted', 'stale']) {
    let resolve, current = true; const controller = new AbortController();
    const request = recheckSystemUpdateStatus({ target, signal: controller.signal, isCurrent: () => current,
      fetchImpl: async () => new Promise(done => { resolve = done; }) });
    if (mode === 'aborted') controller.abort(); else current = false;
    resolve(new Response(JSON.stringify({ state: 'maintenance', reason: 'system_update_running' })));
    assert.equal(await request, false);
  }
  assert.deepEqual(events, []);
});
