import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { createPluginRegistry, localizePlugin, canAccessPluginDeclaration, getPrimaryPluginSettingsPageId } from '../plugins/registry.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';

const manifest = { id: 'reading-room', version: '1.0.0', apiVersion: 1, hostApiVersion: 1,
  name: 'Reading room', description: 'Test only', icon: 'library', pages: [
    { id: 'browse', label: 'Browse', icon: 'library', kind: 'service', access: 'authenticated', playerPlacement: 'sidebar' },
    { id: 'admin', label: 'Admin', icon: 'settings', kind: 'service', access: 'admin' },
  ], entries: [] };
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
function subject(declaration = manifest, { locale = 'zh', translate = key => key, manifests = [declaration] } = {}) {
  const registry = createPluginRegistry(manifests, { [declaration.id]: { loadContent() {} } });
  const resource = { plugins: [{ id: declaration.id, version: declaration.version, revision: 7, installed: true }], loaded: true,
    installedIds: [declaration.id], availabilityById: {}, refresh: async () => {} };
  const session = { authenticated: true, user: { accountId: 'A', role: 'member' }, csrfToken: 'A' };
  const harness = createBackgroundModuleHarness({ file: new URL('./PluginPageView.jsx', import.meta.url),
    modules: { '../i18n/index.js': { t: translate, useLocale: () => locale },
      '../hooks/usePlugins.js': { usePlugins: () => resource }, '../plugins/registry.js': { ...registry, localizePlugin, canAccessPluginDeclaration, getPrimaryPluginSettingsPageId },
      './PluginSettingsView.jsx': { default: 'plugin-overview', PluginLink: 'a', pluginAvailabilityMessage: reason => reason },
      './PluginContentBoundary.jsx': 'plugin-content', './SettingsSkeleton.jsx': 'skeleton', './SettingsControls.jsx': { SettingsButton: 'button' } }, globals: {} });
  return { ...harness, resource, session, renderPage(page = 'browse') {
    return harness.render({ route: { type: 'page', page: 'plugin', pluginId: declaration.id, pluginPage: page }, session });
  } };
}

test('service deep links use the shared content host without another sidebar and refresh the session on installation revision', () => {
  const view = subject();
  let tree = view.renderPage(), content = nodes(tree).find(node => node.type === 'plugin-content');
  assert.equal(content.props.page.kind, 'service'); assert.equal(content.props.section, 'browse');
  assert.equal(content.props.revision, 7);
  assert.equal(nodes(tree).some(node => node.type === 'aside' || node.type === 'nav'), false);
  view.resource.plugins[0].revision = 9;
  tree = view.renderPage(); content = nodes(tree).find(node => node.type === 'plugin-content');
  assert.equal(content.props.revision, 9);
  view.unmount();
});

test('service title and plugin name retain plugin-owned default-language text', () => {
  const declaration = { ...manifest, supportedLocales: ['zh'], defaultLocale: 'zh',
    metadata: { zh: { name: '助手', description: '插件介绍' } }, messages: { zh: { browse: '阅读' } },
    pages: manifest.pages.map(page => page.id === 'browse' ? { ...page, labelKey: 'browse' } : page) };
  const view = subject(declaration, { locale: 'ja', translate: key => ['助手', '阅读'].includes(key) ? 'HOST_TRANSLATION' : key });
  const tree = view.renderPage();
  assert.match(text(tree), /阅读/); assert.match(text(tree), /助手/);
  assert.doesNotMatch(text(tree), /HOST_TRANSLATION/);
  view.unmount();
});

test('a service with the same localized name as its plugin renders one title', () => {
  const declaration = { ...manifest, name: '漫游', pages: manifest.pages.map(page => page.id === 'browse' ? { ...page, label: '漫游' } : page) };
  const view = subject(declaration);
  const tree = view.renderPage();
  assert.equal(nodes(tree).filter(node => node.type === 'h1').length, 1);
  assert.equal(nodes(tree).filter(node => node.type === 'span' && text(node) === '漫游').length, 0);
  assert.equal(text(tree), '漫游');
  view.unmount();
});

test('service pages never load before installation, permission, dependencies and version are confirmed', () => {
  const view = subject();
  for (const reason of ['not_installed', 'missing_dependency', 'incompatible_version']) {
    view.resource.availabilityById[manifest.id] = { available: false, reason };
    const tree = view.renderPage();
    assert.equal(nodes(tree).some(node => node.type === 'plugin-content'), false);
    assert.match(text(tree), new RegExp(reason));
  }
  view.resource.availabilityById = {};
  assert.match(text(view.renderPage('admin')), /没有访问/);
  view.session.user.role = 'admin';
  assert.ok(nodes(view.renderPage('admin')).some(node => node.type === 'plugin-content'));
  view.session.authenticated = false;
  assert.match(text(view.renderPage()), /先登录/);
  view.session.authenticated = true; view.resource.loaded = false;
  assert.ok(nodes(view.renderPage()).some(node => node.type === 'skeleton'));
  assert.match(text(view.renderPage('missing')), /未注册此插件页面/);
  view.unmount();
});

test('actual Assistant pages gate their dependency and administrator settings while retaining one service workspace', () => {
  const declaration = compiledPluginManifests.find(plugin => plugin.id === 'assistant');
  const view = subject(declaration, { manifests: compiledPluginManifests });
  const content = tree => nodes(tree).find(node => node.type === 'plugin-content');
  view.resource.installedIds = [];
  assert.equal(content(view.renderPage('conversation')), undefined);
  view.resource.installedIds = ['assistant'];
  assert.equal(content(view.renderPage('conversation')), undefined);
  view.resource.installedIds = ['assistant', 'ai-gateway'];
  let tree = view.renderPage('conversation');
  const conversation = content(tree); assert.ok(conversation);
  assert.equal(nodes(tree).find(node => node.type === 'header').props.className, 'sr-only');
  assert.equal(conversation.props.context.route.pluginPage, 'conversation');
  const memory = content(view.renderPage('memory'));
  assert.ok(memory); assert.equal(memory.props.key, conversation.props.key, 'service sections keep one host/body lifecycle');
  assert.equal(content(view.renderPage('configuration')), undefined);
  view.session.user.role = 'admin';
  tree = view.renderPage('configuration');
  assert.equal(text(nodes(tree).find(node => node.type === 'h1')), '设置');
  assert.equal(content(tree).props.page.scope, 'instance');
  assert.notEqual(content(tree).props.key, conversation.props.key);
  view.unmount();

  const gateway = subject(compiledPluginManifests.find(plugin => plugin.id === 'ai-gateway'), { manifests: compiledPluginManifests });
  assert.equal(content(gateway.renderPage('configuration')), undefined);
  gateway.session.user.role = 'admin';
  assert.ok(content(gateway.renderPage('configuration')));
  gateway.unmount();
});
