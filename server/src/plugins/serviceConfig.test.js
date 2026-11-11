import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../routes/localAssistant.fixture.js';
import { createPluginRegistry } from './registry.js';
import { createPluginContext } from './context.js';
import { createPluginServiceLease } from './services.js';
import { createInvocationDatabase } from '../services/invocationDatabase.js';
import { createServiceConfigStore, createServiceConfigGuard, commitServiceConfiguration,
  bindServiceConfiguration, listServiceResourceUses, createServiceResourceDeletionStore } from './serviceConfig.js';

const manifest = (id, extra = {}) => ({ id, name: id, description: id, icon: 'settings', version: '0.2.0',
  hostApiVersion: 3, apiVersion: 1, capabilityRoles: ['admin','member'], pages: [], entries: [], ...extra });
async function setup(t) {
  const f = fixture({ modelInitialized: false }); t.after(() => f.sqlite.close());
  f.sqlite.exec("UPDATE accounts SET role='admin' WHERE account_id='account-A'");
  f.sqlite.exec('CREATE TABLE plugin_ai_gateway__suppliers(id TEXT PRIMARY KEY,revision INTEGER)');
  f.sqlite.exec("INSERT INTO plugin_ai_gateway__suppliers VALUES('supplier',1)");
  const registry = createPluginRegistry({ deployment: null, manifests: [
    manifest('assistant', { dependencies: { 'ai-gateway': { apiVersion: 1 } }, serviceConfigurations: { 'ai-gateway': ['ai-model'] } }),
    manifest('ai-gateway', { capabilityRoles: ['admin'] }),
  ] });
  const env = { DB: f.db }, session = { ...f.session('account-A'), account: { ...f.session('account-A').account, role: 'admin' } };
  const context = await createPluginContext({ env, session, registry, pluginId: 'assistant' });
  const serviceLease = await createPluginServiceLease({ env, session, registry, consumerContext: context, consumerId: 'assistant', providerId: 'ai-gateway' });
  const request = { env, session, registry, context, serviceLease, consumerId: 'assistant' };
  const providerContext = await createPluginContext({ env, session, registry, pluginId: 'ai-gateway' });
  const provider = { env, session, registry, context: providerContext, providerId: 'ai-gateway', resourceId: 'supplier' };
  const guard = () => createServiceConfigGuard(request, { constraints: [{ table: 'plugin_ai_gateway__suppliers', where: { id: 'supplier' }, expected: { revision: 1 } }] });
  const save = async (expectedRevision = 0, resourceId = 'supplier') => {
    const store = await createServiceConfigStore(request);
    const mutation = await store.prepare({ value: { schemaVersion: 1, selection: { providerId: resourceId, model: 'test' } }, expectedRevision });
    return commitServiceConfiguration(request, { mutation, guard: guard(), resourceId });
  };
  return { ...f, request, provider, guard, save };
}

test('consumer owns versioned config; neutral resource uses contain no model or secrets', async t => {
  const f = await setup(t), store = await createServiceConfigStore(f.request);
  assert.deepEqual(await store.read(), { value: null, revision: 0 });
  assert.equal((await f.save()).revision, 1);
  assert.equal((await store.read()).value.selection.model, 'test');
  assert.deepEqual(await listServiceResourceUses(f.provider), [{ consumerId: 'assistant', name: 'assistant', slot: 'ai-model', revision: 1 }]);
  const ref = JSON.parse(f.sqlite.prepare("SELECT value_json FROM instance_settings WHERE key='plugin.service-use.ai-gateway.assistant.ai-model'").get().value_json);
  assert.deepEqual(Object.keys(ref).sort(), ['configKey','configRevision','consumerId','resourceId','slot']);
  assert.equal(f.sqlite.prepare("SELECT key FROM instance_settings WHERE key='plugin.data.ai-gateway.instance.ai-model'").get(), undefined);
});

test('service config rejects structural, cross-session, database and registry lease substitution', async t => {
  const f = await setup(t), r = f.request;
  for (const bad of [{ ...r, serviceLease: { ...r.serviceLease } }, { ...r, session: f.session('account-B') },
    { ...r, env: { DB: { ...f.db } } }, { ...r, registry: { ...r.registry } }, { ...r, consumerId: 'other' }]) {
    await assert.rejects(createServiceConfigStore(bad), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
  }
  assert.throws(() => createServiceConfigGuard(r, { constraints: [{ table: 'accounts', where: { account_id: 'account-A' }, expected: null }] }), { code: 'PLUGIN_SERVICE_CONFIG_SCOPE' });
  assert.throws(() => createServiceConfigGuard(r, { constraints: [{ table: 'instance_settings', where: { key: 'plugin.data.other.instance.secret' }, expected: null }] }), { code: 'PLUGIN_SERVICE_CONFIG_SCOPE' });
  const store = await createServiceConfigStore(r);
  await assert.rejects(store.read('other'), { code: 'PLUGIN_SERVICE_CONFIG_UNDECLARED' });
  await assert.rejects(commitServiceConfiguration(r, { mutation: {}, guard: {}, resourceId: null }), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
});

test('CAS and provider snapshot failures roll back owner configuration and resource-use index together', async t => {
  const f = await setup(t), store = await createServiceConfigStore(f.request);
  const mutation = await store.prepare({ expectedRevision: 0, value: { schemaVersion: 1, selection: null } });
  const guard = f.guard();
  f.sqlite.exec("UPDATE plugin_ai_gateway__suppliers SET revision=2 WHERE id='supplier'");
  await assert.rejects(commitServiceConfiguration(f.request, { mutation, guard, resourceId: 'supplier' }), { code: 'PLUGIN_SERVICE_CONFIGURATION_CHANGED' });
  assert.equal((await store.read()).revision, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_settings WHERE key LIKE 'plugin.service-use.%'").get().n, 0);
  f.sqlite.exec("UPDATE plugin_ai_gateway__suppliers SET revision=1 WHERE id='supplier'");
  await f.save();
  await assert.rejects(commitServiceConfiguration(f.request, { mutation, guard: f.guard(), resourceId: null }), { code: 'PLUGIN_SERVICE_CONFIGURATION_CHANGED' });
  assert.equal((await store.read()).revision, 1);
  assert.equal((await listServiceResourceUses(f.provider)).length, 1);
});

test('selection binding gates writes at both ends of a D1 transaction and rolls back self-invalidation', async t => {
  const f = await setup(t); await f.save();
  const binding = bindServiceConfiguration(f.request, { revision: 1, guard: f.guard() });
  await binding.assertCurrent();
  const db = binding.guardedDb();
  await assert.rejects(db.batch([
    db.prepare("UPDATE instance_settings SET revision=2 WHERE key='plugin.data.assistant.instance.ai-model'"),
    db.prepare("INSERT INTO instance_settings VALUES('business.write','true',1,1,'account-A')"),
  ]));
  assert.equal(f.sqlite.prepare("SELECT revision FROM instance_settings WHERE key='plugin.data.assistant.instance.ai-model'").get().revision, 1);
  assert.equal(f.sqlite.prepare("SELECT key FROM instance_settings WHERE key='business.write'").get(), undefined);
  f.sqlite.exec("UPDATE instance_settings SET revision=2 WHERE key='plugin.data.assistant.instance.ai-model'");
  await assert.rejects(binding.assertCurrent(), { code: 'PLUGIN_SERVICE_CONFIGURATION_CHANGED' });
});

test('members use saved config but cannot prepare or commit administrator mutations', async t => {
  const f = await setup(t); await f.save();
  const session = f.session('account-B'), r = { ...f.request, session, context: undefined };
  r.serviceLease = await createPluginServiceLease({ ...r, providerId: 'ai-gateway' });
  const store = await createServiceConfigStore(r);
  assert.equal((await store.read()).revision, 1);
  await bindServiceConfiguration(r, { revision: 1 }).assertCurrent();
  await assert.rejects(store.prepare({ expectedRevision: 1, value: null }), { code: 'forbidden' });
  await assert.rejects(createServiceConfigStore({ ...r, serviceLease: undefined }), { code: 'forbidden' });
});

test('provider deletion cannot race a save, uninstall releases use and preserved config restores use', async t => {
  const f = await setup(t);
  const deletion = await createServiceResourceDeletionStore(f.provider);
  await f.save();
  await assert.rejects(deletion.prepare("DELETE FROM plugin_ai_gateway__suppliers WHERE id='supplier'").run());
  assert.ok(f.sqlite.prepare("SELECT id FROM plugin_ai_gateway__suppliers WHERE id='supplier'").get());
  const row = f.sqlite.prepare("SELECT value_json FROM instance_settings WHERE key='plugin.installation.assistant'").get();
  const installation = JSON.parse(row.value_json);
  f.sqlite.prepare("UPDATE instance_settings SET value_json=? WHERE key='plugin.installation.assistant'").run(JSON.stringify({ ...installation, installed: false }));
  assert.deepEqual(await listServiceResourceUses(f.provider), []);
  f.sqlite.prepare("UPDATE instance_settings SET value_json=? WHERE key='plugin.installation.assistant'").run(JSON.stringify({ ...installation, epoch: crypto.randomUUID() }));
  assert.equal((await listServiceResourceUses(f.provider)).length, 1);
  // A downgraded old consumer has no declared slots. Its retained index is not
  // a new-style active reference; gateway's legacy adapter owns that case.
  const registry = createPluginRegistry({ deployment: null, manifests: [manifest('assistant', { dependencies: { 'ai-gateway': { apiVersion: 1 } } }), manifest('ai-gateway', { capabilityRoles: ['admin'] })] });
  const downgraded = { ...f.provider, registry, context: await createPluginContext({ ...f.provider, registry, pluginId: 'ai-gateway' }) };
  assert.deepEqual(await listServiceResourceUses(downgraded), []);
  const db = await createServiceResourceDeletionStore(downgraded);
  await db.prepare("DELETE FROM plugin_ai_gateway__suppliers WHERE id='supplier'").run();
  assert.equal(f.sqlite.prepare("SELECT id FROM plugin_ai_gateway__suppliers WHERE id='supplier'").get(), undefined);
});

test('a deletion that wins before a save invalidates its provider guard atomically', async t => {
  const f = await setup(t), store = await createServiceConfigStore(f.request);
  const mutation = await store.prepare({ expectedRevision: 0, value: { schemaVersion: 1, selection: null } }), guard = f.guard();
  const deletion = await createServiceResourceDeletionStore(f.provider);
  await deletion.prepare("DELETE FROM plugin_ai_gateway__suppliers WHERE id='supplier'").run();
  await assert.rejects(commitServiceConfiguration(f.request, { mutation, guard, resourceId: 'supplier' }), { code: 'PLUGIN_SERVICE_CONFIGURATION_CHANGED' });
  assert.equal((await store.read()).revision, 0);
});

test('bound database rejects foreign objects but accepts host-owned budget and lease adapters', async t => {
  const f = await setup(t); await f.save();
  const bound = bindServiceConfiguration(f.request, { revision: 1 });
  assert.throws(() => bound.guardedDb({ ...f.db }), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
  await bound.guardedDb(createInvocationDatabase(f.db)).prepare('SELECT 1').first();
  await bound.guardedDb(f.request.serviceLease.guardedDb()).prepare('SELECT 1').first();
});

test('declared configuration slots cannot bypass coordinated writes through generic context storage', async t => {
  const f = await setup(t); await f.save();
  const row = await f.request.context.storage.get('instance', 'ai-model');
  await assert.rejects(f.request.context.storage.set('instance', 'ai-model', row.value, { revision: row.revision }), { code: 'PLUGIN_SERVICE_CONFIG_RESERVED' });
  assert.equal((await listServiceResourceUses(f.provider)).length, 1);
});

test('all guard statements stay within D1 binding cap even for 16 slots and multiple source snapshots', async t => {
  const f = await setup(t);
  const registry = createPluginRegistry({ deployment: null, manifests: [manifest('assistant', {
    dependencies: { 'ai-gateway': { apiVersion: 1 } }, serviceConfigurations: { 'ai-gateway': Array.from({ length: 16 }, (_, i) => `model-${i}`) },
  }), manifest('ai-gateway', { capabilityRoles: ['admin'] })] });
  const original = f.db.prepare.bind(f.db);
  f.db.prepare = sql => { const statement = original(sql), bind = statement.bind; statement.bind = (...values) => { assert.ok(values.length <= 100, `too many D1 bindings: ${values.length}`); return bind.apply(statement, values); }; return statement; };
  const context = await createPluginContext({ ...f.provider, registry, pluginId: 'ai-gateway' });
  const deletion = await createServiceResourceDeletionStore({ ...f.provider, registry, context });
  await deletion.prepare('SELECT 1').first();
  const constraints = Array.from({ length: 32 }, () => ({ table: 'plugin_ai_gateway__suppliers', where: { id: 'supplier' }, expected: { revision: 1 } }));
  await f.save();
  const guard = createServiceConfigGuard(f.request, { constraints });
  await bindServiceConfiguration(f.request, { revision: 1, guard }).assertCurrent();
});

test('administrator can read own saved configuration when optional provider is not installed', async t => {
  const f = await setup(t); await f.save();
  const registry = createPluginRegistry({ deployment: null, manifests: [manifest('assistant', {
    optionalDependencies: { 'ai-gateway': { apiVersion: 1 } }, serviceConfigurations: { 'ai-gateway': ['ai-model'] },
  }), manifest('ai-gateway', { capabilityRoles: ['admin'] })] });
  f.sqlite.exec("UPDATE instance_settings SET value_json='{}' WHERE key='plugin.installation.ai-gateway'");
  const request = { ...f.request, registry, context: undefined, serviceLease: undefined };
  const store = await createServiceConfigStore(request);
  assert.equal((await store.read()).revision, 1);
  await assert.rejects(store.prepare({ expectedRevision: 1, value: null }), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
});
