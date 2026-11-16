import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../routes/localAssistant.fixture.js';
import { createPluginRegistry } from './registry.js';
import { createPluginOperationLease } from './services.js';
import { createInvocationDatabase } from '../services/invocationDatabase.js';

const manifest = (id, dependencies = {}) => ({ id, name: id, description: id, icon: 'settings',
  version: '0.1.0', hostApiVersion: 1, apiVersion: 1, capabilityRoles: ['admin', 'member'],
  dependencies, pages: [], entries: [] });
function setup(t) {
  const f = fixture(); t.after(() => f.sqlite.close());
  const registry = createPluginRegistry({ deployment: null, manifests: [
    manifest('assistant', { 'ai-gateway': { apiVersion: 1 } }), manifest('ai-gateway'),
  ] });
  f.sqlite.prepare(`INSERT OR REPLACE INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES('plugin.registry','{}',1,1,'fixture')`).run();
  let snapshots = 0;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (/SELECT key,value_json,revision FROM instance_settings\s+WHERE key IN/u.test(sql)) {
      const all = statement.all.bind(statement); statement.all = (...args) => { snapshots++; return all(...args); };
    }
    return statement;
  };
  const session = f.session('account-A');
  const request = () => ({ DB: createInvocationDatabase(f.db, new AbortController().signal,
    { exhaustedCode: 'LYRICS_INVOCATION_BUDGET_EXHAUSTED' }) });
  const operation = (env, pluginId = 'assistant') => createPluginOperationLease({ env, session,
    requestIdentity: session.account, pluginId, registry });
  return { ...f, session, registry, request, operation, snapshots: () => snapshots };
}

test('one invocation shares its installation snapshot while separate requests read again', async t => {
  const f = setup(t), first = f.request();
  const a = await f.operation(first); const b = await f.operation(first, 'ai-gateway');
  assert.equal(f.snapshots(), 1); await a.assertCurrent(); await b.assertCurrent();
  await f.operation(f.request()); assert.equal(f.snapshots(), 2);
});

test('a raw database identity never enables cross-call authorization caching', async t => {
  const f = setup(t), env = { DB: f.db };
  await f.operation(env); await f.operation(env); assert.equal(f.snapshots(), 2);
});

test('another consumer invocation neither shares lyric snapshots nor acquires their extra revision guards', async t => {
  const f = setup(t), env = { DB: createInvocationDatabase(f.db, new AbortController().signal,
    { exhaustedCode: 'ASSISTANT_INVOCATION_BUDGET_EXHAUSTED' }) };
  const lease = await f.operation(env);
  f.sqlite.prepare("UPDATE instance_settings SET revision=revision+1 WHERE key='plugin.registry'").run();
  await lease.assertCurrent();
  await f.operation(env, 'ai-gateway'); assert.equal(f.snapshots(), 2);
});

test('cached installation data cannot authorize a revoked or expired session', async t => {
  for (const column of ['revoked_at', 'expires_at']) {
    const f = setup(t), env = f.request(); await f.operation(env);
    f.sqlite.prepare(`UPDATE account_sessions SET ${column}=? WHERE token_hash=?`)
      .run(column === 'expires_at' ? Date.now() - 1 : Date.now(), f.session.tokenHash);
    await assert.rejects(f.operation(env, 'ai-gateway'), { code: 'forbidden' });
  }
});

test('same-request provider reinstall keeps the original epoch and typed retirement diagnosis', async t => {
  const f = setup(t), env = f.request(), lease = await f.operation(env);
  f.sqlite.prepare("UPDATE instance_settings SET value_json=? WHERE key='plugin.installation.ai-gateway'")
    .run(JSON.stringify({ installed: true, epoch: crypto.randomUUID() }));
  await assert.rejects(lease.assertCurrent(), { code: 'PLUGIN_NOT_INSTALLED' });
  await assert.rejects(f.operation(env), { code: 'PLUGIN_NOT_INSTALLED' });
});

for (const key of ['plugin.registry', 'plugin.delivery.v1', 'plugin.migrations.assistant']) {
  test(`a changed ${key} snapshot blocks guarded writes in the same request`, async t => {
    const f = setup(t), env = f.request(), lease = await f.operation(env);
    f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      VALUES(?, '{}',1,1,'fixture') ON CONFLICT(key) DO UPDATE SET revision=revision+1`).run(key);
    await assert.rejects(lease.guardedDb().prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      VALUES('request.should.not.commit','{}',1,1,'fixture')`).run());
    assert.equal(f.sqlite.prepare("SELECT 1 FROM instance_settings WHERE key='request.should.not.commit'").get(), undefined);
  });
}
