import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';
import { createPluginRegistry, installationKey, REGISTRY_KEY } from './registry.js';
import { createPluginContext } from './context.js';
import { migrationChecksum, migrationKey, validateMigrationSql } from './migrations.js';
import { handlePluginApi } from '../routes/plugins.js';
import { HOST_PLUGIN_API_VERSION } from '../../../shared/plugins/manifest.js';

const manifest = (id, extra = {}) => ({ id, version: '1.2.0', hostApiVersion: 1, apiVersion: 1,
  name: id, description: 'Synthetic plugin', icon: 'box', pages: [], entries: [], capabilityRoles: ['admin', 'member'], ...extra });
const graph = () => [manifest('gateway'), manifest('assistant', { dependencies: { gateway: { apiVersion: 1, version: '^1.0.0' } } }),
  manifest('lyrics', { optionalDependencies: { gateway: { apiVersion: 1, features: ['ai'] } } })];
async function app(t) { const f = await fixture(); t.after(() => f.close()); return f; }
const change = async (registry, f, id, installed) => registry.setInstalled(f.env, f.signed.session, id,
  { installed, revision: (await registry.readInstallation(f.env, id)).revision });
const migration = async (version, statements) => ({ version, statements, checksum: await migrationChecksum(statements) });

test('generated module migrations initialize lazily once while explicit modules retain an immediate snapshot', async () => {
  const first = await migration(1, ['CREATE TABLE plugin_lazy__items (id TEXT PRIMARY KEY)']);
  const modules = { lazy: { migrations: [first] } };
  let reads = 0;
  const lazy = createPluginRegistry({ manifests: [manifest('lazy', { dataVersion: 1 })], modules: () => { reads++; return modules; } });
  assert.equal(reads, 0);
  const direct = createPluginRegistry({ manifests: [manifest('lazy', { dataVersion: 1 })], modules });
  modules.lazy.migrations.push(await migration(2, ['ALTER TABLE plugin_lazy__items ADD COLUMN title TEXT']));
  assert.equal(direct.getMigrations('lazy').length, 1);
  const snapshot = lazy.getMigrations('lazy');
  assert.equal(snapshot.length, 2); assert.equal(reads, 1);
  modules.lazy.migrations.length = 0;
  assert.equal(lazy.getMigrations('lazy'), snapshot); assert.equal(reads, 1);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot[0].statements));
});

test('account lists hide administrator dependencies while preserving only reachable installed dependency IDs', async t => {
  const f = await app(t);
  const adminPage = { id: 'settings', kind: 'settings', scope: 'instance', roles: ['admin'], label: 'Settings', icon: 'box' };
  const registry = createPluginRegistry({ manifests: [manifest('gateway', { capabilityRoles: ['admin'], pages: [adminPage] }),
    manifest('unrelated', { capabilityRoles: ['admin'], pages: [adminPage] }),
    manifest('consumer', { dependencies: { gateway: { apiVersion: 1 } } }),
    manifest('source', { capabilityRoles: ['admin', 'member'], pages: [adminPage] }),
    manifest('members', { capabilityRoles: ['member'], pages: [{ id: 'browse', kind: 'service', roles: ['member'], label: 'Members', icon: 'box' }] })] });
  for (const id of ['gateway', 'unrelated', 'consumer', 'source', 'members']) await change(registry, f, id, true);
  const member = (await f.signIn('member')).session;
  const result = await registry.listPlugins(f.env, member);
  assert.deepEqual(result.plugins.map(row => row.id), ['consumer', 'source', 'members']);
  assert.deepEqual(result.dependencyInstalledIds, ['gateway']);
  assert.equal(result.plugins.find(row => row.id === 'consumer').availability.available, true);
  assert.equal((await registry.listPlugins(f.env, f.signed.session, true)).plugins.length, 5);
  await assert.rejects(registry.listPlugins(f.env, member, true), { code: 'forbidden' });
  await assert.rejects(createPluginContext({ env: f.env, session: member, pluginId: 'gateway', registry }), { code: 'forbidden' });
  await assert.rejects(createPluginContext({ env: f.env, session: f.signed.session, pluginId: 'members', registry }), { code: 'forbidden' });
  const context = await createPluginContext({ env: f.env, session: member, pluginId: 'source', registry });
  await context.requireRoles(['member']);
  await assert.rejects(context.requireRoles(['admin']), { code: 'forbidden' });
  await assert.rejects(context.storage.get('instance', 'credentials'), { code: 'forbidden' });
});

test('generic member requests cannot invoke hidden administrator plugin handlers', async t => {
  const f = await app(t), member = (await f.signIn('member')).session;
  const registry = createPluginRegistry({ manifests: [manifest('private', { capabilityRoles: ['admin'], pages: [
    { id: 'settings', kind: 'settings', scope: 'instance', roles: ['admin'], label: 'Settings', icon: 'box' },
  ] })] });
  await change(registry, f, 'private', true);
  let called = false;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const path = '/api/account/plugins/private/keys';
  const response = await handlePluginApi(new Request('https://test.example' + path), path, f.env, member, json,
    { registry, handlers: { private() { called = true; return json({ secret: 'test only' }); } } });
  assert.equal(response.status, 403); assert.equal(called, false);
});

test('required dependencies are explicit and reverse dependents block uninstall; optional features stay independent', async t => {
  const f = await app(t); const registry = createPluginRegistry({ manifests: graph() });
  await assert.rejects(change(registry, f, 'assistant', true), { code: 'PLUGIN_DEPENDENCY_MISSING' });
  const lyrics = (await change(registry, f, 'lyrics', true)).plugin;
  assert.equal(lyrics.availability.available, true); assert.equal(lyrics.availability.optionalFeatures.ai.available, false);
  assert.equal((await registry.readInstallation(f.env, 'gateway')).installed, false, 'optional dependencies never install themselves');
  await change(registry, f, 'gateway', true); await change(registry, f, 'assistant', true);
  await assert.rejects(change(registry, f, 'gateway', false), error => {
    assert.equal(error.code, 'PLUGIN_REQUIRED_BY'); assert.deepEqual(error.publicDetails.dependents, ['assistant']); return true;
  });
  await change(registry, f, 'assistant', false); await change(registry, f, 'gateway', false);
  const current = (await registry.listPlugins(f.env, f.signed.session)).plugins;
  assert.deepEqual(current.map(plugin => plugin.id), ['lyrics']); assert.equal(current[0].availability.available, true);
  assert.equal(current[0].availability.optionalFeatures.ai.reason, 'dependency_not_installed');
});

test('missing packages, incompatible APIs/package versions, host APIs and cycles fail before installation', async t => {
  const f = await app(t);
  for (const [manifests, id, code] of [
    [[manifest('a', { dependencies: { missing: { apiVersion: 1 } } })], 'a', 'PLUGIN_DEPENDENCY_MISSING'],
    [[manifest('a', { dependencies: { b: { apiVersion: 2 } } }), manifest('b')], 'a', 'PLUGIN_DEPENDENCY_INCOMPATIBLE'],
    [[manifest('a', { dependencies: { b: { apiVersion: 1, version: '~2.0.0' } } }), manifest('b')], 'a', 'PLUGIN_DEPENDENCY_INCOMPATIBLE'],
    [[manifest('a', { hostApiVersion: HOST_PLUGIN_API_VERSION + 1 })], 'a', 'PLUGIN_HOST_INCOMPATIBLE'],
    [[manifest('a', { dependencies: { b: { apiVersion: 1 } } }), manifest('b', { dependencies: { a: { apiVersion: 1 } } })], 'a', 'PLUGIN_DEPENDENCY_CYCLE'],
  ]) await assert.rejects(change(createPluginRegistry({ manifests }), f, id, true), { code });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM instance_settings WHERE key LIKE ?').get('plugin.installation.%').n, 0);
});

test('consumer install racing dependency uninstall cannot commit a broken dependency graph', async t => {
  const f = await app(t); const registry = createPluginRegistry({ manifests: graph() });
  await change(registry, f, 'gateway', true);
  const results = await Promise.allSettled([change(registry, f, 'assistant', true), change(registry, f, 'gateway', false)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(['PLUGIN_REVISION_MISMATCH', 'PLUGIN_REQUIRED_BY', 'PLUGIN_DEPENDENCY_MISSING'].includes(results.find(result => result.status === 'rejected').reason.code));
  const gateway = await registry.readInstallation(f.env, 'gateway');
  const assistant = await registry.readInstallation(f.env, 'assistant');
  assert.ok(!assistant.installed || gateway.installed);
});

test('a newly compiled provider API cannot upgrade over incompatible installed consumers', async t => {
  const f = await app(t); const registry = createPluginRegistry({ manifests: graph() });
  await change(registry, f, 'gateway', true); await change(registry, f, 'assistant', true);
  const upgraded = createPluginRegistry({ manifests: graph().map(item => item.id === 'gateway' ? { ...item, version: '2.0.0', apiVersion: 2 } : item) });
  await assert.rejects(change(upgraded, f, 'gateway', true), { code: 'PLUGIN_DEPENDENCY_INCOMPATIBLE' });
});

test('migration batches record sequential checksums once, preserve data on uninstall and reject downgrade', async t => {
  const f = await app(t);
  const migrations = [await migration(1, ['CREATE TABLE plugin_sample__items (id TEXT PRIMARY KEY)']),
    await migration(2, ['ALTER TABLE plugin_sample__items ADD COLUMN label TEXT'])];
  const registry = createPluginRegistry({ manifests: [manifest('sample', { dataVersion: 2 })], modules: { sample: { migrations } } });
  await change(registry, f, 'sample', true);
  assert.deepEqual(f.sqlite.prepare('PRAGMA table_info(plugin_sample__items)').all().map(row => row.name), ['id', 'label']);
  const ledger = f.sqlite.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').get(migrationKey('sample'));
  assert.deepEqual(JSON.parse(ledger.value_json).completed, migrations.map(({ version, checksum }) => ({ version, checksum })));
  await change(registry, f, 'sample', true);
  assert.equal(f.sqlite.prepare('SELECT revision FROM instance_settings WHERE key=?').get(migrationKey('sample')).revision, ledger.revision);
  const firstEpoch = (await registry.readInstallation(f.env, 'sample')).epoch;
  await change(registry, f, 'sample', false); await change(registry, f, 'sample', true);
  assert.notEqual((await registry.readInstallation(f.env, 'sample')).epoch, firstEpoch);
  const downgraded = createPluginRegistry({ manifests: [manifest('sample')], modules: { sample: { migrations: migrations.slice(0, 1) } } });
  await assert.rejects(change(downgraded, f, 'sample', true), { code: 'PLUGIN_DATA_VERSION_UNSUPPORTED' });
});

test('a failing schema statement rolls back earlier DDL, ledger and installation rather than marking completion', async t => {
  const f = await app(t);
  const migrations = [await migration(1, ['CREATE TABLE plugin_failing__items (id TEXT PRIMARY KEY)',
    'ALTER TABLE plugin_failing__missing ADD COLUMN label TEXT'])];
  const registry = createPluginRegistry({ manifests: [manifest('failing')], modules: { failing: { migrations } } });
  await assert.rejects(change(registry, f, 'failing', true), { code: 'PLUGIN_MIGRATION_FAILED' });
  assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='plugin_failing__items'").get(), undefined);
  assert.equal(f.sqlite.prepare('SELECT key FROM instance_settings WHERE key=?').get(migrationKey('failing')), undefined);
  assert.equal((await registry.readInstallation(f.env, 'failing')).installed, false);
  assert.equal(f.sqlite.prepare('SELECT key FROM instance_settings WHERE key=?').get(REGISTRY_KEY), undefined);
});

test('migration checksums, sequence and table ownership are validated before executing any SQL', async t => {
  const f = await app(t);
  assert.match(validateMigrationSql('sample', 'CREATE TABLE plugin_sample__multiline (\n  id TEXT PRIMARY KEY\n);'), /multiline/);
  for (const sql of ['CREATE TABLE accounts (id TEXT)', 'CREATE TABLE plugin_other_data (id TEXT)',
    'CREATE TABLE plugin_sample_data__items (id TEXT)',
    'CREATE TABLE plugin_sample__copy AS SELECT * FROM accounts', 'ALTER TABLE plugin_sample__items RENAME TO accounts',
    'CREATE TRIGGER plugin_sample__trigger AFTER INSERT ON accounts BEGIN DELETE FROM accounts; END',
    'CREATE INDEX plugin_sample__index ON accounts (account_id)']) assert.throws(() => validateMigrationSql('sample', sql), { code: 'PLUGIN_MIGRATION_SCOPE' });
  const valid = await migration(1, ['CREATE TABLE plugin_sample__items (id TEXT)']);
  for (const [migrations, code] of [
    [[{ ...valid, checksum: '0'.repeat(64) }], 'PLUGIN_MIGRATION_CHECKSUM'],
    [[{ ...valid, version: 2 }], 'PLUGIN_MIGRATION_INVALID'],
    [[await migration(1, ['CREATE TABLE accounts (id TEXT)'])], 'PLUGIN_MIGRATION_SCOPE'],
  ]) {
    const registry = createPluginRegistry({ manifests: [manifest('sample')], modules: { sample: { migrations } } });
    await assert.rejects(change(registry, f, 'sample', true), { code });
  }
});

test('concurrent migration installations execute their schema only once', async t => {
  const f = await app(t);
  const migrations = [await migration(1, ['CREATE TABLE plugin_sample__items (id TEXT)'])];
  const registry = createPluginRegistry({ manifests: [manifest('sample')], modules: { sample: { migrations } } });
  const results = await Promise.allSettled([change(registry, f, 'sample', true), change(registry, f, 'sample', true)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PLUGIN_REVISION_MISMATCH');
  assert.equal((await registry.readInstallation(f.env, 'sample')).revision, 1);
});

test('plugin storage isolates both accounts and plugins and restricts instance data to current administrators', async t => {
  const f = await app(t); const registry = createPluginRegistry({ manifests: [manifest('one'), manifest('two')] });
  for (const id of ['one', 'two']) await change(registry, f, id, true);
  const make = (pluginId, session = f.signed.session) => createPluginContext({ env: f.env, session, pluginId, registry });
  const one = await make('one'); const two = await make('two'); const member = await make('one', (await f.signIn('member')).session);
  assert.deepEqual(await one.storage.set('account', 'preferences', { color: 'blue' }, { revision: 0 }), { value: { color: 'blue' }, revision: 1 });
  assert.deepEqual(await member.storage.get('account', 'preferences'), { value: null, revision: 0 });
  assert.deepEqual(await two.storage.get('account', 'preferences'), { value: null, revision: 0 });
  await member.storage.set('account', 'preferences', { color: 'green' }, { revision: 0 });
  assert.deepEqual((await one.storage.get('account', 'preferences')).value, { color: 'blue' });
  await one.storage.set('instance', 'preferences', { site: true }, { revision: 0 });
  await assert.rejects(member.storage.get('instance', 'preferences'), { code: 'forbidden' });
  await assert.rejects(member.storage.set('instance', 'preferences', {}, { revision: 0 }), { code: 'forbidden' });
  await assert.rejects(one.storage.set('account', 'preferences', {}, { revision: 0 }), { code: 'PLUGIN_DATA_REVISION_MISMATCH' });
  await assert.rejects(one.storage.get('account', '../other'), { code: 'invalid_input' });
  await assert.rejects(one.storage.set('account', 'large', 'x'.repeat(17000), { revision: 0 }), { code: 'invalid_input' });
});

test('storage capabilities expire on session revocation and installation replacement while retaining saved data', async t => {
  const f = await app(t); const registry = createPluginRegistry({ manifests: [manifest('one')] });
  await change(registry, f, 'one', true);
  const session = f.signed.session;
  const context = await createPluginContext({ env: f.env, session, pluginId: 'one', registry });
  await context.storage.set('account', 'value', 1, { revision: 0 });
  await change(registry, f, 'one', false); await change(registry, f, 'one', true);
  await assert.rejects(context.storage.get('account', 'value'), { code: 'PLUGIN_NOT_INSTALLED' });
  await assert.rejects(context.storage.set('account', 'value', 2, { revision: 1 }), { code: 'PLUGIN_NOT_INSTALLED' });
  const current = await createPluginContext({ env: f.env, session, pluginId: 'one', registry });
  assert.deepEqual(await current.storage.get('account', 'value'), { value: 1, revision: 1 });
  f.db.beforeWrite = sql => {
    if (!sql.includes('INSERT INTO instance_settings')) return;
    f.db.beforeWrite = null;
    f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), session.tokenHash);
  };
  await assert.rejects(current.storage.set('account', 'value', 2, { revision: 1 }), { code: 'forbidden' });
});

test('generic service dispatch supplies current host context and enforces plugin installation', async t => {
  const f = await app(t); const buildDigest = '1'.repeat(64);
  const registry = createPluginRegistry({ manifests: [manifest('sample')], builds: [{ id: 'sample', sourceDigest: buildDigest }] });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const request = new Request('https://test.example/api/account/plugins/sample/data', { headers: { 'X-FlareTune-Plugin-Build': buildDigest } });
  let calls = 0;
  const handlers = { sample: async ({ context, path, scope }) => { calls++; return json({ owner: context.identity.accountId, path, scope }); } };
  const run = (input = request) => handlePluginApi(input, '/api/account/plugins/sample/data', f.env, f.signed.session, json, { registry, handlers });
  assert.equal((await run()).status, 409);
  await change(registry, f, 'sample', true);
  for (const headers of [{}, { 'X-FlareTune-Plugin-Build': '2'.repeat(64) }]) {
    const response = await run(new Request(request.url, { headers }));
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'PLUGIN_BUILD_MISMATCH' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await (await run()).json(), { owner: f.owner, path: '/data', scope: 'account' });
  assert.equal(calls, 1);
});

test('compiled data upgrades gate business and optional features until their migration commits; failure leaves the old version intact', async t => {
  const f = await app(t);
  const first = await migration(1, ['CREATE TABLE plugin_sample__items (id TEXT PRIMARY KEY)']);
  const dependent = manifest('consumer', { dependencies: { sample: { apiVersion: 1 } } });
  const optional = manifest('optional', { optionalDependencies: { sample: { apiVersion: 1, features: ['ai'] } } });
  const oldRegistry = createPluginRegistry({ manifests: [manifest('sample', { dataVersion: 1 }), dependent, optional],
    modules: { sample: { migrations: [first] } } });
  for (const id of ['sample', 'consumer', 'optional']) await change(oldRegistry, f, id, true);
  const second = await migration(2, ['ALTER TABLE plugin_sample__missing ADD COLUMN label TEXT']);
  const upgraded = createPluginRegistry({ manifests: [manifest('sample', { dataVersion: 2 }), dependent, optional],
    modules: { sample: { migrations: [first, second] } } });
  const list = (await upgraded.listPlugins(f.env, f.signed.session)).plugins;
  assert.equal(list.find(plugin => plugin.id === 'sample').availability.reason, 'data_migration_required');
  assert.equal(list.find(plugin => plugin.id === 'consumer').availability.reason, 'dependency_unavailable');
  assert.equal(list.find(plugin => plugin.id === 'optional').availability.available, true);
  assert.equal(list.find(plugin => plugin.id === 'optional').availability.optionalFeatures.ai.reason, 'data_migration_required');
  await assert.rejects(upgraded.requirePluginInstalled(f.env, 'sample'), { code: 'PLUGIN_UNAVAILABLE' });
  await assert.rejects(change(upgraded, f, 'sample', true), { code: 'PLUGIN_MIGRATION_FAILED' });
  assert.equal((await upgraded.readInstallation(f.env, 'sample')).revision, 1);
  assert.equal(JSON.parse(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(migrationKey('sample')).value_json).completed.length, 1);
  const goodSecond = await migration(2, ['ALTER TABLE plugin_sample__items ADD COLUMN label TEXT']);
  const repaired = createPluginRegistry({ manifests: [manifest('sample', { dataVersion: 2 }), dependent, optional],
    modules: { sample: { migrations: [first, goodSecond] } } });
  assert.equal((await change(repaired, f, 'sample', true)).plugin.availability.available, true);
  await repaired.requirePluginInstalled(f.env, 'consumer');
});
