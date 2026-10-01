import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAdminMigrationStatus, getInstanceStatus, getSession, instanceRequest, InstanceApiError, login, messageForError, setupInstance, verifySetupSecret } from './api.js';

const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('all instance requests stay on same-origin API and never put secrets into URL', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return respond({ ok: true }); };
  await verifySetupSecret({ setupSecret: 'private-value' }, fetchImpl);
  await setupInstance({ proof: 'signed-proof', username: 'admin', password: 'long-password' }, fetchImpl);
  await login({ username: 'admin', password: 'long-password' }, fetchImpl);
  assert.equal(calls[0][0], '/api/auth/verify-setup');
  assert.equal(calls[1][0], '/api/auth/setup');
  assert.equal(calls[2][0], '/api/auth/login');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].headers['X-Requested-With'], 'FlareTune');
  assert.equal(calls[0][1].headers['X-CSRF-Token'], undefined);
  assert.match(calls[0][1].body, /private-value/);
  assert.doesNotMatch(calls[0][0], /private-value/);
  assert.doesNotMatch(calls[1][1].body, /private-value/);
});

test('authenticated mutation sends session CSRF token', async () => {
  const calls = [];
  await instanceRequest('auth/change-password', {
    method: 'POST', body: { currentPassword: 'old', newPassword: 'new' }, csrfToken: 'csrf-value',
    fetchImpl: async (...args) => { calls.push(args); return respond({ ok: true }); },
  });
  assert.equal(calls[0][1].headers['X-CSRF-Token'], 'csrf-value');
});

test('status and session responses fail closed', async () => {
  assert.deepEqual(await getInstanceStatus(async () => respond({ state: 'surprise' })), { state: 'unavailable' });
  assert.equal((await getSession(async () => respond({ authenticated: false }))).authenticated, false);
  assert.equal((await getSession(async () => respond({ error: 'not_authenticated' }, 401))).authenticated, false);
  await assert.rejects(() => getSession(async () => respond({ error: 'database_unavailable' }, 503)), InstanceApiError);
});

test('private migration status preserves same-version supplemental upgrades', async () => {
  const status = await getAdminMigrationStatus('csrf', async (url, init) => {
    assert.equal(url, '/api/admin/system/migration');
    assert.equal(init.credentials, 'same-origin');
    return respond({ schemaVersion: 2, targetVersion: 2, state: 'ready', supplementalPending: true });
  });
  assert.equal(status.supplementalPending, true);
});

test('error copy avoids exposing server details or credential existence', () => {
  assert.equal(messageForError(new InstanceApiError(401, 'secret_wrong'), 'verify_setup'), '初始化密钥无效或已过期，请检查后重试。');
  assert.equal(messageForError(new InstanceApiError(401, 'account_unknown'), 'login'), '用户名或密码不正确。');
  assert.equal(messageForError(new InstanceApiError(429, 'internal_threshold'), 'login'), '尝试次数较多，请稍后再试。');
});

test('entry statically loads only gate and lazily imports business app', () => {
  const entry = readFileSync(new URL('../entry.jsx', import.meta.url), 'utf8');
  assert.match(entry, /import InstanceGate from '\.\/instance\/InstanceGate\.jsx'/);
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/app\.jsx'\)\)/);
  assert.doesNotMatch(entry, /import App from '\.\/app\.jsx'/);
});
