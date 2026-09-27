import assert from 'node:assert/strict';
import test from 'node:test';
import { decideApiAccess } from './accessPolicy.js';
import { handleApi } from './httpRouter.js';

const request = (path, method, instanceState, session) => decideApiAccess({ path, method, instanceState, session });
const member = { mode: 'normal', account: { role: 'member' } };
const admin = { mode: 'normal', account: { role: 'admin' } };
const limited = { mode: 'must_change_password', account: { role: 'admin' } };

test('instance status is public, setup is state-scoped, and recovery stays closed', () => {
  for (const state of ['setup_required', 'maintenance', 'recovery_required', 'ready']) {
    assert.equal(request('/api/instance/status', 'GET', state).allowed, true);
    assert.equal(request('/api/auth/setup', 'POST', state).allowed, state === 'setup_required');
    assert.equal(request('/api/auth/recovery', 'POST', state).allowed, false);
    assert.equal(request('/api/auth/recovery', 'POST', state, admin).allowed, false);
  }
});

test('removed recovery endpoint rejects before reading instance data', async () => {
  let prepareCalls = 0;
  const response = await handleApi(new Request('https://example.test/api/auth/recovery', { method: 'POST' }),
    { DB: { prepare() { prepareCalls += 1; throw new Error('database must not be read'); } } }, '/api/auth/recovery');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(prepareCalls, 0);
});

test('anonymous and restricted sessions cannot enter business or admin routes', () => {
  for (const path of ['/api/init', '/api/ai/chat', '/api/unknown-new-route', '/api/admin/accounts']) {
    assert.equal(request(path, 'GET', 'ready').allowed, false, path);
    assert.equal(request(path, 'GET', 'ready', limited).allowed, false, path);
  }
  assert.equal(request('/api/auth/change-password', 'POST', 'ready', limited).allowed, true);
  assert.equal(request('/api/auth/logout', 'POST', 'ready', limited).allowed, true);
  assert.equal(request('/api/auth/session', 'GET', 'ready', limited).allowed, true);
});

test('member and admin roles get distinct management access', () => {
  assert.equal(request('/api/songs/search', 'GET', 'ready', member).allowed, true);
  assert.equal(request('/api/admin/accounts', 'GET', 'ready', member).allowed, false);
  assert.equal(request('/api/admin/accounts', 'GET', 'ready', admin).allowed, true);
  assert.equal(request('/api/unknown-new-route', 'GET', 'ready', admin).allowed, true);
  assert.equal(request('/api/unknown-new-route', 'GET', 'maintenance', admin).allowed, false);
  assert.equal(request('/api/admin/system/migration', 'POST', 'ready', member).allowed, false);
  assert.equal(request('/api/admin/system/migration', 'POST', 'ready', admin).allowed, true);
  assert.equal(request('/api/admin/system/migration', 'POST', 'maintenance', member).allowed, false);
  assert.equal(request('/api/admin/system/migration', 'POST', 'maintenance', admin).allowed, false);
  assert.equal(request('/api/auth/login', 'POST', 'maintenance').allowed, false);
  assert.equal(request('/api/instance/upgrade', 'POST', 'maintenance', admin).allowed, true);
  assert.equal(request('/api/instance/upgrade', 'POST', 'recovery_required').allowed, false);
});
