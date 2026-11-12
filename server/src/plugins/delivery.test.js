import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';
import { createPluginRegistry, installationKey } from './registry.js';
import { createPluginDelivery, PLUGIN_DELIVERY_KEY } from './delivery.js';
import { migrationChecksum } from './migrations.js';
import { handlePluginApi } from '../routes/plugins.js';
import { validateDeployHookUrl, validatePluginDirectory, validatePublicHttpsUrl } from '../../../shared/plugins/delivery.js';

const host = { version: '1.2.1', sourceDigest: 'a'.repeat(64) };
const manifest = (id = 'sample', extra = {}) => ({ id, version: '1.0.0', hostApiVersion: 1, apiVersion: 1,
  name: 'Sample', description: 'Synthetic plugin', icon: 'box', pages: [], entries: [], dataVersion: 0, ...extra });
const token = 'synthetic_plugin_build_token_1234567890';
const hook = 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-hook-1234567890';
const authorized = () => new Request('https://test.example/api/plugin-build/snapshot', { headers: { Authorization: `Bearer ${token}` } });
async function app(t, options = {}) {
  const f = await fixture(); t.after(() => f.close());
  const manifests = options.manifests || [manifest()];
  const registry = createPluginRegistry({ manifests, builds: manifests.map(row => ({ id: row.id, sourceDigest: 'b'.repeat(64) })), modules: options.modules || {} });
  const calls = [];
  const deployment = {};
  const delivery = createPluginDelivery({ registry, host, deployment, sources: options.sources || {}, fetchImpl: async (...args) => {
    calls.push(args);
    return options.fetchImpl ? options.fetchImpl(...args) : Response.json({ success: true, result: { build_uuid: 'synthetic-build-id' } });
  } });
  const get = () => delivery.get(f.env, f.signed.session);
  const config = async values => delivery.configure(f.env, f.signed.session, { revision: (await get()).revision, ...values });
  const select = async (installed = true, values = {}) => delivery.select(f.env, f.signed.session,
    { revision: (await get()).revision, pluginId: 'sample', installed, ...values });
  const build = async () => delivery.startBuild(f.env, f.signed.session, { revision: (await get()).revision });
  return { ...f, delivery, registry, calls, deployment, get, config, select, build };
}

const release = (version, digest = 'c', extra = {}) => ({ manifest: manifest('sample', { version, ...extra }),
  artifact: { url: `https://plugins.publisher.com/sample-${version}.json`, sha256: digest.repeat(64) } });
async function versionedApp(t, { installed = true, releases = [release('3.0.0', 'd'), release('1.9.0', 'a'), release('2.0.0', 'b'), release('2.0.1', 'c')] } = {}) {
  const runningRelease = release('2.0.0', 'b');
  const source = { type: 'artifact', id: 'official', ...runningRelease.artifact };
  const directory = { schemaVersion: 1, id: 'publisher', name: 'Fixture releases', plugins: releases };
  const f = await app(t, { manifests: [runningRelease.manifest], sources: { sample: source },
    fetchImpl: async (_url, options) => options.method === 'GET' ? Response.json(directory)
      : Response.json({ success: true, result: { build_uuid: 'synthetic-build-id' } }) });
  if (installed) await f.registry.setInstalled(f.env, f.signed.session, 'sample', { installed: true, revision: 0 });
  await f.delivery.refreshSource(f.env, f.signed.session, 'official', { revision: 0 });
  return f;
}
const rawDelivery = f => f.sqlite.prepare('SELECT value_json,revision,updated_at,updated_by FROM instance_settings WHERE key=?').get(PLUGIN_DELIVERY_KEY);
const selection = version => ({ sourceId: 'official', version, trustCode: true });

for (const mode of ['manual', 'auto']) test(`ordinary ${mode} selection rejects older releases without changing delivery or triggering a Hook`, async t => {
  const f = await versionedApp(t);
  await f.config({ mode, deployHookUrl: hook, buildToken: token });
  const before = rawDelivery(f), installation = await f.registry.readInstallation(f.env, 'sample'), calls = f.calls.length;
  await assert.rejects(f.select(true, selection('1.9.0')), { code: 'PLUGIN_VERSION_NOT_NEWER' });
  assert.deepEqual(rawDelivery(f), before);
  assert.deepEqual(await f.registry.readInstallation(f.env, 'sample'), installation);
  assert.equal(f.calls.length, calls);
  const state = await f.get(); assert.equal(state.running[0].version, '2.0.0'); assert.equal(state.desired[0].version, '2.0.0');
});

for (const mode of ['manual', 'auto']) test(`same-version exact ${mode} reselection is a no-op and keeps original CAS and trust checks`, async t => {
  const f = await versionedApp(t);
  await f.config({ mode, deployHookUrl: hook, buildToken: token });
  const before = rawDelivery(f), calls = f.calls.length;
  const result = await f.select(true, selection('2.0.0'));
  assert.equal(result.revision, before.revision); assert.deepEqual(result.pending, []);
  assert.deepEqual(rawDelivery(f), before); assert.equal(f.calls.length, calls);
  await assert.rejects(f.select(true, { ...selection('2.0.0'), trustCode: false }), { code: 'PLUGIN_CODE_TRUST_REQUIRED' });
  await assert.rejects(f.delivery.select(f.env, f.signed.session, { revision: before.revision - 1,
    pluginId: 'sample', installed: true, ...selection('2.0.0') }), { code: 'PLUGIN_DELIVERY_CHANGED' });
  assert.deepEqual(rawDelivery(f), before); assert.equal(f.calls.length, calls);
});

test('a same-version artifact replacement is rejected instead of manufacturing an update', async t => {
  const f = await versionedApp(t, { releases: [release('2.0.0', 'e')] });
  await f.config({ mode: 'auto', deployHookUrl: hook, buildToken: token });
  const before = rawDelivery(f), calls = f.calls.length;
  await assert.rejects(f.select(true, selection('2.0.0')), { code: 'PLUGIN_VERSION_NOT_NEWER' });
  assert.deepEqual(rawDelivery(f), before); assert.equal(f.calls.length, calls);
});

for (const mode of ['manual', 'auto']) test(`a compatible newer release retains the ${mode} confirmation and activation boundary`, async t => {
  const f = await versionedApp(t);
  await f.config({ mode, deployHookUrl: hook, buildToken: token });
  const calls = f.calls.length, installation = await f.registry.readInstallation(f.env, 'sample');
  const result = await f.select(true, selection('2.0.1'));
  assert.equal(result.running[0].version, '2.0.0'); assert.equal(result.desired[0].version, '2.0.1');
  assert.deepEqual(result.pending, [{ id: 'sample', operation: 'update', fromVersion: '2.0.0', toVersion: '2.0.1' }]);
  assert.deepEqual(await f.registry.readInstallation(f.env, 'sample'), installation);
  assert.equal(f.calls.length - calls, mode === 'auto' ? 1 : 0);
  if (mode === 'auto') { assert.equal(result.build.status, 'queued'); assert.equal(f.calls.at(-1)[0], hook); }
  else assert.equal(result.build, null);
});

for (const installed of [false, true]) test(`a locked higher target cannot be lowered through installed:true (${installed ? 'running plugin' : 'pending new install'})`, async t => {
  const f = await versionedApp(t, { installed });
  const first = await f.select(true, selection('3.0.0'));
  assert.equal(first.running.length, installed ? 1 : 0);
  await f.config({ mode: 'auto', deployHookUrl: hook, buildToken: token });
  const before = rawDelivery(f), calls = f.calls.length;
  await assert.rejects(f.select(true, selection('2.0.1')), { code: 'PLUGIN_VERSION_NOT_NEWER' });
  assert.deepEqual(rawDelivery(f), before); assert.equal(f.calls.length, calls);
  const exact = await f.select(true, selection('3.0.0'));
  assert.equal(exact.revision, before.revision); assert.deepEqual(rawDelivery(f), before); assert.equal(f.calls.length, calls);
});

test('an uninstalled plugin may select a historical release, while cancelling its pending uninstall does not create a fake update', async t => {
  const fresh = await versionedApp(t, { installed: false });
  const selected = await fresh.select(true, selection('1.9.0'));
  assert.equal(selected.running.length, 0); assert.equal(selected.desired[0].version, '1.9.0');
  assert.equal(selected.pending[0].operation, 'install');
  const running = await versionedApp(t);
  const uninstall = await running.select(false); assert.equal(uninstall.pending[0].operation, 'uninstall');
  const restored = await running.select(true, selection('2.0.0'));
  assert.deepEqual(restored.pending, []); assert.equal(restored.desired[0].version, '2.0.0');
  await assert.rejects(running.build(), { code: 'PLUGIN_NO_PENDING_CHANGES' });
});

test('higher versions still require source ownership, explicit trust and compatible manifests before any write', async t => {
  const f = await versionedApp(t, { releases: [release('2.0.0', 'b'), release('3.0.0', 'd', { hostApiVersion: 4 })] });
  let before = rawDelivery(f), calls = f.calls.length;
  await assert.rejects(f.select(true, { ...selection('3.0.0'), trustCode: false }), { code: 'PLUGIN_CODE_TRUST_REQUIRED' });
  await assert.rejects(f.select(true, selection('3.0.0')), { code: 'PLUGIN_SELECTION_INCOMPATIBLE' });
  assert.deepEqual(rawDelivery(f), before); assert.equal(f.calls.length, calls);
  const sources = await f.delivery.addSource(f.env, f.signed.session, { revision: (await f.get()).revision,
    url: 'https://another.publisher.com/repository.json' });
  const other = sources.sources.find(row => !row.official);
  before = rawDelivery(f); calls = f.calls.length;
  await assert.rejects(f.select(true, { ...selection('3.0.0'), sourceId: other.id }), { code: 'PLUGIN_SOURCE_CONFLICT' });
  assert.deepEqual(rawDelivery(f), before); assert.equal(f.calls.length, calls);
});

test('delivery permissions and cookie mutation protections are enforced by the real API', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.signIn('member');
  const status = await f.api('admin/plugin-delivery');
  assert.equal(status.status, 200); const before = await status.json();
  assert.equal(before.settings.mode, 'manual'); assert.equal(before.sources[0].official, true);
  assert.equal((await f.api('admin/plugin-delivery', 'GET', undefined, member)).status, 403);
  assert.equal((await f.api('admin/plugin-delivery', 'PUT', { revision: 0, mode: 'manual' }, member)).status, 403);
  assert.equal((await f.api('admin/plugin-delivery', 'PUT', { revision: 0, mode: 'manual' }, f.signed, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await f.api('admin/plugin-delivery', 'PUT', { revision: 0, mode: 'manual' }, f.signed, { 'X-FlareTune-Expected-Account': 'member' })).status, 409);
  const response = await f.api('plugin-build/snapshot');
  assert.equal(response.status, 403, 'session cookies do not grant build-token privileges');
  assert.equal((await f.api('plugin-build/unknown')).status, 404);
});

test('deployment credentials are encrypted, write-only, CAS guarded and cannot be used as source metadata', async t => {
  const f = await app(t);
  const configured = await f.config({ deployHookUrl: hook, buildToken: token });
  assert.deepEqual(configured.settings, { mode: 'manual', hookConfigured: true, buildTokenConfigured: true });
  assert.equal(JSON.stringify(configured).includes(token), false); assert.equal(JSON.stringify(configured).includes(hook), false);
  const persisted = f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(PLUGIN_DELIVERY_KEY).value_json;
  assert.equal(persisted.includes(token), false); assert.equal(persisted.includes(hook), false);
  await assert.rejects(f.delivery.configure(f.env, f.signed.session, { revision: 0, mode: 'manual' }), { code: 'PLUGIN_DELIVERY_CHANGED' });
  assert.equal(f.calls.length, 0, 'saving or reading configuration never triggers a build');
  await f.config({ deployHookUrl: '', buildToken: '' });
  assert.deepEqual((await f.get()).settings, { mode: 'manual', hookConfigured: false, buildTokenConfigured: false });
});

test('source URLs reject local destinations and deploy hooks reject arbitrary hosts, redirect and payload tricks', () => {
  for (const url of ['http://public.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x',
    'https://2130706433/x', 'https://127.1/x', 'https://user:pass@public.example.com/x', 'https://public.example.com:8443/x',
    'https://internal/x', 'https://a.local/x', 'https://127-0-0-1.nip.io/x', 'https://public.example.com/x#secret']) {
    assert.throws(() => validatePublicHttpsUrl(url), { code: 'PLUGIN_URL_INVALID' });
  }
  for (const url of ['https://public.example.com/hook', hook + '?redirect=1', hook + '/extra']) assert.throws(() => validateDeployHookUrl(url));
  assert.equal(validateDeployHookUrl(hook), hook);
  assert.throws(() => validatePluginDirectory({ schemaVersion: 1, id: 'source', name: 'Source', plugins: [{ manifest: manifest(), artifact: { url: 'https://public.example.com/p.json', sha256: 'wrong' } }] }));
});

test('real workerd source and Hook requests accept success and reject redirects without following them', { timeout: 45000 }, async t => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const requests = []; let redirectUpstream = false;
  const directory = { schemaVersion: 1, id: 'third', name: 'Third', plugins: [{
    manifest: manifest('third-party'), artifact: { url: 'https://packages.example.net/third.json', sha256: 'c'.repeat(64) },
  }] };
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'plugin-delivery-transport',
    compatibilityDate: '2026-09-23', modules: true,
    script: `export default { async fetch(request) {
      const { url, init } = await request.json();
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
        return Response.json({ status: response.status, body: await response.text(),
          headers: [...response.headers] });
      } catch (error) { return Response.json({ transportError: error.message }); }
    } };`,
    outboundService: request => {
      requests.push({ url: request.url, method: request.method });
      const body = request.method === 'POST' ? { success: true, result: { build_uuid: 'runtime-build-id' } } : directory;
      return Response.json(body, redirectUpstream ? { status: 302,
        headers: { Location: 'https://untrusted.example.net/must-not-follow' } } : {});
    },
  }] }));
  t.after(() => mf.dispose());
  const fetchImpl = async (url, init) => {
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    const { signal, ...serializable } = init;
    // Preserve the production RequestInit across the test boundary; rebuild
    // only AbortSignal, which cannot be serialized between Node and workerd.
    const result = await (await mf.dispatchFetch('http://local.test/forward', { method: 'POST',
      body: JSON.stringify({ url, init: serializable }) })).json();
    assert.equal(result.transportError, undefined, 'production RequestInit must be accepted by real workerd');
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  const success = await app(t, { fetchImpl });
  const added = await success.delivery.addSource(success.env, success.signed.session,
    { revision: (await success.get()).revision, url: 'https://plugins.example.net/directory.json' });
  assert.equal(added.sources.find(row => !row.official).status, 'ready');
  await success.config({ deployHookUrl: hook, buildToken: token }); await success.select();
  const queued = await success.build();
  assert.equal(queued.build.status, 'queued'); assert.equal(queued.build.providerBuildId, 'runtime-build-id');

  redirectUpstream = true;
  const redirected = await app(t, { fetchImpl });
  await assert.rejects(redirected.delivery.addSource(redirected.env, redirected.signed.session,
    { revision: (await redirected.get()).revision, url: 'https://plugins.example.net/redirect.json' }),
  { code: 'PLUGIN_SOURCE_UNAVAILABLE' });
  assert.equal((await redirected.get()).sources.length, 1, 'redirect does not add a source');
  await redirected.config({ deployHookUrl: hook, buildToken: token }); await redirected.select();
  const rejected = await redirected.build();
  assert.equal(rejected.build.status, 'failed'); assert.equal(rejected.build.error, 'PLUGIN_BUILD_TRIGGER_FAILED');
  assert.equal(rejected.build.providerBuildId, null, 'a success-shaped redirect body cannot authorize a build');
  assert.equal((await redirected.registry.readInstallation(redirected.env, 'sample')).installed, false);
  assert.equal(requests.length, 4, 'neither source nor Hook follows a redirect');
  assert.ok(requests.every(row => !row.url.includes('untrusted.example.net')));
});

test('manual selection is pending, batches changes and never activates or triggers until build requested', async t => {
  const f = await app(t, { manifests: [manifest(), manifest('second')] });
  let status = await f.select();
  assert.equal(status.running.length, 0); assert.equal(status.desired.length, 1);
  assert.deepEqual(status.pending, [{ id: 'sample', operation: 'install', fromVersion: null, toVersion: '1.0.0' }]);
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, false);
  status = await f.select(true, { pluginId: 'second' });
  assert.equal(status.pending.length, 2); assert.equal(f.calls.length, 0);
  status = await f.build();
  assert.equal(status.build.status, 'failed'); assert.equal(status.build.error, 'PLUGIN_BUILD_NOT_CONFIGURED');
  assert.equal(status.desired.length, 2); assert.equal(f.calls.length, 0);
  status = await f.delivery.discard(f.env, f.signed.session, { revision: status.revision });
  assert.equal(status.pending.length, 0);
});

test('selection freezes new-install UI language through build activation while retaining existing installation language', async t => {
  const f = await app(t, { manifests: [manifest(), manifest('second')] });
  await f.registry.setInstalled(f.env, f.signed.session, 'sample', { installed: true, revision: 0 }, { uiLanguage: 'ja' });
  const original = await f.registry.readInstallation(f.env, 'sample');
  await f.config({ deployHookUrl: hook, buildToken: token });
  await f.delivery.select(f.env, f.signed.session, { revision: (await f.get()).revision,
    pluginId: 'second', installed: true }, { uiLanguage: 'ko-KR' });
  const persisted = () => JSON.parse(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?')
    .get(PLUGIN_DELIVERY_KEY).value_json);
  assert.equal(persisted().installationLanguages.second, 'ko');
  await f.build();
  assert.equal(persisted().build.installationLanguages.second, 'ko');
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
    plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
  await f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' });
  assert.equal((await f.registry.readInstallation(f.env, 'second')).uiLanguage, 'ko');
  const retained = await f.registry.readInstallation(f.env, 'sample');
  assert.equal(retained.uiLanguage, 'ja'); assert.equal(retained.epoch, original.epoch);
  await f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' });
  assert.equal((await f.registry.readInstallation(f.env, 'second')).uiLanguage, 'ko', 'duplicate acknowledgements do not relabel an installation');
});

test('compiled official packages retain their artifact provenance and existing administrator installation epoch', async t => {
  const source={type:'artifact',id:'official',url:'https://packages.example.net/sample.json',sha256:'c'.repeat(64)};
  const f=await app(t,{sources:{sample:source}});
  let state=await f.get();
  assert.equal(state.running.length,0,'Compiling a package must not install it');
  assert.deepEqual(state.catalog[0].source,source);
  await assert.rejects(f.select(),{code:'PLUGIN_CODE_TRUST_REQUIRED'});
  await f.registry.setInstalled(f.env,f.signed.session,'sample',{installed:true,revision:0});
  const epoch=(await f.registry.readInstallation(f.env,'sample')).epoch;
  state=await f.get();assert.equal(state.running[0].sourceId,'official');assert.deepEqual(state.running[0].source,source);
  assert.equal((await f.registry.readInstallation(f.env,'sample')).epoch,epoch);
  await f.config({deployHookUrl:hook,buildToken:token});
  await f.select(false);await f.build();
  const snapshot=await f.delivery.snapshot(f.env,authorized());
  assert.deepEqual(snapshot.plugins,[],'Removing a compiled official package must produce an empty code plan');
  assert.equal((await f.registry.readInstallation(f.env,'sample')).epoch,epoch,'Selecting a future plan does not retire current data or epoch');
});

test('automatic mode triggers only explicit selection, freezes its snapshot and token scope excludes management', async t => {
  const f = await app(t);
  await assert.rejects(f.config({ mode: 'auto' }), { code: 'PLUGIN_BUILD_NOT_CONFIGURED' });
  await f.config({ mode: 'auto', deployHookUrl: hook, buildToken: token }); assert.equal(f.calls.length, 0);
  const status = await f.select();
  assert.equal(status.build.status, 'queued'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], hook); assert.equal(f.calls[0][1].redirect, 'manual');
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  assert.equal(snapshot.buildId, status.build.id); assert.deepEqual(snapshot.host, host); assert.equal(snapshot.plugins[0].id, 'sample');
  await assert.rejects(f.select(false), { code: 'PLUGIN_BUILD_IN_PROGRESS' });
  await assert.rejects(f.delivery.snapshot(f.env, new Request('https://test.example')), { code: 'forbidden' });
  await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: 'stale', planDigest: snapshot.planDigest, status: 'deployed' }), { code: 'PLUGIN_BUILD_CHANGED' });
  await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' }), { code: 'PLUGIN_DEPLOYMENT_NOT_READY' });
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, false);
});

test('actual deployed metadata atomically activates the frozen plan and old reports cannot overwrite a new task', async t => {
  const f = await app(t);
  await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  await f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'building' });
  Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
    plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
  await f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' });
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, true);
  assert.equal((await f.get()).pending.length, 0); assert.equal((await f.get()).build.status, 'deployed');
  assert.equal((await f.delivery.snapshot(f.env, authorized())).buildStatus, 'deployed', 'pipeline can distinguish committed data after a lost acknowledgement');
  const epoch = (await f.registry.readInstallation(f.env, 'sample')).epoch;
  await f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' });
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).epoch, epoch, 'duplicate reports do not reinstall');
  await f.select(false); await f.build();
  await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' }), { code: 'PLUGIN_BUILD_CHANGED' });
});

test('failed builds retain running plugins, selection can be discarded and dependency-breaking plans are rejected', async t => {
  const f = await app(t, { manifests: [manifest(), manifest('dependent', { dependencies: { sample: { apiVersion: 1 } } })] });
  await f.registry.setInstalled(f.env, f.signed.session, 'sample', { installed: true, revision: 0 });
  await f.config({ deployHookUrl: hook, buildToken: token });
  await f.select(true, { pluginId: 'dependent' });
  await assert.rejects(f.select(false), { code: 'PLUGIN_SELECTION_INCOMPATIBLE' });
  const status = await f.build(); const snapshot = await f.delivery.snapshot(f.env, authorized());
  await f.delivery.report(f.env, authorized(), { buildId: status.build.id, planDigest: snapshot.planDigest, status: 'failed' });
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, true);
  assert.equal((await f.registry.readInstallation(f.env, 'dependent')).installed, false);
  const failed = await f.get(); assert.equal(failed.build.status, 'failed');
  const discarded = await f.delivery.discard(f.env, f.signed.session, { revision: failed.revision });
  assert.equal(discarded.pending.length, 0); assert.deepEqual(discarded.desired.map(row => row.id), ['sample']);
});

test('unknown trigger result has explicit recovery and invalidates old snapshot/report before editing', async t => {
  const f = await app(t, { fetchImpl: async () => { throw new Error('network'); } });
  await f.config({ deployHookUrl: hook, buildToken: token }); await f.select();
  const failed = await f.build(); assert.equal(failed.build.resultUnknown, true);
  await assert.rejects(f.select(false), { code: 'PLUGIN_BUILD_RESULT_UNKNOWN' });
  await assert.rejects(f.delivery.resolveBuild(f.env, f.signed.session, { revision: failed.revision, confirmedStopped: false }), { code: 'PLUGIN_BUILD_RESOLUTION_REQUIRED' });
  const resolved = await f.delivery.resolveBuild(f.env, f.signed.session, { revision: failed.revision, confirmedStopped: true });
  assert.equal(resolved.build.status, 'cancelled'); assert.equal(resolved.pending.length, 1);
  await assert.rejects(f.delivery.snapshot(f.env, authorized()), { code: 'PLUGIN_BUILD_NOT_ACTIVE' });
  await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: failed.build.id, planDigest: failed.build.planDigest, status: 'deployed' }), { code: 'PLUGIN_BUILD_CHANGED' });
  assert.equal((await f.select(false)).pending.length, 0);
});

test('catalog refresh preserves deployed and selected source provenance; third-party install requires explicit trust', async t => {
  const directory = { schemaVersion: 1, id: 'official', name: 'A third party', plugins: [{ manifest: manifest('third-party'),
    artifact: { url: 'https://plugins.publisher.com/third-party-1.0.0.json', sha256: 'c'.repeat(64) } }] };
  const f = await app(t, { fetchImpl: async () => Response.json(directory) });
  let status = await f.delivery.addSource(f.env, f.signed.session, { revision: 0, url: 'https://plugins.publisher.com/repository.json' });
  const source = status.sources.find(row => !row.official);
  assert.notEqual(source.id, 'official', 'untrusted self-reported identity cannot claim the official source');
  await assert.rejects(f.select(true, { pluginId: 'third-party', sourceId: source.id, version: '1.0.0' }), { code: 'PLUGIN_CODE_TRUST_REQUIRED' });
  status = await f.select(true, { pluginId: 'third-party', sourceId: source.id, version: '1.0.0', trustCode: true });
  assert.equal(status.desired[0].source.sha256, 'c'.repeat(64));
  status = await f.delivery.removeSource(f.env, f.signed.session, source.id, { revision: status.revision });
  assert.equal(status.desired.length, 1, 'removing a catalog does not discard an installation plan');
  assert.equal(status.catalog.some(row => row.id === 'third-party'), false);
});

test('administrator revocation during asynchronous source fetch cannot save state', async t => {
  let f;
  f = await app(t, { fetchImpl: async () => {
    f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), f.signed.session.tokenHash);
    return Response.json({ schemaVersion: 1, id: 'third', name: 'Third', plugins: [] });
  } });
  await assert.rejects(f.delivery.addSource(f.env, f.signed.session, { revision: 0, url: 'https://plugins.publisher.com/repository.json' }), { code: 'forbidden' });
  assert.equal(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(PLUGIN_DELIVERY_KEY), undefined);
});

test('a third-party directory cannot replace a workspace-owned plugin ID', async t => {
  const f = await app(t, { fetchImpl: async () => Response.json({ schemaVersion: 1, id: 'third', name: 'Third',
    plugins: [{ manifest: manifest(), artifact: { url: 'https://plugins.publisher.com/sample.json', sha256: 'c'.repeat(64) } }] }) });
  const state = await f.delivery.addSource(f.env, f.signed.session, { revision: 0, url: 'https://plugins.publisher.com/repository.json' });
  const sourceId = state.sources.find(source => !source.official).id;
  await assert.rejects(f.select(true, { sourceId, version: '1.0.0', trustCode: true }), { code: 'PLUGIN_SOURCE_CONFLICT' });
  assert.equal((await f.get()).desired.length, 0);
});

test('transaction failure rolls back activation, delivery state and installation epochs together', async t => {
  const f = await app(t);
  await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
    plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
  const before = f.sqlite.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').get(PLUGIN_DELIVERY_KEY);
  f.db.fail = /INSERT INTO instance_settings\(key,value_json,revision,updated_at,updated_by\) VALUES/;
  await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' }), { code: 'PLUGIN_BUILD_APPLY_FAILED' });
  assert.deepEqual(f.sqlite.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').get(PLUGIN_DELIVERY_KEY), before);
  assert.equal(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(installationKey('sample')), undefined);
});

test('activation prepares real plugin migrations and a failed DDL rolls back the ledger and installation', async t => {
  const statements = ['CREATE TABLE plugin_sample__items (id TEXT PRIMARY KEY)'];
  const migrations = [{ version: 1, statements, checksum: await migrationChecksum(statements) }];
  const f = await app(t, { manifests: [manifest('sample', { dataVersion: 1 })], modules: { sample: { migrations } } });
  await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
    plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
  f.db.fail = /CREATE TABLE plugin_sample__items/;
  await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' }), { code: 'PLUGIN_BUILD_APPLY_FAILED' });
  assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='plugin_sample__items'").get(), undefined);
  assert.equal(f.sqlite.prepare("SELECT value_json FROM instance_settings WHERE key='plugin.migrations.sample'").get(), undefined);
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, false);
  f.db.fail = null;
  await f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' });
  assert.equal(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='plugin_sample__items'").get().name, 'plugin_sample__items');
  assert.equal((await f.registry.requirePluginInstalled(f.env, 'sample')).installed, true);
});

test('a legacy installation change after snapshot prevents the pipeline from applying a stale target set', async t => {
  const f = await app(t, { manifests: [manifest(), manifest('second')] });
  await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
    plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
  await f.registry.setInstalled(f.env, f.signed.session, 'second', { installed: true, revision: 0 });
  await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' }), { code: 'PLUGIN_DELIVERY_CHANGED' });
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, false);
  assert.equal((await f.registry.readInstallation(f.env, 'second')).installed, true);
});

test('post-deployment failures stay uncertain until the live prior deployment really returns', async t => {
  const f = await app(t);
  await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  const report = status => f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status });
  await report('deploying');
  await report('failed');
  let state = await f.get();
  assert.equal(state.build.status, 'activation_pending'); assert.equal(state.build.resultUnknown, true);
  await assert.rejects(f.select(false), { code: 'PLUGIN_BUILD_RESULT_UNKNOWN' });
  await report('rolling_back');
  Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest });
  await assert.rejects(report('rolled_back'), { code: 'PLUGIN_ROLLBACK_NOT_CONFIRMED' });
  delete f.deployment.buildId; delete f.deployment.planDigest;
  await report('rolled_back');
  state = await f.get();
  assert.equal(state.build.status, 'failed'); assert.equal(state.build.resultUnknown, false);
  assert.equal(state.build.error, 'PLUGIN_BUILD_ROLLED_BACK');
  assert.equal((await f.select(false)).pending.length, 0);
});

test('a new compiled plugin version cannot serve business before its deployment is confirmed', async t => {
  const f = await app(t);
  await f.registry.setInstalled(f.env, f.signed.session, 'sample', { installed: true, revision: 0 });
  const previous = manifest(); const next = manifest('sample', { version: '2.0.0' });
  const source = { type: 'artifact', id: 'source-third', url: 'https://plugins.publisher.com/sample-1.json', sha256: 'c'.repeat(64) };
  const nextSource = { ...source, url: 'https://plugins.publisher.com/sample-2.json', sha256: 'd'.repeat(64) };
  const value = { mode: 'manual', secrets: null, sources: [], desired: null,
    running: [{ id: 'sample', version: previous.version, manifest: previous, sourceId: source.id, sourceName: 'Third', source }],
    activeDeployment: { buildId: 'old-build', planDigest: 'e'.repeat(64) }, build: null };
  f.sqlite.prepare('INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,?)')
    .run(PLUGIN_DELIVERY_KEY, JSON.stringify(value), Date.now(), f.owner);
  const deployment = { buildId: 'new-build', planDigest: 'f'.repeat(64), plugins: [{ id: 'sample', version: next.version, source: nextSource }] };
  const liveRegistry = createPluginRegistry({ manifests: [next], builds: [{ id: 'sample', sourceDigest: '9'.repeat(64) }], deployment });
  let listed = await liveRegistry.listPlugins(f.env, f.signed.session, true);
  assert.equal(listed.plugins[0].availability.reason, 'deployment_pending');
  await assert.rejects(liveRegistry.requirePluginInstalled(f.env, 'sample'), { code: 'PLUGIN_UNAVAILABLE' });
  const liveDelivery = createPluginDelivery({ registry: liveRegistry, host, deployment });
  assert.equal((await liveDelivery.get(f.env, f.signed.session)).running[0].version, '1.0.0', 'unconfirmed code does not rewrite committed version claims');
  value.activeDeployment = { buildId: deployment.buildId, planDigest: deployment.planDigest };
  f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify(value), PLUGIN_DELIVERY_KEY);
  listed = await liveRegistry.listPlugins(f.env, f.signed.session, true);
  assert.equal(listed.plugins[0].availability.available, true);
});

test('rotating the instance secret exposes reconnect state and permits explicit replacement of both delivery credentials', async t => {
  const f = await app(t);
  await f.config({ deployHookUrl: hook, buildToken: token });
  f.env.SETUP_SECRET = 'replacement-test-only-setup-secret-at-least-32-characters';
  assert.equal((await f.get()).settings.needsReconnect, true);
  await f.config({ deployHookUrl: hook, buildToken: token });
  assert.equal((await f.get()).settings.needsReconnect, undefined);
  assert.equal((await f.get()).settings.buildTokenConfigured, true);
});

test('dispatch constructs only the requested, authorized and installed plugin handler', async t => {
  const f = await app(t, { manifests: [manifest('sample', { capabilityRoles: ['admin', 'member'] }),
    manifest('other', { capabilityRoles: ['admin', 'member'] })] });
  await f.registry.setInstalled(f.env, f.signed.session, 'sample', { installed: true, revision: 0 });
  let sampleCalls = 0; let otherCalls = 0;
  const modules = { sample: { createHandler() { sampleCalls++; return ({ json }) => json({ ok: true }); } },
    other: { createHandler() { otherCalls++; throw new Error('unrelated factory must not run'); } } };
  const json = (body, status = 200) => Response.json(body, { status });
  const request = id => new Request(`https://test.example/api/account/plugins/${id}/status`, { headers: { 'X-FlareTune-Plugin-Build': 'b'.repeat(64) } });
  const response = await handlePluginApi(request('sample'), '/api/account/plugins/sample/status', f.env, f.signed.session, json, { registry: f.registry, modules });
  assert.equal(response.status, 200); assert.equal(sampleCalls, 1); assert.equal(otherCalls, 0);
  const denied = await handlePluginApi(request('other'), '/api/account/plugins/other/status', f.env, f.signed.session, json, { registry: f.registry, modules });
  assert.equal(denied.status, 409); assert.equal(otherCalls, 0);
});

test('failed snapshots cannot activate after the administrator discards or edits the target plan', async t => {
  for (const action of ['discard', 'edit']) await t.test(action, async t => {
    const f = await app(t, { manifests: [manifest(), manifest('second')] });
    await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
    const snapshot = await f.delivery.snapshot(f.env, authorized());
    await f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'failed' });
    if (action === 'discard') await f.delivery.discard(f.env, f.signed.session, { revision: (await f.get()).revision });
    else await f.select(true, { pluginId: 'second' });
    Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
      plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
    await assert.rejects(f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' }), { code: 'PLUGIN_BUILD_NOT_ACTIVE' });
    assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, false);
    assert.equal((await f.registry.readInstallation(f.env, 'second')).installed, false);
  });
});

test('duplicate deployment acknowledgement still requires the currently served compiled metadata', async t => {
  const f = await app(t);
  await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
  const snapshot = await f.delivery.snapshot(f.env, authorized());
  Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
    plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
  const input = { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status: 'deployed' };
  await f.delivery.report(f.env, authorized(), input);
  delete f.deployment.buildId;
  await assert.rejects(f.delivery.report(f.env, authorized(), input), { code: 'PLUGIN_DEPLOYMENT_NOT_READY' });
  assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, true, 'a rejected acknowledgement does not roll back committed data');
});

test('rollback intent and activation exclude each other before either can change provider code', async t => {
  for (const winner of ['rollback', 'activation']) await t.test(winner, async t => {
    const f = await app(t);
    await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
    const snapshot = await f.delivery.snapshot(f.env, authorized());
    Object.assign(f.deployment, { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host,
      plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) });
    const report = status => f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status });
    if (winner === 'rollback') {
      await report('rolling_back');
      await assert.rejects(report('deployed'), { code: 'PLUGIN_BUILD_CHANGED' });
      await report('activation_pending');
      await assert.rejects(report('deployed'), { code: 'PLUGIN_BUILD_CHANGED' });
      assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, false);
    } else {
      await report('deployed');
      await assert.rejects(report('rolling_back'), { code: 'PLUGIN_BUILD_CHANGED' });
      assert.equal((await f.registry.readInstallation(f.env, 'sample')).installed, true);
    }
  });
});

test('post-deployment uncertainty cannot be cancelled or replaced by a new administrator build', async t => {
  for (const phase of ['deploying', 'rolling_back']) await t.test(phase, async t => {
    const f = await app(t);
    await f.config({ deployHookUrl: hook, buildToken: token }); await f.select(); await f.build();
    const snapshot = await f.delivery.snapshot(f.env, authorized());
    const report = status => f.delivery.report(f.env, authorized(), { buildId: snapshot.buildId, planDigest: snapshot.planDigest, status });
    await report(phase); await report('activation_pending');
    const current = await f.get(); assert.equal(current.build.deploymentStarted, true);
    await assert.rejects(f.delivery.resolveBuild(f.env, f.signed.session, { revision: current.revision, confirmedStopped: true }), { code: 'PLUGIN_DEPLOYMENT_UNCONFIRMED' });
    await assert.rejects(f.build(), { code: 'PLUGIN_DEPLOYMENT_UNCONFIRMED' });
    assert.equal((await f.get()).build.id, snapshot.buildId, 'the frozen build and recovery receipt remain valid');
  });
});
