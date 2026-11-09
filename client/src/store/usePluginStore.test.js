import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
import { resolvePluginAvailability } from '../../../shared/plugins/manifest.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';

const account = id => ({ authenticated: true, user: { accountId: id, role: 'admin' }, csrfToken: `csrf-${id}` });
const row = (installed, revision = 0) => ({ id: 'xiaomi-speaker', version: compiledPluginManifests.find(item => item.id === 'xiaomi-speaker').version,
  buildDigest: pluginBuilds.find(item => item.id === 'xiaomi-speaker').sourceDigest, installed, revision });
function pluginHarness({ manifests = compiledPluginManifests, builds = pluginBuilds } = {}) {
  let session = account('A'), listener;
  const calls = [];
  const harness = createBackgroundModuleHarness({ file: new URL('./usePluginStore.js', import.meta.url),
    modules: { zustand: { create }, './useUIStore.js': { useUIStore: { getState: () => ({ authSession: session }), subscribe: callback => { listener = callback; } } },
      '../services/plugins.js': { pluginsRequest: (owner, options) => new Promise((resolve, reject) => calls.push({ owner, ...options, resolve, reject })) },
      '../../../shared/plugins/catalog.js': { compiledPluginManifests: manifests },
      '../../../shared/plugins/manifest.js': { resolvePluginAvailability },
      '../../../shared/plugins/build.generated.js': { pluginBuilds: builds } },
    globals: { AbortController, DOMException },
  });
  return { store: harness.exports.usePluginStore, calls, owner: () => session,
    switchAccount(id) { const previous = session; session = account(id); listener({ authSession: session }, { authSession: previous }); },
    async answer(index, response) { calls[index].resolve(response); await flushBackgroundAsync(); } };
}

test('registration never installs by default and account/admin reads keep separate cache scopes', async () => {
  const subject = pluginHarness(), store = subject.store;
  assert.equal(store.getState().installedIds.length, 0); assert.equal(store.getState().loaded, false);
  const personal = store.getState().refresh(subject.owner());
  const admin = store.getState().refresh(subject.owner(), { admin: true });
  assert.equal(store.getState().refresh(subject.owner(), { admin: true }), admin, 'same-scope in-flight reads are shared');
  await flushBackgroundAsync(); assert.equal(subject.calls.length, 2);
  await subject.answer(1, { plugins: [row(false)] }); await admin;
  await subject.answer(0, { plugins: [] }); await personal;
  assert.equal(store.getState().lists.admin.plugins.length, 1);
  assert.equal(store.getState().lists.account.plugins.length, 0);
  assert.equal(store.getState().isInstalled('xiaomi-speaker'), false);
  assert.equal(subject.calls.length, 2);
});

test('hidden dependency installation state keeps a visible consumer usable without adding hidden personal rows', async () => {
  const base = id => ({ id, version: '1.0.0', hostApiVersion: 1, apiVersion: 1, name: id, description: id, icon: 'box', pages: [], entries: [] });
  const manifests = [base('gateway'), { ...base('consumer'), dependencies: { gateway: { apiVersion: 1 } } }];
  const subject = pluginHarness({ manifests, builds: [] }), store = subject.store;
  const read = store.getState().refresh(subject.owner()); await flushBackgroundAsync();
  await subject.answer(0, { plugins: [{ id: 'consumer', version: '1.0.0', installed: true, revision: 1,
    availability: { available: true, reason: null, issues: [], optionalFeatures: {} } }], dependencyInstalledIds: ['gateway'] });
  await read;
  assert.deepEqual(store.getState().plugins.map(row => row.id), ['consumer']);
  assert.deepEqual(store.getState().lists.account.plugins.map(row => row.id), ['consumer']);
  assert.equal(store.getState().availabilityById.consumer.available, true);
  assert.equal(store.getState().installedIds.includes('gateway'), true);
  subject.switchAccount('B');
  assert.equal(store.getState().installedIds.length, 0);
});

test('availability retains backend dependency metadata and rejects an installed build from another tab version', async () => {
  const subject = pluginHarness(), store = subject.store;
  let read = store.getState().refresh(subject.owner(), { admin: true }); await flushBackgroundAsync();
  const installed = { ...row(true), manifestDigest: 'manifest-hash', availability: {
    available: true, reason: null, issues: [], optionalFeatures: {} }, dependencies: { helper: { apiVersion: 1 } } };
  await subject.answer(0, { plugins: [installed] }); await read;
  assert.equal(store.getState().isAvailable('xiaomi-speaker'), true);
  assert.equal(store.getState().plugins[0].manifestDigest, 'manifest-hash');
  assert.deepEqual(store.getState().plugins[0].dependencies, { helper: { apiVersion: 1 } });
  read = store.getState().refresh(subject.owner(), { admin: true }); await flushBackgroundAsync();
  await subject.answer(1, { plugins: [{ ...installed, availability: { available: false, reason: 'configuration_required',
    optionalFeatures: { annotations: { available: false, reason: 'unconfigured' } } } }] }); await read;
  assert.equal(store.getState().isAvailable('xiaomi-speaker'), false, 'server configuration restrictions remain authoritative');
  assert.equal(store.getState().availabilityById['xiaomi-speaker'].reason, 'configuration_required');
  assert.equal(store.getState().availabilityById['xiaomi-speaker'].optionalFeatures.annotations.available, false);
  read = store.getState().refresh(subject.owner(), { admin: true }); await flushBackgroundAsync();
  await subject.answer(2, { plugins: [{ ...installed, buildDigest: 'new-server-build' }] }); await read;
  assert.equal(store.getState().isInstalled('xiaomi-speaker'), true);
  assert.equal(store.getState().isAvailable('xiaomi-speaker'), false);
  assert.equal(store.getState().availabilityById['xiaomi-speaker'].reason, 'incompatible_version');
  subject.switchAccount('B');
  assert.deepEqual(Object.keys(store.getState().availabilityById), []);
});

test('installation changes notify all subscribers and stale personal reads cannot undo a confirmed write', async () => {
  const subject = pluginHarness(), store = subject.store, observations = [];
  store.subscribe(state => observations.push([...state.installedIds]));
  const initial = store.getState().refresh(subject.owner(), { admin: true }); await flushBackgroundAsync();
  await subject.answer(0, { plugins: [row(false)] }); await initial;
  const stale = store.getState().refresh(subject.owner()); await flushBackgroundAsync();
  const install = store.getState().setInstalled('xiaomi-speaker', true, 0, subject.owner());
  assert.equal(subject.calls[2].installed, true); assert.equal(subject.calls[2].revision, 0);
  await subject.answer(2, { plugin: row(true, 1) }); await install;
  await subject.answer(1, { plugins: [] }); await stale;
  assert.equal(store.getState().isInstalled('xiaomi-speaker'), true);
  assert.ok(observations.some(ids => ids.includes('xiaomi-speaker')));
  assert.equal(store.getState().lists.admin.plugins[0].revision, 1);
  store.getState().markUninstalled('xiaomi-speaker');
  assert.equal(store.getState().isInstalled('xiaomi-speaker'), false);
  assert.equal(store.getState().lists.account.plugins.length, 0);
});

test('account changes immediately clear cached availability and abort pending requests and writes', async () => {
  const subject = pluginHarness(), store = subject.store;
  const first = store.getState().refresh(subject.owner(), { admin: true }); await flushBackgroundAsync();
  await subject.answer(0, { plugins: [row(true, 1)] }); await first;
  const write = store.getState().setInstalled('xiaomi-speaker', false, 1, subject.owner());
  subject.switchAccount('B');
  assert.equal(subject.calls[1].signal.aborted, true);
  assert.equal(store.getState().loaded, false);
  assert.equal(store.getState().installedIds.length, 0);
  const rejected = assert.rejects(write, { name: 'AbortError' });
  await subject.answer(1, { plugin: row(false, 2) }); await rejected;
  assert.equal(store.getState().lists.admin.plugins.length, 0);
});

test('revision conflicts keep confirmed state and expose fixed safe errors without upstream detail', async () => {
  const subject = pluginHarness(), store = subject.store;
  const read = store.getState().refresh(subject.owner(), { admin: true }); await flushBackgroundAsync();
  await subject.answer(0, { plugins: [row(true, 2)] }); await read;
  const write = store.getState().setInstalled('xiaomi-speaker', false, 2, subject.owner());
  const rejected = assert.rejects(write);
  subject.calls[1].reject({ status: 409, message: 'private provider material' }); await rejected;
  assert.equal(store.getState().isInstalled('xiaomi-speaker'), true);
  assert.equal(store.getState().error, '插件状态已变化，请刷新后重试。');
  assert.equal(store.getState().busy, false);
});

test('dependency installation and reverse-uninstall rejections expose actionable fixed messages', async () => {
  for (const [code, expected] of [
    ['PLUGIN_DEPENDENCY_MISSING', '插件所需依赖尚不可用，请先检查依赖。'],
    ['PLUGIN_DEPENDENCY_INCOMPATIBLE', '插件所需依赖版本不兼容。'],
    ['PLUGIN_DEPENDENCY_CYCLE', '插件依赖存在循环，请联系管理员。'],
    ['PLUGIN_REQUIRED_BY', '其他已安装插件依赖此插件，请先卸载依赖它的插件。'],
  ]) {
    const subject = pluginHarness(), store = subject.store;
    const read = store.getState().refresh(subject.owner(), { admin: true }); await flushBackgroundAsync();
    await subject.answer(0, { plugins: [row(true, 2)] }); await read;
    const write = store.getState().setInstalled('xiaomi-speaker', false, 2, subject.owner());
    const rejected = assert.rejects(write);
    subject.calls[1].reject({ status: 409, code, message: 'private provider material' }); await rejected;
    assert.equal(store.getState().error, expected);
    assert.equal(store.getState().isInstalled('xiaomi-speaker'), true);
  }
});
