import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';

test('admin migration status explains pending v2 supplements and reports completion after upgrade without a base version change', async () => {
  const f = await fixture();
  try {
    const get = async () => (await f.api('admin/system/migration')).json();
    const initial = await get();
    assert.equal(initial.supplementalPending, false);
    assert.equal(initial.supplementalMigrations.length, 4);
    assert.ok(initial.supplementalMigrations.every(item => item.ready));
    f.sqlite.exec('DROP TRIGGER google_credentials_changed; DROP TRIGGER google_account_changed; DROP TABLE google_login_transactions; DROP TABLE account_google_bindings; DROP TABLE google_login_config');
    const before = await get();
    assert.equal(before.schemaVersion, 2);
    assert.equal(before.targetVersion, 2);
    assert.equal(before.supplementalPending, true);
    assert.deepEqual(before.supplementalMigrations.filter(item => !item.ready), [{ id: 'google_login', ready: false }]);
    const upgraded = await f.api('admin/system/migration', 'POST', {});
    assert.equal(upgraded.status, 200);
    const after = await get();
    assert.equal(after.schemaVersion, before.schemaVersion);
    assert.equal(after.supplementalPending, false);
    assert.ok(after.supplementalMigrations.every(item => item.ready));
    const member = await f.signIn('member');
    assert.equal((await f.api('admin/system/migration', 'GET', undefined, member)).status, 403);
    assert.equal((await f.api('admin/system/migration', 'GET', undefined, { cookie: '', session: {} })).status, 401);
  } finally { f.close(); }
});
