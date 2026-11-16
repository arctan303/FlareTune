import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, PASSWORD } from '../subsonic/test-support.js';

function pauseUpdate(f) {
  const job = { taskId: crypto.randomUUID(), status: 'activation_pending', receipt: { migrationStarted: true } };
  f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES ('system.update.v1',?,1,?,'test')`).run(JSON.stringify({ schemaVersion: 1, job }), Date.now());
}

test('interrupted update keeps normal authentication and administrator recovery while business stays closed', async t => {
  const f = await fixture(); t.after(() => f.close()); pauseUpdate(f);
  const anon = { cookie: '', session: { csrfToken: '' } }, member = await f.signIn('member');
  assert.equal((await (await f.api('instance/status')).json()).reason, 'system_update_running');
  assert.equal((await (await f.api('auth/session')).json()).user.role, 'admin');
  assert.equal((await (await f.api('auth/session', 'GET', undefined, member)).json()).user.role, 'member');
  assert.equal((await (await f.api('auth/session', 'GET', undefined, anon)).json()).authenticated, false);
  assert.equal((await f.api('admin/system-update', 'GET', undefined, anon)).status, 401);
  assert.equal((await f.api('admin/system-update', 'GET', undefined, member)).status, 403);
  assert.equal((await f.api('auth/login', 'POST', { username: 'owner', password: PASSWORD }, anon, { Origin: 'https://other.example' })).status, 403);
  const logged = await f.api('auth/login', 'POST', { username: 'owner', password: PASSWORD }, anon);
  assert.equal(logged.status, 200); assert.match(logged.headers.get('Set-Cookie'), /HttpOnly/i);
  assert.equal((await f.api('auth/logout', 'POST', {}, f.signed, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.api('auth/logout', 'POST', {})).status, 200);
  for (const path of ['init', 'songs', 'account/profile', 'admin/accounts', 'auth/google/status']) {
    assert.equal((await f.api(path)).status, 503, path);
  }
  assert.equal((await f.rest('ping')).status, 503);
  assert.equal(f.mediaReads(), 0);
});

test('maintenance reason never authorizes login or admin access to an unknown raw schema', async t => {
  const f = await fixture(); t.after(() => f.close()); pauseUpdate(f);
  f.sqlite.exec('UPDATE ft_instance SET schema_version=999 WHERE id=1');
  assert.equal((await (await f.api('instance/status')).json()).state, 'recovery_required');
  assert.equal((await (await f.api('auth/session')).json()).authenticated, false);
  assert.equal((await f.api('auth/login', 'POST', { username: 'owner', password: PASSWORD })).status, 503);
  assert.equal((await f.api('admin/system-update')).status, 503);
  assert.equal((await f.api('songs')).status, 503);
});
