import test from 'node:test';
import assert from 'node:assert/strict';
import * as icons from 'lucide-react';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { createPluginRegistry, getPluginEntryRoute, getPrimaryPluginSettingsPageId, localizePlugin } from '../plugins/registry.js';
import { formatPath, parsePathname } from '../utils/navigation.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';

const plugin = { id: 'reading-room', version: '1.0.0', apiVersion: 1, hostApiVersion: 1, name: 'Reading room', description: 'Test only', icon: 'library',
  pages: [
    { id: 'browse', kind: 'service', access: 'authenticated', label: 'Browse', icon: 'library', group: 'books' },
    { id: 'notes', kind: 'service', access: 'authenticated', label: 'Notes', icon: 'info', group: 'books' },
    { id: 'admin', kind: 'settings', access: 'admin', label: 'Reading administration', icon: 'settings' },
  ], entries: [
    { id: 'read', slot: 'sidebar.primary', page: 'browse', access: 'authenticated', label: 'Read', icon: 'library', order: 1 },
    { id: 'notes', slot: 'sidebar.secondary', page: 'notes', access: 'authenticated', label: 'Notes', icon: 'info', group: 'books', order: 1 },
    { id: 'admin', slot: 'sidebar.settings.admin', page: 'admin', access: 'admin', label: 'Reading administration', icon: 'settings', order: 1 },
    { id: 'annotate', slot: 'sidebar.primary', action: 'annotate', access: 'authenticated', label: 'Annotate', icon: 'info', order: 2 },
    { id: 'secondary-action', slot: 'sidebar.secondary', action: 'annotate', access: 'authenticated', label: 'Quick note', icon: 'info', group: 'books', order: 2 },
  ] };
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
function sidebar(manifest = plugin, { locale = 'zh', translate = key => key } = {}) {
  const registry = createPluginRegistry(Array.isArray(manifest) ? manifest : [manifest]);
  const navigations = [], actions = [], state = { installedIds: ['reading-room'], availabilityById: {} };
  const ui = { authSession: { authenticated: true, user: { role: 'member' } }, setCompactPlayerPlacement() {} };
  const playback = { song: null, playing: false, output: null };
  const harness = createBackgroundModuleHarness({ file: new URL('./AppSidebar.jsx', import.meta.url),
    modules: { '../i18n/index.js': { t: translate, useLocale: () => locale }, 'lucide-react': icons,
      '../hooks/useCompactPlayerPlacement.js': { useCompactPlayerPlacement: () => ({ placement: 'dock' }) },
      '../hooks/useSidebarNavigationMotion.js': { useSidebarNavigationMotion: () => ({ current: null }) },
      '../hooks/usePluginMenu.js': { usePluginMenu: slot => ({ entries: registry.getPluginEntries(slot, {
        ...state, ...playback, authenticated: ui.authSession.authenticated, isAdmin: ui.authSession.user.role === 'admin' }),
        open: entry => actions.push({ slot, entry }), close() {} }) },
      '../store/useUIStore.js': { useUIStore: selector => selector(ui) }, '../store/usePluginStore.js': { usePluginStore: selector => selector(state) },
      '../plugins/registry.js': { ...registry, getPluginEntryRoute, getPrimaryPluginSettingsPageId, localizePlugin },
      '../utils/navigation.js': { formatPath, syncBrowserHistory: url => navigations.push(url), returnFromSidebarWorkspace: () => navigations.push('back'), returnToParentRoute: url => navigations.push(url) },
      './AccountMenu.jsx': 'account', './SidebarMiniPlayer.jsx': 'mini-player', './TuneWordmark.jsx': 'wordmark', './PageBackButton.jsx': 'back', './PluginActionDialog.jsx': 'plugin-action' }, globals: {} });
  const render = (route = { type: 'page', page: 'home' }) => harness.render({ activePage: route.page, activeRoute: route, onNavigate: (...args) => navigations.push(args) });
  return { ...harness, state, ui, playback, navigations, actions, render };
}

test('plugin administration stays inside the existing settings sidebar for both roles', () => {
  const view = sidebar();
  let tree = view.render();
  const portal = nodes(tree).filter(node => node.type === 'button' && text(node) === '插件');
  assert.equal(portal.length, 0);
  nodes(tree).find(node => node.type === 'button' && text(node) === '设置').props.onClick();
  assert.deepEqual(view.navigations.at(-1), ['settings', undefined]);
  tree = view.render({ type: 'page', page: 'plugin', section: 'list' });
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '插件列表'));
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '外观与播放'));
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '个人设置'));
  assert.equal(nodes(tree).find(node => node.type === 'button' && text(node) === '外观与播放').props['aria-current'], undefined);
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '安装插件'), false);
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '插件源'), false);
  view.ui.authSession.user.role = 'admin';
  tree = view.render({ type: 'page', page: 'plugin', section: 'delivery' });
  const sources = nodes(tree).find(node => node.type === 'button' && text(node) === '来源与部署');
  assert.equal(sources.props['aria-current'], 'page');
  const workspaceNav = nodes(tree).find(node => node.type === 'nav');
  const pluginGroup = nodes(workspaceNav).find(node => node.type === 'div' && node.props['aria-label'] === '插件');
  assert.deepEqual(nodes(pluginGroup).filter(node => node.type === 'button').map(text), ['插件列表', '来源与部署']);
  assert.ok(nodes(workspaceNav).some(node => node.type === 'button' && text(node) === '账号管理'));
  assert.ok(nodes(workspaceNav).some(node => node.type === 'back'));
  sources.props.onClick();
  assert.equal(view.navigations.at(-1), '/plugins/_/delivery');
  tree = view.render({ type: 'page', page: 'settings', section: 'appearance' });
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '插件列表'));
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '插件'), false);
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === 'Reading administration'), false);
  view.unmount();
});

test('registered primary/service/secondary entries navigate within the one host sidebar', () => {
  const view = sidebar(); let tree = view.render();
  const read = nodes(tree).find(node => node.type === 'button' && text(node) === 'Read');
  assert.ok(read); read.props.onClick(); assert.equal(view.navigations.at(-1), '/plugins/reading-room/browse');
  tree = view.render({ type: 'page', page: 'plugin', pluginId: 'reading-room', pluginPage: 'browse' });
  assert.equal(nodes(tree).filter(node => node.type === 'aside').length, 1);
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '主页'), false);
  const notes = nodes(tree).find(node => node.type === 'button' && text(node) === 'Notes');
  notes.props.onClick(); assert.equal(view.navigations.at(-1), '/plugins/reading-room/notes');
  tree = view.render({ type: 'page', page: 'plugin', pluginId: 'reading-room', pluginPage: 'notes' });
  assert.ok(nodes(tree).find(node => node.type === 'button' && text(node) === 'Read'), 'the group retains its registered primary service');
  assert.equal(nodes(tree).find(node => node.type === 'button' && text(node) === 'Notes').props['aria-current'], 'page');
  view.unmount();
});

test('roam stays in the primary sidebar before installation, after installation and after uninstall', () => {
  const view = sidebar({ ...compiledPluginManifests.find(item => item.id === 'roam'), entries: [{
    id: 'open-roam', slot: 'sidebar.primary', page: 'browse', roles: ['admin', 'member'], label: '漫游', icon: 'shuffle', order: 30,
  }] });
  for (const role of ['member', 'admin']) {
    view.ui.authSession.user.role = role;
    for (const installedIds of [[], ['roam'], []]) {
      view.state.installedIds = installedIds;
      const entries = nodes(nodes(view.render()).find(node => node.type === 'nav')).filter(node => node.type === 'button');
      assert.deepEqual(entries.slice(0, 4).map(text), ['主页', '搜索', '漫游', '资料库']);
      assert.equal(entries.filter(node => text(node) === '漫游').length, 1, 'legacy plugin entries cannot duplicate the fixed browse entry');
      entries.find(node => text(node) === '漫游').props.onClick();
      assert.deepEqual(view.navigations.at(-1), ['roam', undefined]);
    }
  }
  view.state.availabilityById.roam = { available: false, reason: 'incompatible_version' };
  const tree = view.render(parsePathname('/plugins/roam/browse'));
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '主页'));
  assert.equal(nodes(tree).find(node => node.type === 'button' && text(node) === '漫游').props['aria-current'], 'page');
  assert.equal(nodes(tree).some(node => node.type === 'back'), false, 'browse does not become a plugin workspace');
  assert.equal(nodes(tree).filter(node => node.type === 'aside').length, 1);
  const overview = view.render(parsePathname('/plugins/roam/overview'));
  assert.ok(nodes(overview).some(node => node.type === 'back'), 'plugin metadata remains inside plugin management');
  view.unmount();
});

test('assistant navigation follows installation and Gateway availability for members and administrators', () => {
  const view = sidebar(compiledPluginManifests);
  const assistant = tree => nodes(tree).find(node => node.type === 'button' && text(node) === '助手');
  view.state.installedIds = [];
  assert.equal(assistant(view.render()), undefined);
  view.state.installedIds = ['assistant'];
  assert.equal(assistant(view.render()), undefined, 'a required dependency is missing');
  view.state.installedIds = ['assistant', 'ai-gateway'];
  let tree = view.render(); assert.ok(assistant(tree));
  assistant(tree).props.onClick();
  assert.equal(view.navigations.at(-1), '/plugins/assistant/conversation');
  const route = { type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: 'conversation' };
  tree = view.render(route);
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '记忆'));
  assert.equal(nodes(tree).some(node => node.type === 'p' && text(node) === '站点设置'), false);
  view.ui.authSession.user.role = 'admin';
  tree = view.render(route);
  assert.equal(nodes(tree).some(node => node.type === 'p' && text(node) === '站点设置'), false);
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '设置'), false);
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '概览'), false);
  const back = nodes(tree).find(node => node.type === 'back');
  assert.equal(back.props.label, '返回'); back.props.onClick(); assert.equal(view.navigations.at(-1), 'back');
  tree = view.render({ type: 'page', page: 'plugin', pluginId: 'assistant', pluginPage: 'overview' });
  assert.ok(nodes(tree).some(node => node.type === 'p' && text(node) === '插件设置'));
  assert.equal(nodes(tree).some(node => node.type === 'p' && ['站点设置', '我的设置', '助手'].includes(text(node))), false);
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '概览'));
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '记忆'), false);
  const configuration = nodes(tree).find(node => node.type === 'button' && text(node) === '设置');
  configuration.props.onClick();
  assert.equal(view.navigations.at(-1), '/plugins/assistant/configuration');
  assert.equal(nodes(tree).filter(node => node.type === 'aside').length, 1);
  view.state.availabilityById.assistant = { available: false, reason: 'dependency_unavailable' };
  assert.equal(assistant(view.render()), undefined);
  view.unmount();
});

test('daily service sidebars retain service tabs and related actions without management controls for either role', () => {
  const view = sidebar();
  for (const role of ['member', 'admin']) {
    view.ui.authSession.user.role = role;
    const tree = view.render({ type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: 'browse' });
    const nav = nodes(tree).find(node => node.type === 'nav');
    assert.deepEqual(nodes(nav).filter(node => node.type === 'button').map(text), ['Read', 'Notes', 'Quick note']);
    assert.equal(nodes(nav).some(node => node.type === 'p' && ['我的设置', '站点设置'].includes(text(node))), false);
    assert.equal(nodes(nav).find(node => node.type === 'back').props.label, '返回');
  }
  view.unmount();
});

test('sidebar action entries invoke the host dispatcher with their slot and never change the current route', () => {
  const view = sidebar();
  let tree = view.render();
  nodes(tree).find(node => node.type === 'button' && text(node) === 'Annotate').props.onClick();
  assert.equal(view.actions[0].slot, 'sidebar.primary'); assert.equal(view.actions[0].entry.action, 'annotate');
  assert.equal(view.navigations.length, 0);
  tree = view.render({ type: 'page', page: 'plugin', pluginId: 'reading-room', pluginPage: 'browse' });
  nodes(tree).find(node => node.type === 'button' && text(node) === 'Quick note').props.onClick();
  assert.equal(view.actions[1].slot, 'sidebar.secondary'); assert.equal(view.navigations.length, 0);
  view.unmount();
});

test('plugin settings stay in their detail sidebar and obey installed state and page permission', () => {
  const view = sidebar(), settings = { type: 'page', page: 'settings', section: 'appearance' };
  let tree = view.render(settings);
  assert.equal(nodes(tree).some(node => text(node) === 'Reading administration'), false);
  view.ui.authSession.user.role = 'admin'; tree = view.render({ type: 'page', page: 'plugin', pluginId: 'reading-room', pluginPage: 'overview' });
  const shortcut = nodes(tree).find(node => node.type === 'button' && text(node) === '设置');
  assert.ok(shortcut); shortcut.props.onClick(); assert.equal(view.navigations.at(-1), '/plugins/reading-room/admin');
  view.state.installedIds = []; tree = view.render();
  assert.equal(nodes(tree).some(node => text(node) === 'Read'), false);
  tree = view.render({ type: 'page', page: 'settings', section: 'plugins', pluginId: 'reading-room', pluginSection: 'overview' });
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node) === '概览'));
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === 'Reading administration'), false);
  view.state.installedIds = ['reading-room']; view.state.availabilityById['reading-room'] = { available: false, reason: 'incompatible_version' };
  assert.equal(nodes(view.render()).some(node => node.type === 'button' && text(node) === 'Read'), false);
  view.unmount();
});

test('all sidebar slots reuse live song, playing and output display conditions', () => {
  const manifest = { ...plugin, entries: plugin.entries.map(entry => ({ ...entry, when: ['song', 'playing', 'output'] })) };
  const view = sidebar(manifest); view.ui.authSession.user.role = 'admin';
  assert.equal(nodes(view.render()).some(node => text(node) === 'Read'), false);
  Object.assign(view.playback, { song: { id: 'one' }, playing: true, output: { id: 'speaker' } });
  assert.ok(nodes(view.render()).some(node => node.type === 'button' && text(node) === 'Read'));
  assert.equal(nodes(view.render({ type: 'page', page: 'plugin', section: 'list' })).some(node => node.type === 'button' && text(node) === 'Reading administration'), false);
  const route = { type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: 'browse' };
  assert.ok(nodes(view.render(route)).some(node => node.type === 'button' && text(node) === 'Notes'));
  view.playback.playing = false;
  assert.equal(nodes(view.render(route)).some(node => node.type === 'button' && text(node) === 'Notes'), false);
  view.unmount();
});

const managementPlugin = { ...plugin, pages: [
  plugin.pages[0],
  { ...plugin.pages[2], scope: 'instance' },
  { id: 'devices', kind: 'settings', access: 'authenticated', scope: 'account', label: 'Devices', icon: 'settings' },
  { id: 'playback', kind: 'settings', access: 'authenticated', scope: 'account', label: 'Playback', icon: 'settings' },
], entries: [
  plugin.entries[0],
  { id: 'check-devices', slot: 'sidebar.secondary', action: 'check-devices', access: 'authenticated', label: 'Check devices', icon: 'info', group: plugin.id, order: 1 },
] };
const navigation = tree => nodes(tree).find(node => node.type === 'nav');
const navigationButtons = tree => nodes(navigation(tree)).filter(node => node.type === 'button');
const groupLabels = tree => nodes(navigation(tree)).filter(node => node.type === 'p' && node.props.className === 'app-sidebar__group-label').map(text);

test('management uses one generic heading and flattens primary, derived pages and actions without changing routes', () => {
  const view = sidebar(managementPlugin);
  view.ui.authSession.user.role = 'admin';
  const route = { type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: 'overview' };
  let tree = view.render(route);
  assert.deepEqual(groupLabels(tree), ['插件设置']);
  assert.equal(navigation(tree).props['aria-label'], '插件设置');
  assert.deepEqual(navigationButtons(tree).map(text), ['概览', '设置', 'Devices', 'Playback', 'Check devices']);
  navigationButtons(tree).find(node => text(node) === '设置').props.onClick();
  assert.equal(view.navigations.at(-1), '/plugins/reading-room/admin');
  navigationButtons(tree).find(node => text(node) === 'Devices').props.onClick();
  assert.equal(view.navigations.at(-1), '/plugins/reading-room/devices');
  tree = view.render({ ...route, pluginPage: 'playback' });
  assert.equal(navigationButtons(tree).find(node => text(node) === 'Playback').props['aria-current'], 'page');
  assert.deepEqual(groupLabels(tree), ['插件设置']);
  const before = view.navigations.length;
  navigationButtons(tree).find(node => text(node) === 'Check devices').props.onClick();
  assert.equal(view.actions.at(-1).entry.action, 'check-devices');
  assert.equal(view.navigations.length, before);
  view.unmount();
});

test('a hidden administrator primary configuration never promotes the first member-visible derived page', () => {
  const view = sidebar(managementPlugin);
  const route = { type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: 'devices' };
  let tree = view.render(route);
  assert.deepEqual(groupLabels(tree), ['插件设置']);
  assert.deepEqual(navigationButtons(tree).map(text), ['概览', 'Devices', 'Playback', 'Check devices']);
  assert.equal(navigationButtons(tree).some(node => text(node) === '设置'), false);
  navigationButtons(tree).find(node => text(node) === 'Devices').props.onClick();
  assert.equal(view.navigations.at(-1), '/plugins/reading-room/devices');
  tree = view.render({ ...route, pluginPage: 'admin' });
  assert.deepEqual(navigationButtons(tree).map(text), ['概览', 'Devices', 'Playback', 'Check devices']);
  assert.equal(navigationButtons(tree).some(node => node.props['aria-current'] === 'page'), false, 'an inaccessible deep link never becomes an allowed main settings page');
  assert.equal(managementPlugin.pages[1].scope, 'instance');
  assert.equal(managementPlugin.pages[1].access, 'admin');
  view.unmount();
});

test('uninstalled or unavailable plugins keep overview only without inventing a settings page', () => {
  const view = sidebar(managementPlugin);
  const route = { type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: 'overview' };
  for (const role of ['member', 'admin']) {
    view.ui.authSession.user.role = role;
    view.state.installedIds = [];
    assert.deepEqual(navigationButtons(view.render(route)).map(text), ['概览']);
    view.state.installedIds = [plugin.id];
    view.state.availabilityById = { [plugin.id]: { available: false, reason: 'incompatible_version' } };
    assert.deepEqual(navigationButtons(view.render(route)).map(text), ['概览']);
  }
  view.unmount();
  const serviceOnly = sidebar({ ...plugin, pages: plugin.pages.filter(page => page.kind === 'service'),
    entries: plugin.entries.filter(entry => entry.page !== 'admin') });
  serviceOnly.ui.authSession.user.role = 'admin';
  assert.deepEqual(navigationButtons(serviceOnly.render(route)).map(text), ['概览']);
  serviceOnly.unmount();
});

test('generic management labels use host translation while daily service headings keep their plugin identity', () => {
  const translate = key => ({ '插件设置': 'Plugin settings', '设置': 'Settings', '概览': 'Overview' })[key] || key;
  const view = sidebar(managementPlugin, { locale: 'en', translate });
  view.ui.authSession.user.role = 'admin';
  const route = { type: 'page', page: 'plugin', pluginId: plugin.id, pluginPage: 'overview' };
  let tree = view.render(route);
  assert.deepEqual(groupLabels(tree), ['Plugin settings']);
  assert.deepEqual(navigationButtons(tree).map(text), ['Overview', 'Settings', 'Devices', 'Playback', 'Check devices']);
  tree = view.render({ ...route, pluginPage: 'browse' });
  assert.deepEqual(groupLabels(tree), ['Reading room']);
  assert.equal(navigationButtons(tree).some(node => ['Settings', 'Overview'].includes(text(node))), false);
  assert.ok(navigationButtons(tree).some(node => text(node) === 'Read'));
  view.unmount();
});
