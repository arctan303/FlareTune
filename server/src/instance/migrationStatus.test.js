import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';
import { HOTPATH_OBJECTS } from './hotpathSchema.js';

test('old v2 reports the hotpath supplement and controlled upgrade backfills without changing base ledger', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.sqlite.prepare(`INSERT INTO Member_Play_Events(account_id,event_id,song_id,played_at,received_at)
      VALUES (?, 'retained', 's1', ?, ?)`).run(f.owner,now,now);
    const ledger = f.sqlite.prepare('SELECT * FROM ft_migrations ORDER BY version').all();
    for (const name of [...HOTPATH_OBJECTS].reverse()) {
      const type = f.sqlite.prepare('SELECT type FROM sqlite_master WHERE name=?').get(name).type;
      f.sqlite.exec(`DROP ${type} ${name}`);
    }
    const before = await (await f.api('admin/system/migration')).json();
    assert.equal(before.schemaVersion,2);
    assert.deepEqual(before.supplementalMigrations.filter(r=>!r.ready),[{id:'hotpath_counts',ready:false}]);
    assert.equal((await f.api('admin/system/migration','POST',{})).status,200);
    const after = await (await f.api('admin/system/migration')).json();
    assert.equal(after.supplementalPending,false);
    assert.equal(after.schemaVersion,2);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM ft_migrations ORDER BY version').all(),ledger);
    assert.equal(f.sqlite.prepare('SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id=?')
      .get(f.owner).receipt_count,1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_Play_Events').get().n,1);
    assert.equal((await f.api('admin/system/migration','POST',{})).status,200);
    assert.equal(f.sqlite.prepare('SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id=?')
      .get(f.owner).receipt_count,1);
  } finally { f.close(); }
});

test('admin migration status explains pending v2 supplements and reports completion after upgrade without a base version change', async () => {
  const f = await fixture();
  try {
    const get = async () => (await f.api('admin/system/migration')).json();
    const initial = await get();
    assert.equal(initial.supplementalPending, false);
    assert.equal(initial.supplementalMigrations.length, 5);
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
