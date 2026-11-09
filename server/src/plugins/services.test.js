import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../routes/localAssistant.fixture.js';
import { createPluginRegistry } from './registry.js';
import { createPluginContext } from './context.js';
import { createPluginOperationLease, createPluginServiceLease } from './services.js';

const manifest = (id, roles = ['admin', 'member'], dependencies = {}) => ({ id, name: id, description: id,
  icon: 'settings', version: '0.1.0', hostApiVersion: 1, apiVersion: 1, capabilityRoles: roles,
  dependencies, pages: [], entries: [] });
function setup(t) {
  const f = fixture(); t.after(() => f.sqlite.close());
  const registry = createPluginRegistry({ deployment: null, manifests: [
    manifest('assistant', undefined, { 'ai-gateway': { apiVersion: 1 } }),
    manifest('ai-gateway', ['admin'], { 'private-provider': { apiVersion: 1 } }),
    manifest('private-provider', ['admin']),
  ] });
  f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES ('plugin.installation.private-provider',?,1,1,'account-A')`).run(JSON.stringify({ installed: true, epoch: crypto.randomUUID() }));
  const env = { DB: f.db }, session = f.session('account-A');
  return { ...f, env, sessionFor: f.session, session, registry };
}
function countBindings(db) {
  let count = 0;
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    for (const method of ['first', 'all', 'run']) {
      const original = statement[method];
      statement[method] = (...args) => { count += 1; return original.apply(statement, args); };
    }
    return statement;
  };
  db.batch = statements => { count += 1; return batch(statements); };
  return () => count;
}
const service = (f, consumerContext) => createPluginServiceLease({ ...f, consumerContext, consumerId: 'assistant', providerId: 'ai-gateway' });
const operation = (f, context) => createPluginOperationLease({ ...f, context, pluginId: 'assistant' });

test('service and operation initialization use one complete registry snapshot for transitive dependencies', async t => {
  const f = setup(t), calls = countBindings(f.db);
  const a = await service(f); assert.equal(calls(), 3, 'session, one registry snapshot, final live assertion');
  const before = calls(); await operation(f); assert.equal(calls() - before, 3);
  const context = await createPluginContext({ ...f, pluginId: 'assistant' });
  const scoped = calls(); await service(f, context); assert.equal(calls() - scoped, 2);
  const scopedOperation = calls(); await operation(f, context); assert.equal(calls() - scopedOperation, 2);
  assert.equal(a.consumer.id, 'assistant'); assert.equal(a.provider.id, 'ai-gateway');
});

for (const [name, create] of [['service', service], ['operation', operation]]) {
  test(`${name} initialization never replaces an old context epoch with a new installation`, async t => {
    const f = setup(t), context = await createPluginContext({ ...f, pluginId: 'assistant' });
    f.sqlite.prepare("UPDATE instance_settings SET value_json=? WHERE key='plugin.installation.assistant'")
      .run(JSON.stringify({ installed: true, epoch: crypto.randomUUID() }));
    await assert.rejects(create(f, context), { code: 'PLUGIN_NOT_INSTALLED' });
  });
  test(`${name} lease keeps transitive provider epochs in its live and transaction guards`, async t => {
    const f = setup(t), lease = await create(f);
    const batch = f.db.batch.bind(f.db);
    f.db.batch = async statements => {
      f.sqlite.prepare("UPDATE instance_settings SET value_json=? WHERE key='plugin.installation.private-provider'")
        .run(JSON.stringify({ installed: true, epoch: crypto.randomUUID() }));
      return batch(statements);
    };
    await assert.rejects(lease.guardedDb(f.db).prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      VALUES ('lease.test','true',1,1,'account-A')`).run());
    assert.equal(f.sqlite.prepare("SELECT key FROM instance_settings WHERE key='lease.test'").get(), undefined);
    await assert.rejects(lease.assertCurrent(), { code: 'PLUGIN_NOT_INSTALLED' });
  });
}

test('bulk setup retains exact consumer role, normal-session and context ownership checks', async t => {
  const f = setup(t), context = await createPluginContext({ ...f, pluginId: 'assistant' });
  await assert.rejects(service({ ...f, session: f.sessionFor('account-B') }, context), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
  await assert.rejects(service({ ...f, session: { ...f.session, mode: 'password-change' } }, context), { code: 'forbidden' });
  await assert.rejects(operation({ ...f, admin: true }, context), { code: 'forbidden' });
  f.sqlite.exec("UPDATE accounts SET role='admin' WHERE account_id='account-A'");
  const session = f.session = { ...f.session, account: { ...f.session.account, role: 'admin' } };
  const adminContext = await createPluginContext({ ...f, session, pluginId: 'assistant' });
  const original = f.registry.requirePluginsInstalled;
  const registry = { ...f.registry, requirePluginsInstalled: async (...args) => {
    const result = await original(...args); f.sqlite.exec("UPDATE accounts SET role='member' WHERE account_id='account-A'"); return result;
  } };
  await assert.rejects(service({ ...f, registry, admin: true }, adminContext), { code: 'forbidden' });
});
