import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';
import { createPluginRegistry, REGISTRY_KEY, installationKey } from './registry.js';
import { createPluginDelivery, PLUGIN_DELIVERY_KEY } from './delivery.js';
import { createPluginContext } from './context.js';

const oldHost = { version: '1.2.1', sourceDigest: 'a'.repeat(64) };
const nextHost = { version: '1.2.2', sourceDigest: 'c'.repeat(64) };
const token = 'synthetic_upgrade_token_not_a_real_secret_12345';
const request = () => new Request('https://test.example/api/plugin-build/upgrade', { headers: { Authorization: `Bearer ${token}` } });
const manifest = id => ({ id, version: '1.0.0', hostApiVersion: 1, apiVersion: 1, name: id,
  description: 'Synthetic upgrade package', icon: 'box', pages: [], entries: [], capabilityRoles: ['admin', 'member'], dataVersion: 0 });
const source = id => ({ type: 'artifact', id: 'third-party', url: `https://packages.example.net/${id}/1.0.0.json`, sha256: (id === 'sample' ? 'd' : 'e').repeat(64) });
const input = (state, target = nextHost) => ({ revision: state.revision, registryRevision: state.registryRevision,
  fromHost: state.host, runningDigest: state.runningDigest, host: target });
const report = (plan, status) => ({ buildId: plan.buildId, planDigest: plan.planDigest, status });
const raw = (f, key) => f.sqlite.prepare('SELECT * FROM instance_settings WHERE key=?').get(key);
const saved = f => JSON.parse(raw(f, PLUGIN_DELIVERY_KEY).value_json);

async function app(t, { installed = true, workspace = false } = {}) {
  const f = await fixture(); t.after(() => f.close());
  const manifests = [manifest('sample'), manifest('disabled')];
  const sources = Object.fromEntries(manifests.map(row => [row.id, workspace ? { type: 'workspace', id: 'workspace', sourceDigest: 'b'.repeat(64) } : source(row.id)]));
  const registry = createPluginRegistry({ manifests, builds: manifests.map(row => ({ id: row.id, sourceDigest: 'b'.repeat(64) })), deployment: null });
  if (installed) await registry.setInstalled(f.env, f.signed.session, 'sample', { installed: true, revision: 0 });
  await registry.setInstalled(f.env, f.signed.session, 'disabled', { installed: false, revision: 0 });
  const deployment = { buildId: 'd177b3b8-6df5-49df-9bdd-4054d24c2ca6', planDigest: 'f'.repeat(64), host: oldHost,
    plugins: manifests.map(({ id, version }) => ({ id, version, source: sources[id] })) };
  const delivery = createPluginDelivery({ registry, host: oldHost, deployment, sources });
  await delivery.configure(f.env, f.signed.session, { revision: 0, buildToken: token,
    deployHookUrl: 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-hook-upgrade-12345' });
  const state = () => delivery.upgrade(f.env, request());
  const reserve = async () => delivery.upgrade(f.env, request(), input(await state()));
  const upgraded = plan => {
    const selected = plan.plugins.map(row => row.manifest);
    const registry = createPluginRegistry({ manifests: selected, builds: selected.map(row => ({ id: row.id, sourceDigest: '7'.repeat(64) })),
      deployment: { buildId: plan.buildId, planDigest: plan.planDigest, host: plan.host,
        plugins: plan.plugins.map(({ id, version, source }) => ({ id, version, source })) } });
    const deployment = { buildId: plan.buildId, planDigest: plan.planDigest, host: plan.host,
      plugins: plan.plugins.map(({ id, version, source }) => ({ id, version, source })) };
    return { registry, delivery: createPluginDelivery({ registry, host: plan.host, deployment,
      sources: Object.fromEntries(plan.plugins.map(row => [row.id, row.source])) }) };
  };
  return { ...f, registry, delivery, state, reserve, upgraded, sources };
}

test('upgrade endpoints require the build token even for administrator and member sessions', async t => {
  const f = await app(t);
  const member = await f.signIn('member');
  for (const auth of [f.signed, member]) {
    assert.equal((await f.api('plugin-build/upgrade', 'GET', undefined, auth)).status, 403);
    assert.equal((await f.api('plugin-build/upgrade', 'POST', {}, auth)).status, 403);
  }
  assert.equal((await f.api('plugin-build/upgrade', 'GET', undefined, f.signed, { Authorization: 'Bearer wrong_token_1234567890123456789012345' })).status, 403);
  assert.equal((await f.api('plugin-build/upgrade', 'GET', undefined, f.signed, { Authorization: `Bearer ${token}` })).status, 200);
  await assert.rejects(f.delivery.upgrade(f.env, new Request('https://test.example')), { code: 'forbidden' });
});

test('cross-host activation inherits only installed exact packages and preserves configuration, ciphertext and installation records', async t => {
  const f = await app(t);
  const context = await createPluginContext({ env: f.env, session: f.signed.session, pluginId: 'sample', registry: f.registry });
  await context.storage.set('instance', 'preferences', { model: 'saved-model', locale: 'ja' }, { revision: 0 });
  await context.storage.set('account', 'preferences', { style: 'personal', enabled: false }, { revision: 0 });
  const beforeRows = f.sqlite.prepare("SELECT * FROM instance_settings WHERE key LIKE 'plugin.data.%' OR key LIKE 'plugin.installation.%' ORDER BY key").all();
  const encrypted = saved(f).secrets;
  const exported = await f.state();
  assert.deepEqual(exported.plugins.map(row => row.id), ['sample']);
  assert.deepEqual(exported.plugins[0].source, source('sample'));
  assert.equal(JSON.stringify(exported).includes('saved-model'), false);
  assert.equal(JSON.stringify(exported).includes(token), false);
  const plan = await f.reserve();
  assert.deepEqual(plan.host, nextHost);
  assert.deepEqual(plan.plugins, exported.plugins);
  const activeBuild = (await f.state()).build;
  assert.equal(activeBuild.id, plan.buildId);
  assert.equal(activeBuild.planDigest, plan.planDigest);
  await assert.rejects(f.delivery.report(f.env, request(), report(plan, 'deployed')), { code: 'PLUGIN_DEPLOYMENT_NOT_READY' });
  const next = f.upgraded(plan);
  await next.delivery.report(f.env, request(), report(plan, 'deployed'));
  const afterRows = f.sqlite.prepare("SELECT * FROM instance_settings WHERE key LIKE 'plugin.data.%' OR key LIKE 'plugin.installation.%' ORDER BY key").all();
  assert.deepEqual(afterRows, beforeRows, 'host upgrades do not reinstall, reset revisions, rotate epochs, or overwrite site/account settings');
  assert.deepEqual(saved(f).secrets, encrypted);
  assert.equal(saved(f).mode, 'manual');
  assert.equal(saved(f).desired, null);
  assert.equal(saved(f).build.status, 'deployed');
  const nextContext = await createPluginContext({ env: f.env, session: f.signed.session, pluginId: 'sample', registry: next.registry });
  assert.deepEqual((await nextContext.storage.get('instance', 'preferences')).value, { model: 'saved-model', locale: 'ja' });
  assert.deepEqual((await nextContext.storage.get('account', 'preferences')).value, { style: 'personal', enabled: false });
  await next.delivery.report(f.env, request(), report(plan, 'deployed'));
  assert.deepEqual(raw(f, installationKey('sample')), beforeRows.find(row => row.key === installationKey('sample')));
});

test('an empty installed combination upgrades without enabling distribution packages', async t => {
  const f = await app(t, { installed: false });
  const disabled = raw(f, installationKey('disabled'));
  const plan = await f.reserve();
  assert.deepEqual(plan.plugins, []);
  await f.upgraded(plan).delivery.report(f.env, request(), report(plan, 'deployed'));
  assert.deepEqual(saved(f).running, []);
  assert.deepEqual(raw(f, installationKey('disabled')), disabled);
  assert.equal(raw(f, installationKey('sample')), undefined);
});

test('upgrade input cannot change plugin selection and rejects stale delivery, registry, served-host or running fingerprints', async t => {
  const f = await app(t);
  const state = await f.state(), before = raw(f, PLUGIN_DELIVERY_KEY);
  const valid = input(state);
  for (const change of [{ revision: state.revision + 1 }, { registryRevision: state.registryRevision + 1 },
    { fromHost: { ...oldHost, sourceDigest: '8'.repeat(64) } }, { runningDigest: '9'.repeat(64) }]) {
    await assert.rejects(f.delivery.upgrade(f.env, request(), { ...valid, ...change }), { code: 'PLUGIN_DELIVERY_CHANGED' });
  }
  for (const change of [{ plugins: [] }, { host: { ...nextHost, sourceDigest: 'invalid' } }, { registryRevision: -1 }]) {
    await assert.rejects(f.delivery.upgrade(f.env, request(), { ...valid, ...change }), { code: 'invalid_input' });
  }
  await assert.rejects(f.delivery.upgrade(f.env, request(), input(state, oldHost)), { code: 'PLUGIN_HOST_UNCHANGED' });
  await assert.rejects(f.delivery.upgrade(f.env, request(), input(state, { ...nextHost, version: '1.2.0' })), { code: 'PLUGIN_HOST_DOWNGRADE_UNSUPPORTED' });
  assert.deepEqual(raw(f, PLUGIN_DELIVERY_KEY), before);
});

test('the reservation write atomically rejects a registry change after its read preflight', async t => {
  const f = await app(t);
  const state = await f.state(), before = raw(f, PLUGIN_DELIVERY_KEY);
  f.db.beforeWrite = sql => {
    if (!sql.includes('SELECT ?,?,1,?,? WHERE')) return;
    f.db.beforeWrite = null;
    f.sqlite.prepare('UPDATE instance_settings SET revision=revision+1 WHERE key=?').run(REGISTRY_KEY);
  };
  await assert.rejects(f.delivery.upgrade(f.env, request(), input(state)), { code: 'PLUGIN_DELIVERY_CHANGED' });
  assert.deepEqual(raw(f, PLUGIN_DELIVERY_KEY), before);
});

test('a registry change during the installed-combination read cannot produce a mixed export', async t => {
  const f = await app(t);
  const originalPrepare = f.db.prepare.bind(f.db);
  let inject = true;
  f.db.prepare = sql => {
    const statement = originalPrepare(sql), bind = statement.bind, first = statement.first;
    let key;
    statement.bind = (...args) => { key = args[0]; bind.apply(statement, args); return statement; };
    statement.first = async () => {
      const value = await first.call(statement);
      if (inject && key === installationKey('sample')) {
        inject = false;
        f.sqlite.prepare('UPDATE instance_settings SET revision=revision+1 WHERE key=?').run(REGISTRY_KEY);
      }
      return value;
    };
    return statement;
  };
  await assert.rejects(f.state(), { code: 'PLUGIN_DELIVERY_CHANGED' });
  assert.equal(inject, false, 'the concurrent generation change occurred between the read guards');
  assert.equal(saved(f).build, null);
});

test('a changed installation generation prevents new-host activation without overwriting that change', async t => {
  const f = await app(t);
  const plan = await f.reserve();
  const sample = raw(f, installationKey('sample'));
  await f.registry.setInstalled(f.env, f.signed.session, 'disabled', { installed: true, revision: 1 });
  const concurrentInstallation = raw(f, installationKey('disabled'));
  const deliveryBefore = raw(f, PLUGIN_DELIVERY_KEY);
  await assert.rejects(f.upgraded(plan).delivery.report(f.env, request(), report(plan, 'deployed')), { code: 'PLUGIN_DELIVERY_CHANGED' });
  assert.deepEqual(raw(f, PLUGIN_DELIVERY_KEY), deliveryBefore);
  assert.deepEqual(raw(f, installationKey('sample')), sample);
  assert.deepEqual(raw(f, installationKey('disabled')), concurrentInstallation);
});

test('pending selection, active jobs, and unknown results cannot be folded into a new host upgrade', async t => {
  const pending = await app(t);
  await pending.delivery.select(pending.env, pending.signed.session, { revision: (await pending.state()).revision, pluginId: 'sample', installed: false });
  const state = await pending.state();
  assert.equal(state.pending, true);
  await assert.rejects(pending.delivery.upgrade(pending.env, request(), input(state)), { code: 'PLUGIN_UPGRADE_PENDING_CHANGES' });
  const f = await app(t);
  const plan = await f.reserve();
  await assert.rejects(f.reserve(), { code: 'PLUGIN_BUILD_IN_PROGRESS' });
  await f.delivery.report(f.env, request(), report(plan, 'deploying'));
  await f.delivery.report(f.env, request(), report(plan, 'activation_pending'));
  await assert.rejects(f.reserve(), { code: 'PLUGIN_BUILD_RESULT_UNKNOWN' });
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, true);
});

test('workspace installations require explicit artifact migration before host inheritance', async t => {
  const f = await app(t, { workspace: true });
  const before = raw(f, PLUGIN_DELIVERY_KEY);
  await assert.rejects(f.reserve(), { code: 'PLUGIN_UPGRADE_ARTIFACT_REQUIRED' });
  assert.deepEqual(raw(f, PLUGIN_DELIVERY_KEY), before);
});

test('failed preparation retains the old selection and allows another immutable upgrade attempt', async t => {
  const f = await app(t);
  const before = raw(f, installationKey('sample'));
  const failed = await f.reserve();
  await f.delivery.report(f.env, request(), report(failed, 'failed'));
  assert.deepEqual(raw(f, installationKey('sample')), before);
  const retry = await f.reserve();
  assert.notEqual(retry.buildId, failed.buildId);
  assert.equal(retry.planDigest, failed.planDigest);
  await assert.rejects(f.delivery.report(f.env, request(), report(failed, 'building')), { code: 'PLUGIN_BUILD_CHANGED' });
});

test('rollback acknowledgement requires the actual previous host and refuses the proposed new host', async t => {
  const f = await app(t);
  const before = raw(f, installationKey('sample'));
  const plan = await f.reserve();
  await f.delivery.report(f.env, request(), report(plan, 'deploying'));
  await f.delivery.report(f.env, request(), report(plan, 'rolling_back'));
  await assert.rejects(f.upgraded(plan).delivery.report(f.env, request(), report(plan, 'rolled_back')), { code: 'PLUGIN_ROLLBACK_NOT_CONFIRMED' });
  await f.delivery.report(f.env, request(), report(plan, 'rolled_back'));
  assert.equal(saved(f).build.error, 'PLUGIN_BUILD_ROLLED_BACK');
  assert.deepEqual(raw(f, installationKey('sample')), before);
});
