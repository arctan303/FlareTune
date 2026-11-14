import test from 'node:test';
import assert from 'node:assert/strict';
import { systemUpdateRequestGate } from './gate.js';

const gate = (path, options = {}, method = 'GET') => systemUpdateRequestGate(new Request('https://tune.example.com' + path, { method }), path, {}, {}, {
  maintenanceImpl: async () => true,
  handleApiImpl: async () => Response.json({ state: 'ready', schemaVersion: 2, targetVersion: 2 }), ...options,
});

test('system update short maintenance closes normal APIs and every media protocol', async () => {
  for (const path of ['/api/songs', '/api/auth/login', '/auth/google/callback', '/media/song.mp3', '/rest/stream.view', '/speaker-media/key']) {
    const response = await gate(path);
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: 'maintenance', reason: 'system_update_running' });
  }
  assert.equal((await gate('/api/admin/instance', {}, 'POST')).status, 503);
});

test('maintenance admits only exact ordinary authentication methods for administrator recovery', async () => {
  assert.equal(await gate('/api/auth/session'), null);
  assert.equal(await gate('/api/auth/login', {}, 'POST'), null);
  assert.equal(await gate('/api/auth/logout', {}, 'POST'), null);
  for (const [path, method] of [['/api/auth/session', 'POST'], ['/api/auth/login', 'PUT'], ['/api/auth/logout', 'GET'],
    ['/api/auth/change-password', 'POST'], ['/api/auth/google/start', 'POST'], ['/api/auth/login/extra', 'POST']]) {
    assert.equal((await gate(path, {}, method)).status, 503, `${method} ${path}`);
  }
});
test('static maintenance shell and purpose-limited pipeline are not blocked by the business gate', async () => {
  const options = { maintenanceImpl: async () => { throw Error('must not query'); } };
  for (const path of ['/', '/settings/admin/instance', '/assets/main.js', '/api', '/auth', '/api/system-update/plan', '/api/system-update/migration', '/api/admin/system-update/retry']) {
    assert.equal(await gate(path, options), null, path);
  }
});
test('status preserves actual schema and marks only known update maintenance', async () => {
  const result = await gate('/api/instance/status');
  assert.deepEqual(await result.json(), { state: 'maintenance', reason: 'system_update_running', schemaVersion: 2, targetVersion: 2 });
  const broken = await gate('/api/instance/status', { handleApiImpl: async () => Response.json({ state: 'recovery_required', schemaVersion: 9, targetVersion: 2 }, { status: 503 }) });
  assert.deepEqual(await broken.json(), { state: 'recovery_required', schemaVersion: 9, targetVersion: 2 });
});
test('healthy instances keep ordinary behavior and do not synthesize a migration', async () => {
  assert.equal(await gate('/api/songs', { maintenanceImpl: async () => false }), null);
  assert.equal(await gate('/media/song.mp3', { maintenanceImpl: async () => false }), null);
});
