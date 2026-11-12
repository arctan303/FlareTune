import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import * as catalog from '../plugins/catalog.js';
import * as registry from '../plugins/registry.js';
import { activePluginBuild } from '../hooks/usePluginDelivery.js';
import { HOST_PLUGIN_API_VERSION, validatePluginManifests } from '../../../shared/plugins/manifest.js';

// Keep model validation in its native realm: manifest validation deliberately
// rejects foreign prototypes, whereas the component harness evaluates JSX in VM.
// Resource hooks, shared controls and delivery are boundaries; catalog selection,
// overview routing, version rendering and confirmation state are real components.
const expandedComponents = new Set(['PluginVersionSummary', 'PluginCatalogNotice', 'PluginCatalogVersions', 'PluginLink']);
const nodes = tree => {
  if (!tree || typeof tree !== 'object') return [];
  const rendered = typeof tree.type === 'function' && expandedComponents.has(tree.type.name) ? tree.type(tree.props) : null;
  return [tree, ...[rendered, tree.props?.children, tree.props?.action, tree.props?.meta].flat(Infinity).flatMap(nodes)];
};
const text = tree => {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  const rendered = typeof tree.type === 'function' && expandedComponents.has(tree.type.name) ? tree.type(tree.props) : null;
  return [rendered, tree.props?.children, tree.props?.action, tree.props?.meta].flat(Infinity).map(text).join('');
};
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const confirmation = tree => nodes(tree).find(node => node.type === 'confirmation');
const sourceSelector = (tree, label = '来源') => nodes(tree).find(node => node.type === 'select' && node.props['aria-label'] === label);
const cards = tree => nodes(tree).filter(node => node.type === 'section' && node.props.className?.split(' ').includes('plugin-catalog-card'));
const translate = (key, parameters = {}) => key.replace(/\{(\w+)\}/gu, (_, name) => parameters[name] ?? `{${name}}`);

function release(version, sourceId = 'official', manifestFields = {}) {
  const manifest = { id: 'test-plugin', version, hostApiVersion: HOST_PLUGIN_API_VERSION, apiVersion: 1, dataVersion: 1,
    name: 'Test plugin', description: 'Synthetic catalog fixture', icon: 'puzzle', pages: [], entries: [],
    capabilityRoles: ['admin', 'member'], ...manifestFields };
  validatePluginManifests([manifest]);
  return { id: manifest.id, version, manifest, sourceId, sourceName: sourceId === 'official' ? 'Official fixture' : 'Community fixture',
    source: sourceId === 'workspace' ? { type: 'workspace', id: sourceId }
      : { type: 'artifact', id: sourceId, url: `https://example.invalid/${sourceId}/repository.json` } };
}
function artifactRelease(version, digest) {
  const row = release(version);
  return { ...row, source: { ...row.source, sha256: digest.repeat(64) } };
}
function fixtureData({ running = [], desired = running, releases = [], pending = [], build = null } = {}) {
  return { revision: 7, settings: { mode: 'manual' },
    sources: ['official', 'community'].map(id => ({ id, name: id, status: 'ready', url: `https://example.invalid/${id}/repository.json` })),
    catalog: releases, running, desired, pending, build };
}
const exactSelection = (version, sourceId = 'official') => ['/selection', 'PUT', {
  pluginId: 'test-plugin', installed: true, sourceId, version, trustCode: true,
}];
function deliveryFixture(data) {
  const writes = [];
  const delivery = { data, busy: false, error: '', failNext: false, refresh: async () => {},
    action: async (...args) => {
      writes.push(structuredClone(args));
      if (delivery.failNext) { delivery.failNext = false; delivery.error = 'Synthetic selection failure'; throw new Error(delivery.error); }
      delivery.error = ''; return data;
    } };
  return { delivery, writes };
}
const uiModules = {
  '../i18n/index.js': { t: translate, useLocale: () => 'zh' },
  '../plugins/catalog.js': catalog,
  './SelectControl.jsx': 'select', './SettingsSection.jsx': 'section',
  './SettingsControls.jsx': { SettingsButton: 'button', SettingsActions: 'actions' },
  './PluginConfirmDialog.jsx': 'confirmation',
  './PluginDeliveryView.jsx': { __esModule: true, default: 'delivery-view', PluginDeliveryStatus: 'delivery-status' },
};
function catalogView(data) {
  const { delivery, writes } = deliveryFixture(data);
  const harness = createBackgroundModuleHarness({ file: new URL('./PluginCatalogView.jsx', import.meta.url), modules: {
    ...uiModules, '../plugins/registry.js': { localizePlugin: registry.localizePlugin },
    '../hooks/usePluginDelivery.js': { activePluginBuild },
  }, globals: {} });
  const overview = (entry, props) => ({ type: 'a', props: { ...props,
    href: `/plugins/${entry.id}/overview?source=${entry.sourceId || ''}&version=${entry.version || ''}`, children: [props.children] } });
  const view = () => harness.render({ delivery, renderLinks: () => null, renderOverviewLink: overview });
  return { ...harness, data, delivery, writes, view,
    discover() { button(view(), '发现插件').props.onClick(); return view(); } };
}
function summaryValues(tree) {
  const summary = nodes(tree).find(node => node.type === 'dl' && node.props.className === 'plugin-version-summary');
  assert.ok(summary, 'the real version summary renders');
  return Object.fromEntries(nodes(summary).filter(node => node.type === 'div').map(node => {
    const children = nodes(node);
    return [text(children.find(child => child.type === 'dt')), text(children.find(child => child.type === 'dd'))];
  }));
}

test('discovery groups unordered versions and sources into one entry per stable plugin ID', () => {
  const current = release('0.2.2');
  const s = catalogView(fixtureData({ running: [current], releases: [release('0.1.0'), release('0.9.0', 'community'), current,
    release('0.2.3'), release('0.2.1'), release('1.0.0', 'official', { id: 'another-plugin', name: 'Another plugin' })] }));
  const tree = s.discover();
  assert.equal(cards(tree).length, 2);
  assert.equal(nodes(tree).filter(node => node.type === 'a' && node.props.href.startsWith('/plugins/test-plugin/')).length, 1);
  assert.deepEqual(summaryValues(cards(tree).find(card => text(card).includes('Test plugin'))), { 当前版本: '0.2.2', 最新版本: '0.2.3' });
  assert.deepEqual(s.writes, []);
  s.unmount();
});

test('a running 0.2.2 never offers a 0.2.1 or identical release as an update in either tab', () => {
  for (const version of ['0.2.1', '0.2.2']) {
    const s = catalogView(fixtureData({ running: [release('0.2.2')], releases: [release(version)] }));
    for (const tree of [s.view(), s.discover()]) {
      assert.equal(button(tree, '更新插件'), undefined);
      assert.equal(button(tree, '安装插件'), undefined);
    }
    assert.equal(confirmation(s.view()), undefined);
    assert.deepEqual(s.writes, []);
    s.unmount();
  }
});

test('same-source update cancellation writes nothing, and failed confirmation retries its captured exact target', async () => {
  const current = release('0.2.2'), target = release('0.2.3');
  const s = catalogView(fixtureData({ running: [current], releases: [target, current] }));
  button(s.view(), '更新插件').props.onClick();
  let confirm = confirmation(s.view());
  assert.equal(confirm.props.operation, 'update'); assert.equal(confirm.props.fromVersion, '0.2.2');
  assert.equal(confirm.props.targetVersion, '0.2.3'); assert.equal(confirm.props.sourceName, 'Official fixture');
  assert.equal(confirm.props.deferred, true); assert.equal(confirm.props.deliveryMode, 'manual');
  confirm.props.onClose();
  assert.equal(confirmation(s.view()), undefined); assert.deepEqual(s.writes, []);
  button(s.view(), '更新插件').props.onClick();
  s.delivery.failNext = true;
  await confirmation(s.view()).props.onConfirm();
  confirm = confirmation(s.view());
  assert.ok(confirm); assert.equal(confirm.props.error, 'Synthetic selection failure');
  assert.deepEqual(s.writes, [exactSelection('0.2.3')]);
  // A refresh may publish another release while the failed transaction is open.
  s.data.catalog.push(release('0.2.4'));
  assert.equal(confirmation(s.view()).props.targetVersion, '0.2.3');
  await confirmation(s.view()).props.onConfirm();
  assert.deepEqual(s.writes, [exactSelection('0.2.3'), exactSelection('0.2.3')]);
  assert.equal(confirmation(s.view()), undefined);
  assert.equal(s.data.running[0].version, '0.2.2');
  s.unmount();
});

test('a higher release from another source does not become an ordinary update or change ownership', () => {
  const current = release('0.2.2');
  const s = catalogView(fixtureData({ running: [current], releases: [current, release('9.0.0', 'community')] }));
  let tree = s.discover();
  assert.equal(button(tree, '更新插件'), undefined);
  assert.deepEqual(summaryValues(tree), { 当前版本: '0.2.2', 最新版本: '0.2.2' });
  sourceSelector(tree).props.onChange({ target: { value: 'community' } });
  tree = s.view();
  assert.equal(cards(tree).length, 1); assert.equal(button(tree, '更新插件'), undefined);
  assert.equal(button(tree, '安装插件'), undefined);
  assert.deepEqual(summaryValues(tree), { 当前版本: '0.2.2', 最新版本: '0.2.2' });
  assert.equal(s.data.running[0].sourceId, 'official'); assert.deepEqual(s.writes, []);
  s.unmount();
});

test('an uninstalled multi-source plugin requires an explicit source before its precise installation target', async () => {
  const s = catalogView(fixtureData({ releases: [release('0.3.0'), release('2.0.0', 'community')] }));
  let tree = s.discover();
  assert.equal(cards(tree).length, 1); assert.equal(button(tree, '安装插件'), undefined);
  assert.deepEqual(summaryValues(tree), { 当前版本: '未安装', 最新版本: '请选择来源' });
  assert.match(text(tree), /选择来源后查看最新版本并安装/);
  sourceSelector(tree).props.onChange({ target: { value: 'community' } });
  tree = s.view();
  assert.deepEqual(summaryValues(tree), { 当前版本: '未安装', 最新版本: '2.0.0' });
  button(tree, '安装插件').props.onClick();
  assert.deepEqual(s.writes, []);
  assert.equal(confirmation(s.view()).props.targetVersion, '2.0.0');
  assert.equal(confirmation(s.view()).props.sourceName, 'Community fixture');
  await confirmation(s.view()).props.onConfirm();
  assert.deepEqual(s.writes, [exactSelection('2.0.0', 'community')]);
  assert.deepEqual(s.data.running, []);
  s.unmount();
});

test('an incompatible latest version remains visible while a compatible earlier new release is the update target', () => {
  const current = release('0.2.2');
  for (const incompatible of [
    { hostApiVersion: HOST_PLUGIN_API_VERSION + 1 },
    { dependencies: { 'missing-dependency': { apiVersion: 1, version: '^1.0.0' } } },
  ]) {
    const s = catalogView(fixtureData({ running: [current], releases: [release('0.4.0', 'official', incompatible), current, release('0.3.0')] }));
    const tree = s.view();
    assert.deepEqual(summaryValues(tree), { 当前版本: '0.2.2', 最新版本: '0.4.0' });
    assert.match(text(tree), /最新版本与当前宿主或依赖不兼容/); assert.match(text(tree), /可更新至 0\.3\.0/);
    button(tree, '更新插件').props.onClick();
    assert.equal(confirmation(s.view()).props.targetVersion, '0.3.0');
    assert.deepEqual(s.writes, []);
    s.unmount();
  }
});

test('unavailable sources leave the running version visible without claiming a latest version or offering an update', () => {
  const current = release('0.2.2');
  const s = catalogView(fixtureData({ running: [current], releases: [release('0.3.0')] }));
  s.data.sources[0].status = 'failed';
  const tree = s.view();
  assert.deepEqual(summaryValues(tree), { 当前版本: '0.2.2', 最新版本: '暂无法确认' });
  assert.match(text(tree), /来源暂不可用，无法确认最新版本/);
  assert.equal(button(tree, '更新插件'), undefined); assert.deepEqual(s.writes, []);
  s.unmount();
});

test('pending selection keeps current, latest and target distinct and prevents another selection', () => {
  const current = release('0.2.2'), selected = release('0.3.0');
  const s = catalogView(fixtureData({ running: [current], desired: [selected], releases: [selected, release('0.4.0'), current],
    pending: [{ id: 'test-plugin', operation: 'update', fromVersion: '0.2.2', toVersion: '0.3.0' }] }));
  const tree = s.view();
  assert.deepEqual(summaryValues(tree), { 当前版本: '0.2.2', 最新版本: '0.4.0', 待应用版本: '0.3.0' });
  assert.equal(button(tree, '更新插件').props.disabled, true);
  assert.equal(button(tree, '卸载插件').props.disabled, true);
  assert.deepEqual(s.writes, []);
  s.unmount();
});

test('busy, active build, unknown results and pending selections freeze an already-open catalog confirmation', async () => {
  for (const state of [{ busy: true }, { build: { status: 'building' } }, { build: { status: 'failed', resultUnknown: true } },
    { pending: [{ id: 'test-plugin', operation: 'update', toVersion: '0.3.0' }] }]) {
    const current = release('0.2.2');
    const s = catalogView(fixtureData({ running: [current], releases: [current, release('0.3.0')] }));
    button(s.view(), '更新插件').props.onClick();
    if (state.busy) s.delivery.busy = true;
    if (state.build) s.data.build = state.build;
    if (state.pending) s.data.pending = state.pending;
    const tree = s.view();
    assert.equal(button(tree, '更新插件').props.disabled, true);
    assert.equal(button(tree, '卸载插件').props.disabled, true);
    const confirm = confirmation(tree);
    if (!state.busy) { assert.equal(confirm.props.confirmDisabled, true); assert.ok(confirm.props.blockedMessage); }
    await confirm.props.onConfirm();
    assert.deepEqual(s.writes, []); assert.equal(s.data.running[0].version, '0.2.2');
    if (!state.busy) {
      confirm.props.onClose();
      assert.equal(confirmation(s.view()), undefined, 'frozen confirmation can still be cancelled');
    }
    s.unmount();
  }
});

function overviewView(data, { admin = true } = {}) {
  const { delivery, writes } = deliveryFixture(data), resourceWrites = [], deliveryOwners = [], resourceOwners = [], navigation = [];
  const compiled = data.running[0] || data.catalog[0], api = registry.createPluginRegistry([compiled.manifest]);
  const session = { authenticated: true, user: { accountId: 'fixture-account', role: admin ? 'admin' : 'member' }, csrfToken: 'fixture-csrf' };
  const resource = { loaded: true, loading: false, busy: false, error: '', demo: false,
    plugins: [{ id: compiled.id, version: compiled.version, installed: !!data.running.length, revision: 4 }],
    installedIds: data.running.map(row => row.id), refresh: async () => {}, setInstalled: async (...args) => { resourceWrites.push(structuredClone(args)); } };
  const harness = createBackgroundModuleHarness({ file: new URL('./PluginSettingsView.jsx', import.meta.url), modules: {
    ...uiModules, '../../../shared/uiLanguages.js': { UI_LANGUAGES: [] },
    '../plugins/registry.js': { ...api, localizePlugin: registry.localizePlugin, getPrimaryPluginSettingsPageId: registry.getPrimaryPluginSettingsPageId, isPluginVisibleToRole: registry.isPluginVisibleToRole },
    '../hooks/usePlugins.js': { usePlugins: (owner, options) => { resourceOwners.push({ owner, options }); return resource; } },
    '../hooks/usePluginDelivery.js': { activePluginBuild, usePluginDelivery: owner => {
      deliveryOwners.push(owner);
      return owner ? delivery : { data: null, busy: false, error: '', refresh: async () => {} };
    } },
    '../utils/navigation.js': { formatPath: route => `/plugins/${route.pluginId}/${route.pluginPage}`
      + (route.catalogSource ? `?source=${route.catalogSource}&version=${route.catalogVersion || ''}` : ''),
    syncBrowserHistory: path => navigation.push(path) },
    './SettingsSkeleton.jsx': 'skeleton', './PluginContentBoundary.jsx': 'plugin-content', './PluginCatalogView.jsx': 'catalog-view',
  }, globals: {} });
  const route = { type: 'page', page: 'plugin', pluginId: compiled.id, pluginPage: 'overview' };
  return { ...harness, data, delivery, writes, resourceWrites, deliveryOwners, resourceOwners, navigation,
    view: (next = route) => harness.render({ route: next, session }), route };
}

test('list and overview uninstall confirmations cannot remove a changed or vanished running package and remain cancellable', async () => {
  for (const makeView of [catalogView, overviewView]) {
    for (const change of ['version', 'artifact', 'removed']) {
      const current = artifactRelease('0.2.2', 'a');
      const replacement = artifactRelease(change === 'version' ? '0.3.0' : '0.2.2', 'b');
      const s = makeView(fixtureData({ running: [current], releases: [current, replacement] }));
      const context = `${makeView.name}: ${change}`;
      button(s.view(), '卸载插件').props.onClick();
      const original = confirmation(s.view());
      assert.equal(original.props.operation, 'uninstall', context);
      assert.equal(Boolean(original.props.confirmDisabled), false, context);
      assert.deepEqual(s.writes, [], context);

      // A concurrent completed activation has no pending/build marker to freeze
      // this dialog; its captured package identity must provide that boundary.
      s.data.running = change === 'removed' ? [] : [replacement];
      s.data.desired = [...s.data.running];
      s.data.revision++;
      const refreshed = confirmation(s.view());
      assert.ok(refreshed, context);
      assert.equal(refreshed.props.busy, false, context);
      assert.equal(refreshed.props.confirmDisabled, true, context);
      assert.ok(refreshed.props.blockedMessage, context);
      assert.deepEqual(s.data.pending, [], context);
      assert.equal(s.data.build, null, context);
      await refreshed.props.onConfirm();
      assert.deepEqual(s.writes, [], context);
      assert.deepEqual(s.resourceWrites || [], [], context);
      assert.deepEqual(s.data.running, change === 'removed' ? [] : [replacement], context);
      refreshed.props.onClose();
      assert.equal(confirmation(s.view()), undefined, `${context}: cancel closes the stale dialog`);
      assert.deepEqual(s.writes, [], context);
      s.unmount();
    }
  }
});

test('same-source same-version artifact snapshots retain unique rows and exact current, latest, pending and active states', () => {
  const current = artifactRelease('0.2.2', 'a'), republishedCurrent = artifactRelease('0.2.2', 'b');
  const selected = artifactRelease('0.3.0', 'c'), latest = artifactRelease('0.3.0', 'd');
  const data = fixtureData({ running: [current], desired: [selected], releases: [republishedCurrent, latest],
    pending: [{ id: current.id, operation: 'update', fromVersion: current.version, toVersion: selected.version }] });
  // Exercise the real version renderer and model with navigation as its boundary.
  // The shared harness does not preserve explicit props.children on a JSX
  // component, so supply its link renderer directly instead of nesting PluginLink.
  const s = createBackgroundModuleHarness({ file: new URL('./PluginCatalogVersions.jsx', import.meta.url), modules: uiModules });
  const navigation = [];
  const tree = s.render({ data, model: catalog.catalogPlugin(data, current.id), onSourceChange: source => navigation.push(source),
    renderOverviewLink: (entry, props) => ({ type: 'a', props: { ...props,
      href: `/plugins/${entry.id}/overview?source=${entry.sourceId}&version=${entry.version}`, children: [props.children] } }) });
  const rows = nodes(tree).filter(node => node.type === 'li' && node.props.className === 'plugin-version-row');
  assert.equal(rows.length, 4, 'both preserved snapshots and both republished packages are visible');
  const keys = rows.map(row => row.props.key);
  assert.ok(keys.every(key => typeof key === 'string' && key.length > 0));
  assert.equal(new Set(keys).size, 4, 'same source/version pairs must not reuse React keys');
  const seen = [];
  for (const row of rows) {
    const digest = nodes(row).find(node => node.type === 'code')?.props.title;
    assert.ok([current, republishedCurrent, selected, latest].some(entry => entry.source.sha256 === digest), 'the row identifies its exact package');
    seen.push(digest);
    const states = nodes(row).find(node => node.props.className === 'plugin-version-row__state');
    const labels = nodes(states).filter(node => node.type === 'span').map(text);
    assert.equal(labels.includes('当前运行'), digest === current.source.sha256, digest);
    assert.equal(labels.includes('最新版本'), digest === latest.source.sha256, digest);
    assert.equal(labels.includes('待应用版本'), digest === selected.source.sha256, digest);
    assert.equal(nodes(row).some(node => node.props['aria-current'] === 'page'), digest === current.source.sha256, digest);
  }
  assert.equal(new Set(seen).size, 4, 'no snapshot is duplicated in place of another artifact');
  assert.deepEqual(navigation, [], 'rendering the retained snapshots does not navigate or select a package');
  s.unmount();
});

test('an exact historical overview deep link preserves the package and remains read-only without changing the running version', () => {
  const current = release('0.2.2'), historical = release('0.2.1', 'official', { description: 'Exact historical package description' });
  const s = overviewView(fixtureData({ running: [current], releases: [release('0.3.0'), historical, current] }));
  const tree = s.view({ ...s.route, catalogSource: 'official', catalogVersion: '0.2.1' });
  assert.match(text(tree), /Exact historical package description/); assert.match(text(tree), /历史版本，仅供查看/);
  assert.deepEqual(summaryValues(tree), { 当前版本: '0.2.2', 最新版本: '0.3.0' });
  assert.equal(button(tree, '安装插件'), undefined); assert.equal(button(tree, '更新插件'), undefined);
  assert.equal(confirmation(tree), undefined);
  assert.deepEqual(s.writes, []); assert.deepEqual(s.resourceWrites, []); assert.equal(s.data.running[0].version, '0.2.2');
  const missing = s.view({ ...s.route, catalogSource: 'official', catalogVersion: '8.0.0' });
  assert.match(text(missing), /当前没有可访问的插件/); assert.equal(button(missing, '安装插件'), undefined);
  assert.deepEqual(s.writes, []);
  s.unmount();
});

test('the overview update confirmation cancels without writing and preserves its exact target after a failed save and catalog refresh', async () => {
  const current = release('0.2.2');
  const s = overviewView(fixtureData({ running: [current], releases: [current, release('0.3.0')] }));
  button(s.view(), '更新插件').props.onClick();
  let confirm = confirmation(s.view());
  assert.equal(confirm.props.targetVersion, '0.3.0'); assert.equal(confirm.props.fromVersion, '0.2.2');
  confirm.props.onClose();
  assert.deepEqual(s.writes, []); assert.equal(confirmation(s.view()), undefined);
  button(s.view(), '更新插件').props.onClick();
  s.delivery.failNext = true;
  await confirmation(s.view()).props.onConfirm();
  assert.ok(confirmation(s.view())); assert.equal(confirmation(s.view()).props.error, 'Synthetic selection failure');
  s.data.catalog.push(release('0.4.0'));
  confirm = confirmation(s.view());
  assert.equal(confirm.props.targetVersion, '0.3.0');
  await confirm.props.onConfirm();
  assert.deepEqual(s.writes, [exactSelection('0.3.0'), exactSelection('0.3.0')]);
  assert.equal(confirmation(s.view()), undefined); assert.deepEqual(s.resourceWrites, []);
  assert.equal(s.data.running[0].version, '0.2.2');
  s.unmount();
});

test('an overview cannot submit an open confirmation after a build or pending selection freezes it', async () => {
  for (const frozen of ['building', 'unknown', 'pending']) {
    const current = release('0.2.2');
    const s = overviewView(fixtureData({ running: [current], releases: [current, release('0.3.0')] }));
    button(s.view(), '更新插件').props.onClick();
    if (frozen === 'pending') s.data.pending = [{ id: 'test-plugin', operation: 'update', toVersion: '0.3.0' }];
    else s.data.build = frozen === 'building' ? { status: 'building' } : { status: 'failed', resultUnknown: true };
    const tree = s.view();
    assert.equal(button(tree, '更新插件').props.disabled, true);
    const confirm = confirmation(tree);
    assert.equal(confirm.props.confirmDisabled, true); assert.ok(confirm.props.blockedMessage);
    await confirm.props.onConfirm();
    assert.deepEqual(s.writes, [], frozen);
    assert.equal(s.data.running[0].version, '0.2.2');
    confirm.props.onClose();
    assert.equal(confirmation(s.view()), undefined, 'frozen confirmation can still be cancelled');
    s.unmount();
  }
});

test('version-source switching and historical version links only navigate and retain precise source/version', () => {
  const current = release('0.2.2');
  const s = overviewView(fixtureData({ running: [current], releases: [release('0.3.0'), release('0.2.1'), current, release('0.9.0', 'community')] }));
  let tree = s.view();
  const historicalLink = nodes(tree).find(node => node.type === 'a' && node.props.href.endsWith('?source=official&version=0.2.1'));
  assert.ok(historicalLink);
  let prevented = false;
  historicalLink.props.onClick({ button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(s.navigation.at(-1), '/plugins/test-plugin/overview?source=official&version=0.2.1');
  sourceSelector(tree, '版本来源').props.onChange({ target: { value: 'community' } });
  assert.equal(s.navigation.at(-1), '/plugins/test-plugin/overview?source=community&version=0.9.0');
  tree = s.view({ ...s.route, catalogSource: 'community', catalogVersion: '0.9.0' });
  assert.match(text(tree), /其他来源，仅供查看/);
  assert.equal(button(tree, '安装插件'), undefined); assert.equal(button(tree, '更新插件'), undefined);
  assert.deepEqual(s.writes, []); assert.deepEqual(s.resourceWrites, []);
  assert.equal(s.data.running[0].sourceId, 'official'); assert.equal(s.data.running[0].version, '0.2.2');
  s.unmount();
});

test('members neither request delivery management data nor receive version management or selection actions', () => {
  const current = release('0.2.2');
  const s = overviewView(fixtureData({ running: [current], releases: [current, release('0.3.0')] }), { admin: false });
  for (const route of [s.route, { type: 'page', page: 'plugin', section: 'list' },
    { type: 'page', page: 'plugin', section: 'delivery' }, { type: 'page', page: 'plugin', section: 'sources' }]) {
    const tree = s.view(route);
    assert.equal(nodes(tree).some(node => node.type?.name === 'PluginCatalogVersions'), false);
    assert.equal(sourceSelector(tree, '版本来源'), undefined);
    assert.equal(nodes(tree).some(node => ['catalog-view', 'delivery-view', 'delivery-status'].includes(node.type)), false);
    assert.equal(button(tree, '安装插件'), undefined); assert.equal(button(tree, '更新插件'), undefined); assert.equal(button(tree, '卸载插件'), undefined);
  }
  assert.ok(s.deliveryOwners.length > 0); assert.ok(s.deliveryOwners.every(owner => owner === null));
  assert.ok(s.resourceOwners.every(call => call.options.admin === false));
  assert.equal(s.resourceOwners.at(-1).owner, null);
  assert.deepEqual(s.writes, []); assert.deepEqual(s.resourceWrites, []);
  s.unmount();
});
