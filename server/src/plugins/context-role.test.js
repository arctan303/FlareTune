import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';
import { createPluginRegistry } from './registry.js';
import { createPluginContext } from './context.js';

const base = extra => ({ id: 'role-race', version: '1.0.0', hostApiVersion: 2, apiVersion: 1, dataVersion: 0,
  name: 'Role race', description: 'Synthetic storage role fixture', icon: 'box', pages: [], entries: [], ...extra });
const legacyPage = access => ({ id: 'settings', kind: 'settings', scope: 'account', access, label: 'Settings', icon: 'box' });
async function app(t, manifest, member = false) {
  const f = await fixture(); t.after(f.close);
  const registry = createPluginRegistry({ manifests: [manifest], deployment: null });
  await registry.setInstalled(f.env, f.signed.session, manifest.id, { installed: true, revision: 0 });
  const session = member ? (await f.signIn('member')).session : f.signed.session;
  const context = await createPluginContext({ env: f.env, session, pluginId: manifest.id, registry });
  return { ...f, registry, context, session };
}
function interveneAtCommit(f, role) {
  let interventions = 0;
  f.db.beforeWrite = sql => {
    if (!sql.startsWith('INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)') || !sql.includes('$.epoch')) return;
    f.db.beforeWrite = null; interventions++;
    f.sqlite.prepare('UPDATE accounts SET role=? WHERE account_id=?').run(role, f.session.account.accountId);
  };
  return () => assert.equal(interventions, 1, 'role changed after every asynchronous preflight and immediately before SQLite executed the write');
}
const storedRows = f => f.sqlite.prepare("SELECT value_json,revision FROM instance_settings WHERE key LIKE 'plugin.data.role-race.account.%'").all();

for (const [label, manifest] of [
  ['capabilityRoles', base({ capabilityRoles: ['admin'] })],
  ['legacy admin access', base({ pages: [legacyPage('admin')] })],
]) {
  for (const existing of [false, true]) test(`account storage ${existing ? 'update' : 'create'} rejects commit-time demotion for ${label}`, async t => {
    const f = await app(t, manifest);
    if (existing) await f.context.storage.set('account', 'preferences', { saved: true }, { revision: 0 });
    const before = storedRows(f), verify = interveneAtCommit(f, 'member');
    await assert.rejects(f.context.storage.set('account', 'preferences', { saved: false }, { revision: existing ? 1 : 0 }), { code: 'forbidden' });
    verify(); assert.deepEqual(storedRows(f), before);
  });
}

test('member-only account storage rejects a commit-time role change to administrator', async t => {
  const f = await app(t, base({ capabilityRoles: ['member'] }), true);
  const verify = interveneAtCommit(f, 'admin');
  await assert.rejects(f.context.storage.set('account', 'preferences', {}, { revision: 0 }), { code: 'forbidden' });
  verify(); assert.deepEqual(storedRows(f), []);
});

for (const [label, manifest] of [
  ['legacy authenticated access', base({ pages: [legacyPage('authenticated')] })],
  ['capability and declared-page role union', base({ capabilityRoles: ['admin'], pages: [
    { id: 'member', kind: 'service', roles: ['member'], label: 'Member', icon: 'box' },
  ] })],
]) test(`account storage preserves ${label} when the new role remains permitted`, async t => {
  const f = await app(t, manifest), verify = interveneAtCommit(f, 'member');
  assert.deepEqual(await f.context.storage.set('account', 'preferences', { saved: true }, { revision: 0 }), { value: { saved: true }, revision: 1 });
  verify(); assert.equal(storedRows(f).length, 1);
});
