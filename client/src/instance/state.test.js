import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInstanceStatus, normalizeSession, screenFor, toShellAuthSession, validLocalPassword } from './state.js';

const user = { accountId: 'account-a', username: 'owner', displayName: 'Owner', role: 'admin' };

test('instance state only opens app after ready and normal authenticated session', () => {
  const ready = normalizeInstanceStatus({ state: 'ready' });
  assert.equal(screenFor(ready, null), 'unavailable');
  assert.equal(screenFor(ready, normalizeSession(null)), 'login');
  assert.equal(screenFor(ready, normalizeSession({ authenticated: true, mustChangePassword: true, user })), 'change_password');
  assert.equal(screenFor(ready, normalizeSession({ authenticated: true, mustChangePassword: false, user })), 'app');
  for (const state of ['setup_required', 'maintenance', 'recovery_required']) {
    assert.notEqual(screenFor(normalizeInstanceStatus({ state }), normalizeSession({ authenticated: true, user })), 'app');
  }
  assert.equal(screenFor(normalizeInstanceStatus({ state: 'recovery_required' }), normalizeSession(null)), 'instance_error');
  assert.equal(screenFor(normalizeInstanceStatus({ state: 'unknown' }), normalizeSession({ authenticated: true, user })), 'unavailable');
  assert.equal(screenFor(ready, normalizeSession({ authenticated: true })), 'login');
});

test('validated local account maps into shell auth without OAuth fields', () => {
  const session = normalizeSession({ authenticated: true, mustChangePassword: false, user, csrfToken: 'csrf' });
  assert.deepEqual(toShellAuthSession(session), { authenticated: true, user, initialized: true, csrfToken: 'csrf', error: null });
  assert.equal(toShellAuthSession(normalizeSession({ authenticated: true, mustChangePassword: true, user })).authenticated, false);
});

test('password rule uses Unicode code points and UTF-8 byte limit', () => {
  assert.equal(validLocalPassword('a'.repeat(7)), false);
  assert.equal(validLocalPassword('a'.repeat(8)), true);
  assert.equal(validLocalPassword('🔒'.repeat(7)), false);
  assert.equal(validLocalPassword('🔒'.repeat(8)), true);
  assert.equal(validLocalPassword('🔒'.repeat(257)), false);
});
