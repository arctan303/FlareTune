import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';
import * as registry from '../plugins/registry.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children, tree.props?.action].flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : [node?.props?.children, node?.props?.meta].flat(Infinity).map(child => child === undefined ? '' : text(child)).join('');
function pluginView({ admin = true, installed = false, manifests, locale = 'zh', translate = value => value } = {}) {
  const api = manifests ? registry.createPluginRegistry(manifests) : registry;
  const id = manifests?.[0].id || 'xiaomi-speaker';
  const writes = [], calls = [], deliveryWrites = [];
  const session = { authenticated: true, user: { accountId: 'A', role: admin ? 'admin' : 'member' }, csrfToken: 'csrf-A' };
  const resource = { plugins: (manifests || [api.getPlugin(id)]).map(item => ({ id: item.id, version: item.version, installed, revision: 2 })),
    loaded: true, loading: false, busy: false, error: '', demo: false,
    refresh: async () => {}, setInstalled: async (...args) => { writes.push(args); } };
  const catalogRows = () => resource.plugins.map(row => ({ id: row.id, version: row.version, manifest: api.getPlugin(row.id), sourceId: 'workspace', sourceName: 'Current deployment', source: { type: 'workspace', id: 'workspace' } }));
  const delivery = { data: { revision: 1, settings: { mode: 'manual' }, sources: [], pending: [], build: null,
    get catalog() { return [...catalogRows(), ...(this.extraCatalog || [])]; }, get running() { return catalogRows().filter(row => resource.plugins.find(item => item.id === row.id).installed); },
    get desired() { return this.running; } }, busy: false, error: '', refresh: async () => {},
    action: async (...args) => { deliveryWrites.push(structuredClone(args)); return delivery.data; } };
  const harness = createBackgroundModuleHarness({ file: new URL('./PluginSettingsView.jsx', import.meta.url),
    modules: { '../i18n/index.js': { t: translate, useLocale: () => locale },
      '../../../shared/uiLanguages.js': { UI_LANGUAGES: [{ id: 'zh', name: '简体中文' }, { id: 'en', name: 'English' }] },
      '../hooks/usePlugins.js': { usePlugins: (owner, options) => { calls.push({ owner, options }); return resource; } },
      '../hooks/usePluginDelivery.js': { usePluginDelivery: () => delivery, activePluginBuild: () => false },
      '../plugins/registry.js': { ...api, localizePlugin: registry.localizePlugin, isPluginVisibleToRole: registry.isPluginVisibleToRole },
      '../utils/navigation.js': { formatPath: route => route.pluginId ? '/plugins/' + route.pluginId + '/' + (route.pluginPage || 'overview') : route.section === 'list' ? '/plugins' : '/plugins/_/' + route.section, syncBrowserHistory() {} },
      './SettingsSection.jsx': 'section', './SettingsSkeleton.jsx': 'skeleton', './SettingsControls.jsx': { SettingsActions: 'actions', SettingsButton: 'button' },
      './PluginConfirmDialog.jsx': 'confirm-dialog', './PluginContentBoundary.jsx': 'plugin-content',
      './PluginDeliveryView.jsx': { __esModule: true, default: 'delivery-view', PluginDeliveryStatus: 'delivery-status' }, './PluginCatalogView.jsx': 'catalog-view' }, globals: {},
  });
  const route = { type: 'page', page: 'plugin', pluginId: id, pluginPage: 'overview' };
  return { ...harness, resource, delivery, session, route, writes, deliveryWrites, calls, view: (next = route) => harness.render({ route: next, session }) };
}

test('uninstalled settings deep links cannot mount personal hooks and installed settings keep the original content', () => {
  const subject = pluginView();
  const route = { ...subject.route, pluginPage: 'devices' };
  let view = subject.view(route);
  assert.equal(nodes(view).some(node => node.type === 'plugin-content'), false);
  assert.match(text(view), /尚未安装/);
  subject.resource.plugins[0].installed = true;
  view = subject.view(route);
  assert.equal(nodes(view).find(node => node.type === 'plugin-content')?.props.section, 'devices');
  subject.resource.plugins[0].installed = false;
  assert.equal(nodes(subject.view(route)).some(node => node.type === 'plugin-content'), false);
  subject.unmount();
});

test('administrators confirm a pending selection without activating the running plugin', async () => {
  const subject = pluginView(), view = subject.view();
  const install = nodes(view).find(node => node.type === 'button' && text(node) === '安装插件');
  assert.ok(install); install.props.onClick();
  assert.equal(subject.writes.length, 0);
  await nodes(subject.view()).find(node => node.type === 'confirm-dialog').props.onConfirm();
  await flushBackgroundAsync();
  assert.deepEqual(subject.writes, []);
  assert.deepEqual(subject.deliveryWrites, [['/selection', 'PUT', { pluginId: 'xiaomi-speaker', installed: true, sourceId: 'workspace', version: '1.1.0', trustCode: true }]]);
  assert.equal(subject.resource.plugins[0].installed, false);
  assert.equal(nodes(subject.view()).some(node => node.type === 'confirm-dialog'), false);
  assert.equal(subject.calls.at(-1).options.admin, true);
  subject.unmount();
});

test('members have no installation actions and management deep links never request administrator data', () => {
  const subject = pluginView({ admin: false, installed: true });
  let view = subject.view();
  assert.equal(nodes(view).some(node => node.type === 'button' && /安装插件|卸载插件/u.test(text(node))), false);
  for (const section of ['delivery', 'sources']) {
    view = subject.view({ type: 'page', page: 'plugin', section });
    assert.match(text(view), /仅管理员/);
    assert.equal(subject.calls.at(-1).owner, null);
    assert.equal(subject.calls.at(-1).options.admin, false);
  }
  subject.unmount();
});

test('administrators use the combined catalog and members retain the filtered installed list', () => {
  const subject = pluginView({ installed: true, admin: false });
  let view = subject.view({ type: 'page', page: 'plugin', section: 'list' });
  assert.equal(nodes(view).filter(node => node.type === 'section').length, 1);
  assert.ok(nodes(view).some(node => node.type?.name === 'PluginLink' && node.props.route.pluginId === 'xiaomi-speaker' && node.props.route.pluginPage === 'connection'));
  subject.session.user.role = 'admin';
  view = subject.view({ type: 'page', page: 'plugin', section: 'list' });
  assert.ok(nodes(view).some(node => node.type === 'catalog-view'));
  subject.unmount();
});

test('role filtering keeps direct source capabilities visible without exposing gateway-only configuration', () => {
  const base = { version: '1.0.0', hostApiVersion: 1, apiVersion: 1, description: 'fixture', icon: 'puzzle', entries: [] };
  const manifests = [
    { ...base, id: 'source', name: 'Source', capabilityRoles: ['member', 'admin'], pages: [{ id: 'settings', kind: 'settings', roles: ['admin'], scope: 'instance', label: 'Site source', icon: 'settings' }] },
    { ...base, id: 'gateway', name: 'Gateway', pages: [{ id: 'settings', kind: 'settings', roles: ['admin'], scope: 'instance', label: 'Secret channels', icon: 'settings' }] },
  ];
  const subject = pluginView({ admin: false, installed: true, manifests });
  const view = subject.view({ type: 'page', page: 'plugin', section: 'list' });
  assert.deepEqual(nodes(view).filter(node => node.type === 'section').map(node => node.props.title), ['Source']);
  assert.equal(nodes(view).some(node => node.type?.name === 'PluginLink' && node.props.route.pluginPage === 'settings'), false);
  assert.match(text(subject.view({ ...subject.route, pluginId: 'gateway' })), /没有可访问/);
  subject.unmount();
});

test('overview displays declared languages and sources opens the real delivery settings', () => {
  const subject = pluginView();
  const overview = subject.view();
  assert.match(text(overview), /支持语言/); assert.match(text(overview), /English/);
  assert.match(text(overview), /宿主 API/);
  assert.match(text(overview), new RegExp(`v${registry.getPlugin('xiaomi-speaker').hostApiVersion}`));
  const sources = subject.view({ type: 'page', page: 'plugin', section: 'sources' });
  assert.ok(nodes(sources).some(node => node.type === 'delivery-view'));
  subject.unmount();
});

test('plugin metadata uses its declared default language without a second host dictionary translation', () => {
  const manifests = [{ id: 'localized', version: '1.0.0', hostApiVersion: 1, apiVersion: 1, icon: 'puzzle',
    name: '助手', description: '插件自己的介绍', supportedLocales: ['zh'], defaultLocale: 'zh',
    metadata: { zh: { name: '助手', description: '插件自己的介绍' } }, pages: [], entries: [], capabilityRoles: ['member'] }];
  const subject = pluginView({ installed: true, admin: false, manifests, locale: 'ja',
    translate: key => ({ '助手': 'HOST_ASSISTANT', '插件自己的介绍': 'HOST_DESCRIPTION' }[key] || key) });
  const view = subject.view();
  assert.equal(nodes(view).find(node => node.type === 'section').props.title, '助手');
  assert.match(text(view), /插件自己的介绍/);
  assert.doesNotMatch(text(view), /HOST_ASSISTANT|HOST_DESCRIPTION/);
  assert.match(text(view), /已使用默认语言/);
  subject.unmount();
});

test('data updates and uninstall stay explicit, and account or role changes retire pending confirmation', async () => {
  const subject = pluginView({ installed: true });
  subject.resource.availabilityById = { 'xiaomi-speaker': { available: false, reason: 'data_migration_required', optionalFeatures: {} } };
  nodes(subject.view()).find(node => node.type === 'button' && text(node) === '完成插件更新').props.onClick();
  assert.equal(nodes(subject.view()).find(node => node.type === 'confirm-dialog').props.operation, 'upgrade');
  await nodes(subject.view()).find(node => node.type === 'confirm-dialog').props.onConfirm();
  assert.deepEqual(subject.writes, [['xiaomi-speaker', true, 2]]);
  nodes(subject.view()).find(node => node.type === 'button' && text(node) === '卸载插件').props.onClick();
  await nodes(subject.view()).find(node => node.type === 'confirm-dialog').props.onConfirm();
  assert.deepEqual(subject.deliveryWrites.at(-1), ['/selection', 'PUT', { pluginId: 'xiaomi-speaker', installed: false, sourceId: 'workspace', version: '1.1.0', trustCode: true }]);
  nodes(subject.view()).find(node => node.type === 'button' && text(node) === '卸载插件').props.onClick();
  subject.session.user.accountId = 'B';
  subject.view(); assert.equal(nodes(subject.view()).some(node => node.type === 'confirm-dialog'), false);
  subject.session.user.role = 'member';
  assert.equal(nodes(subject.view()).some(node => node.type === 'button' && text(node) === '卸载插件'), false);
  subject.unmount();
});

test('catalog detail preserves the selected source and version through installation confirmation', async () => {
  const subject = pluginView();
  const external = (sourceId, version) => ({ id: 'external', version, sourceId, sourceName: sourceId,
    source: { type: 'artifact', id: sourceId, url: `https://plugins.flaretune.dev/${sourceId}.json` },
    manifest: { id: 'external', version, hostApiVersion: 1, apiVersion: 1, name: sourceId, description: sourceId + ' package', pages: [], entries: [], icon: 'puzzle' } });
  subject.delivery.data.extraCatalog = [external('first-source', '1.0.0'), external('second-source', '2.0.0')];
  const route = { type: 'page', page: 'plugin', pluginId: 'external', pluginPage: 'overview', catalogSource: 'second-source', catalogVersion: '2.0.0' };
  let tree = subject.view(route);
  assert.match(text(tree), /second-source/); assert.doesNotMatch(text(tree), /first-source/);
  assert.match(text(tree), /2\.0\.0/);
  nodes(tree).find(node => node.type === 'button' && text(node) === '安装插件').props.onClick();
  await nodes(subject.view(route)).find(node => node.type === 'confirm-dialog').props.onConfirm();
  assert.deepEqual(subject.deliveryWrites.at(-1), ['/selection', 'PUT', { pluginId: 'external', installed: true, sourceId: 'second-source', version: '2.0.0', trustCode: true }]);
  assert.match(text(subject.view({ ...route, catalogVersion: '9.0.0' })), /没有可访问/);
  subject.unmount();
});

test('overview keeps configuration separate from the final uninstall region and exposes real language labels', () => {
  const subject = pluginView({ installed: true });
  const view = subject.view(), sections = nodes(view).filter(node => node.type === 'section');
  const intro = sections.find(node => node.props.className === 'plugin-overview__intro');
  const danger = sections.find(node => node.props.className === 'plugin-overview__danger');
  assert.ok(intro); assert.ok(danger);
  assert.equal(nodes(intro).some(node => node.type === 'button' && text(node) === '卸载插件'), false);
  assert.ok(nodes(intro).some(node => node.type?.name === 'PluginLink' && node.props.route.pluginPage === 'connection'));
  assert.equal(nodes(danger).filter(node => node.type === 'button').length, 1);
  assert.equal(text(nodes(danger).find(node => node.type === 'button')), '卸载插件');
  assert.match(danger.props.description, /构建并部署成功后生效/);
  const labels = nodes(view).filter(node => node.type === 'li').map(text);
  assert.ok(labels.includes('English'));
  assert.match(text(view), new RegExp(registry.getPlugin('xiaomi-speaker').version.replaceAll('.', '\\.')));
  subject.unmount();
});

test('availability presentation retains every required dependency, optional capability and failure message', () => {
  const subject = pluginView();
  const tree = subject.exports.PluginAvailability({ plugin: { dependencies: {
    'dep-one': { apiVersion: 1, version: '^1.0.0' }, 'dep-two': { apiVersion: 2, version: '2.0.0' },
  } }, availability: { available: false, reason: 'missing_dependency', optionalFeatures: {
    first: { available: true }, second: { available: false },
  } } });
  assert.match(text(tree), /dep-one · API 1 · \^1\.0\.0/);
  assert.match(text(tree), /dep-two · API 2 · 2\.0\.0/);
  assert.match(text(tree), /first · 可用/); assert.match(text(tree), /second · 不可用/);
  assert.ok(nodes(tree).some(node => node.props.role === 'status' && /所需依赖尚不可用/.test(text(node))));
  subject.unmount();
});
