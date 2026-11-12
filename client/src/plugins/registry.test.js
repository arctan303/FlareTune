import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlugin, getPlugins, getPluginSections, createPluginRegistry, getPluginEntryRoute, getPrimaryPluginSettingsPageId, localizePlugin } from './registry.js';

test('compiled selected packages declare compatibility and capabilities without installing themselves', () => {
  const plugin = getPlugin('xiaomi-speaker');
  assert.deepEqual(getPlugins().map(item => item.id).sort(), ['xiaomi-speaker', 'youtube-music', 'roam', 'ai-gateway', 'assistant', 'lyrics-workbench'].sort()); assert.equal(getPlugin('external-package'), null);
  assert.equal(plugin.hostApiVersion, 2); assert.ok(plugin.icon);
  assert.deepEqual(plugin.capabilities.supportedFormats, ['mp3']);
  assert.equal(plugin.capabilities.state, 'unknown'); assert.equal(plugin.capabilities.metadata, false);
  assert.equal(plugin.capabilities.remoteControls, false); assert.equal(plugin.installed, undefined);
});

test('YouTube is a settings-only source with administrator connection access', () => {
  const plugin = getPlugin('youtube-music');
  assert.equal(plugin.installed, undefined);
  assert.equal(plugin.capabilities.search, true);
  assert.deepEqual(plugin.pages.map(page => [page.id, page.kind, page.access]), [['connection', 'settings', 'admin']]);
  assert.equal(plugin.entries.some(entry => entry.slot === 'sidebar.primary'), false);
  assert.ok(plugin.entries.every(entry => entry.access === 'admin'));
});

const fixture = {
  id: 'reading-room', version: '2.0.0', apiVersion: 1, hostApiVersion: 1, name: 'Reading room', description: 'Fixture only', icon: 'library',
  pages: [
    { id: 'browse', kind: 'service', access: 'authenticated', playerPlacement: 'sidebar', label: 'Browse', icon: 'library', group: 'books' },
    { id: 'notes', kind: 'service', access: 'authenticated', label: 'Notes', icon: 'info', group: 'books' },
    { id: 'private', kind: 'service', access: 'admin', label: 'Private', icon: 'settings' },
  ], entries: [
    { id: 'browse', slot: 'sidebar.primary', page: 'browse', label: 'Read', icon: 'library', order: 1, access: 'authenticated' },
    { id: 'notes', slot: 'sidebar.secondary', page: 'notes', label: 'Notes', icon: 'info', order: 2, access: 'authenticated', group: 'books' },
    { id: 'private', slot: 'sidebar.settings.admin', page: 'private', label: 'Private', icon: 'settings', order: 3, access: 'admin' },
  ],
};

test('a second compiled plugin registers service pages and exact slots without gaining installation or permission', () => {
  const registry = createPluginRegistry([fixture], { 'reading-room': { loadContent: async () => ({ default() {} }) } });
  assert.deepEqual(registry.getPluginEntries('sidebar.primary'), []);
  const options = { installedIds: ['reading-room'] };
  const [entry] = registry.getPluginEntries('sidebar.primary', options);
  assert.equal(entry.pluginId, 'reading-room'); assert.equal(entry.label, 'Read'); assert.ok(entry.icon);
  assert.deepEqual(getPluginEntryRoute(entry), { type: 'page', page: 'plugin', pluginId: 'reading-room', pluginPage: 'browse' });
  assert.deepEqual(registry.getPluginEntries('sidebar.settings.admin', options), []);
  assert.equal(registry.getPluginEntries('sidebar.settings.admin', { ...options, isAdmin: true }).length, 1);
  assert.deepEqual(registry.getPluginEntries('sidebar.primary', { ...options, authenticated: false }), []);
  assert.equal(registry.getPluginEntries('sidebar.secondary', { ...options, group: 'books' })[0].page, 'notes');
  assert.deepEqual(registry.getPluginEntries('sidebar.secondary', { ...options, group: 'elsewhere' }), []);
  assert.equal(registry.getPluginPage('reading-room', 'browse').playerPlacement, 'sidebar');
  assert.equal(registry.getPluginPage('reading-room', 'private').access, 'admin');
  assert.equal(registry.getPlugin('reading-room').pages.some(page => page.id === 'overview'), false, 'overview is host supplied');
  assert.deepEqual(registry.getPluginEntries('sidebar.primary', { ...options,
    availabilityById: { 'reading-room': { available: false, reason: 'incompatible_version' } } }), []);
  assert.deepEqual(registry.getPluginEntries('sidebar.primary', { installedIds: [],
    availabilityById: { 'reading-room': { available: true } } }), [], 'a stale availability row never reinstalls a plugin');
});

test('required dependencies gate every entry while optional features only degrade themselves', () => {
  const dependent = { ...fixture, dependencies: { catalog: { apiVersion: 1 } },
    optionalDependencies: { annotation: { apiVersion: 1, features: ['annotate'] } } };
  const catalog = { ...fixture, id: 'catalog', pages: [], entries: [] };
  const registry = createPluginRegistry([dependent, catalog]);
  assert.deepEqual(registry.getPluginEntries('sidebar.primary', { installedIds: ['reading-room'] }), []);
  const options = { installedIds: ['reading-room', 'catalog'] };
  assert.equal(registry.getPluginEntries('sidebar.primary', options).length, 1);
  const state = registry.getPluginAvailability('reading-room', options);
  assert.equal(state.available, true); assert.equal(state.optionalFeatures.annotate.available, false);
});

test('entry conditions are declarative AND checks and optional features require a usable declared dependency', () => {
  const conditional = { ...fixture, optionalDependencies: { annotation: { apiVersion: 1, features: ['annotate'] } }, entries: [
    { id: 'annotate', slot: 'menu.song', action: 'annotate', label: 'Annotate', icon: 'info', order: 1,
      access: 'authenticated', when: ['song', 'playing', 'output'], feature: 'annotate' },
  ] };
  const annotation = { ...fixture, id: 'annotation', pages: [], entries: [] };
  const registry = createPluginRegistry([conditional, annotation]);
  const options = { installedIds: ['reading-room', 'annotation'], song: { id: 'one' }, playing: true, output: { id: 'target' } };
  assert.equal(registry.getPluginEntries('menu.song', options).length, 1);
  for (const condition of ['song', 'playing', 'output']) {
    assert.deepEqual(registry.getPluginEntries('menu.song', { ...options, [condition]: null }), []);
  }
  assert.deepEqual(registry.getPluginEntries('menu.song', { ...options, installedIds: ['reading-room'] }), []);
  assert.deepEqual(registry.getPluginEntries('menu.song', { ...options,
    availabilityById: { 'reading-room': { available: true, optionalFeatures: { annotate: { available: false } } } } }), []);
  assert.deepEqual(registry.getPluginEntries('menu.song', { ...options, installedIds: ['reading-room'],
    availabilityById: { 'reading-room': { available: true, optionalFeatures: { annotate: { available: true } } } } }), []);
});

test('uninstalled plugins expose only overview while installed user sections share the host navigation contract', () => {
  const plugin = getPlugin('xiaomi-speaker');
  assert.deepEqual(getPluginSections(plugin, { isAdmin: true, installed: false }).map(section => section.id), ['overview']);
  assert.deepEqual(getPluginSections(plugin, { installed: true }).map(section => section.id), ['overview', 'connection', 'devices', 'playback']);
  assert.ok(getPluginSections(plugin, { installed: true }).every(section => section.icon && section.scope === 'account'));
  assert.deepEqual(getPluginSections(null), []);
});

test('localized labels preserve plugin identity and fall back to the plugin default without inventing legacy locale support', () => {
  const plugin = getPlugin('xiaomi-speaker');
  const english = localizePlugin(plugin, 'en'), chinese = localizePlugin(plugin, 'zh'), fallback = localizePlugin(plugin, 'fr');
  assert.equal(english.id, chinese.id); assert.equal(english.name, 'Xiaomi speakers'); assert.equal(chinese.name, '小米音箱');
  assert.equal(english.pages.find(page => page.id === 'connection').label, 'Account connection');
  assert.equal(chinese.pages.find(page => page.id === 'connection').label, '账号连接');
  assert.deepEqual(fallback.localization, { locale: 'en', fallback: true });
  assert.equal(fallback.name, english.name); assert.equal(plugin.name, '小米音箱');
  const legacy = localizePlugin(fixture, 'ja');
  assert.equal(legacy.name, 'Reading room'); assert.equal(legacy.supportedLocales, undefined);
});

test('optional introductions preserve old packages and legacy plain text without claiming an undeclared language', () => {
  assert.equal(localizePlugin(null, 'zh'), null);
  const legacy = localizePlugin(fixture, 'ja');
  assert.deepEqual(legacy.introduction, []); assert.equal(legacy.introductionLocale, null);
  assert.deepEqual(legacy.localization, { locale: 'ja', fallback: false });
  const paragraphs = ['Use <literal> text as written.', 'A second paragraph.'];
  const withIntroduction = localizePlugin({ ...fixture, introduction: paragraphs }, 'zh');
  assert.deepEqual(withIntroduction.introduction, paragraphs); assert.equal(withIntroduction.introductionLocale, null);
  assert.equal(withIntroduction.name, fixture.name); assert.equal(withIntroduction.description, fixture.description);
  assert.deepEqual(withIntroduction.localization, { locale: 'zh', fallback: false });
  assert.notEqual(withIntroduction.introduction, paragraphs, 'localized presentation does not expose the manifest array for mutation');
});

test('introductions choose the requested resource then default then legacy without changing existing localization semantics', () => {
  const plugin = { ...fixture, introduction: ['Legacy introduction'], supportedLocales: ['en', 'zh', 'ja'], defaultLocale: 'en',
    metadata: {
      en: { name: 'Reading room', description: 'English summary', introduction: ['English first paragraph', 'English second paragraph'] },
      zh: { name: '阅览室', description: '中文摘要', introduction: ['中文介绍'] },
      ja: { name: '閲覧室', description: '日本語の概要' },
    } };
  const api = createPluginRegistry([plugin]);
  const chinese = localizePlugin(api.getPlugin(plugin.id), 'zh');
  assert.deepEqual(chinese.introduction, ['中文介绍']); assert.equal(chinese.introductionLocale, 'zh');
  assert.equal(chinese.name, '阅览室'); assert.equal(chinese.description, '中文摘要');
  assert.deepEqual(chinese.localization, { locale: 'zh', fallback: false });
  const japanese = localizePlugin(api.getPlugin(plugin.id), 'ja');
  assert.deepEqual(japanese.introduction, plugin.metadata.en.introduction); assert.equal(japanese.introductionLocale, 'en');
  assert.equal(japanese.description, '日本語の概要'); assert.deepEqual(japanese.localization, { locale: 'ja', fallback: false });
  const unsupported = localizePlugin(api.getPlugin(plugin.id), 'ko');
  assert.deepEqual(unsupported.introduction, plugin.metadata.en.introduction); assert.equal(unsupported.introductionLocale, 'en');
  assert.deepEqual(unsupported.localization, { locale: 'en', fallback: true });
  const withoutDefaultIntroduction = { ...plugin, metadata: { ...plugin.metadata, en: { name: 'Reading room', description: 'English summary' } } };
  const legacyFallback = localizePlugin(withoutDefaultIntroduction, 'ja');
  assert.deepEqual(legacyFallback.introduction, ['Legacy introduction']); assert.equal(legacyFallback.introductionLocale, null);
  assert.equal(legacyFallback.description, '日本語の概要'); assert.deepEqual(legacyFallback.localization, { locale: 'ja', fallback: false });
  const noIntroduction = { ...withoutDefaultIntroduction };
  delete noIntroduction.introduction;
  assert.deepEqual(localizePlugin(noIntroduction, 'ja').introduction, []);
  assert.equal(localizePlugin(noIntroduction, 'ja').introductionLocale, null);
});

test('the primary settings page is the first declaration even when it is not visible to the active role', () => {
  const adminSettings = { id: 'site-settings', kind: 'settings', roles: ['admin'], scope: 'instance', label: 'Site settings', icon: 'settings' };
  const memberSettings = { id: 'personal-settings', kind: 'settings', roles: ['member'], scope: 'account', label: 'Personal settings', icon: 'settings' };
  const plugin = { ...fixture, pages: [fixture.pages[0], adminSettings, memberSettings], entries: [] };
  const api = createPluginRegistry([plugin]);
  assert.equal(getPrimaryPluginSettingsPageId(plugin), 'site-settings');
  assert.equal(getPrimaryPluginSettingsPageId(api.getPlugin(plugin.id)), 'site-settings');
  assert.deepEqual(api.getPluginPages(plugin.id, { installed: true, role: 'member' }).map(page => page.id), ['overview', 'browse', 'personal-settings']);
  assert.deepEqual(api.getPluginPages(plugin.id, { installed: true, role: 'admin' }).map(page => page.id), ['overview', 'browse', 'site-settings']);
  assert.deepEqual(api.getPluginPages(plugin.id, { installed: false, role: 'member' }).map(page => page.id), ['overview']);
  assert.deepEqual(api.getPluginPages(plugin.id, { installed: true, authenticated: false }), []);
  assert.equal(getPrimaryPluginSettingsPageId(fixture), null); assert.equal(getPrimaryPluginSettingsPageId(null), null);
  const privatePlugin = { ...plugin, id: 'private-plugin', pages: [adminSettings] };
  const privateApi = createPluginRegistry([privatePlugin]);
  assert.equal(getPrimaryPluginSettingsPageId(privateApi.getPlugin('private-plugin')), 'site-settings');
  assert.deepEqual(privateApi.getPluginPages('private-plugin', { installed: true, role: 'member' }), []);
});

test('member-only pages do not grant administrators service access and administrator-only plugins do not expose member overviews', () => {
  const memberOnly = { ...fixture, pages: [{ id: 'browse', kind: 'service', roles: ['member'], label: 'Member service', icon: 'library' }],
    entries: [{ id: 'browse', page: 'browse', slot: 'sidebar.primary', roles: ['member'], label: 'Open', icon: 'library', order: 1 }] };
  const registry = createPluginRegistry([memberOnly]);
  assert.deepEqual(registry.getPluginPages(memberOnly.id, { installed: true, isAdmin: true }).map(page => page.id), ['overview']);
  assert.deepEqual(registry.getPluginPages(memberOnly.id, { installed: true }).map(page => page.id), ['overview', 'browse']);
  assert.deepEqual(registry.getPluginEntries('sidebar.primary', { installedIds: [memberOnly.id], isAdmin: true }), []);
  const adminOnly = { ...memberOnly, id: 'gateway', entries: [], pages: [{ id: 'settings', kind: 'settings', roles: ['admin'], scope: 'instance', label: 'Settings', icon: 'settings' }] };
  const privateRegistry = createPluginRegistry([adminOnly]);
  assert.deepEqual(privateRegistry.getPluginPages('gateway', { installed: true }), []);
  assert.deepEqual(privateRegistry.getPluginPages('gateway', { installed: true, isAdmin: true }).map(page => page.id), ['overview', 'settings']);
});
