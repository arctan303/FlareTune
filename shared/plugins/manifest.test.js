import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalPluginManifest, getRequiredDependents, resolvePluginAvailability, satisfiesPluginVersion, validatePluginManifests,
  canAccessPluginDeclaration, isPluginVisibleToRole, HOST_PLUGIN_API_VERSION, normalizePluginUiLanguage } from './manifest.js';
import { compiledPluginManifests } from './catalog.js';

const manifest = (id, extra = {}) => ({ id, version: '1.2.0', hostApiVersion: 1, apiVersion: 1,
  name: id, description: 'Synthetic plugin', icon: 'box', pages: [], entries: [], ...extra });

test('API3 capabilities preserve API1/2 packages and service slots require bounded declared dependencies', () => {
  assert.equal(HOST_PLUGIN_API_VERSION, 3);
  for (const hostApiVersion of [1, 2, 3]) {
    assert.equal(resolvePluginAvailability([manifest('compatible', { hostApiVersion })], ['compatible'], 'compatible').available, true);
  }
  const dependency = { dependencies: { provider: { apiVersion: 1 } } };
  validatePluginManifests([manifest('consumer', { ...dependency, serviceConfigurations: { provider: ['ai-model'] } })]);
  for (const extra of [
    { serviceConfigurations: { provider: ['ai-model'] } },
    { ...dependency, serviceConfigurations: { provider: ['ai-model','ai-model'] } },
    { ...dependency, serviceConfigurations: { provider: ['foreign.key'] } },
    { ...dependency, serviceConfigurations: { provider: Array.from({ length: 17 }, (_, i) => `model-${i}`) } },
  ]) assert.throws(() => validatePluginManifests([manifest('consumer', extra)]));
});

test('host API 3 preserves existing API 1 and 2 packages and rejects newer minimum requirements', () => {
  assert.equal(HOST_PLUGIN_API_VERSION, 3);
  for (const hostApiVersion of [1, 2, 3]) {
    const item = manifest('compatible', { hostApiVersion });
    assert.equal(resolvePluginAvailability([item], ['compatible'], 'compatible').available, true);
  }
  const future = manifest('future', { hostApiVersion: 4 });
  assert.equal(resolvePluginAvailability([future], ['future'], 'future').reason, 'host_incompatible');
});

test('installation UI language normalizes the five supported languages and safe regional aliases', () => {
  for (const [input, expected] of [
    ['en', 'en'], ['zh', 'zh'], ['zh-Hant', 'zh-Hant'], ['ja', 'ja'], ['ko', 'ko'],
    ['en-US,en;q=0.9', 'en'], ['zh-CN', 'zh'], ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'],
    ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['JA-jp', 'ja'], ['ZH-CN', 'zh'], ['KO', 'ko'],
    [' zh-Hant-TW ', 'zh-Hant'],
  ]) assert.equal(normalizePluginUiLanguage(input), expected, String(input));
  for (const input of ['unknown', 'fr', 'de-DE', '', null, undefined, 42, {}, 'auto']) {
    assert.equal(normalizePluginUiLanguage(input), 'en', String(input));
  }
});

test('roles are exact, legacy declarations map consistently and instance settings stay administrator-only', () => {
  assert.equal(canAccessPluginDeclaration({ access: 'authenticated' }, 'member'), true);
  assert.equal(canAccessPluginDeclaration({ access: 'authenticated' }, 'admin'), true);
  assert.equal(canAccessPluginDeclaration({ roles: ['member'] }, 'admin'), false);
  assert.equal(canAccessPluginDeclaration({ roles: ['member'] }, 'member'), true);
  assert.equal(canAccessPluginDeclaration({ roles: ['member'], access: 'admin' }, 'member'), false);
  const page = { id: 'editor', kind: 'service', roles: ['member'], label: 'Editor', icon: 'box' };
  assert.equal(validatePluginManifests([manifest('roles', { pages: [page] })]).length, 1);
  for (const patch of [{ roles: [] }, { roles: ['admin', 'admin'] }, { roles: ['guest'] },
    { roles: ['member'], access: 'authenticated' }, { kind: 'settings', scope: 'instance' }, { scope: 'account' }]) {
    assert.throws(() => validatePluginManifests([manifest('roles', { pages: [{ ...page, ...patch }] })]), { code: 'PLUGIN_MANIFEST_INVALID' });
  }
  const adminPage = { ...page, kind: 'settings', scope: 'instance', roles: ['admin'], access: 'admin' };
  validatePluginManifests([manifest('roles', { pages: [adminPage] })]);
  assert.throws(() => validatePluginManifests([manifest('roles', { pages: [page], entries: [
    { id: 'open', page: 'editor', slot: 'sidebar.primary', roles: ['admin', 'member'], label: 'Open', icon: 'box', order: 1 },
  ] })]), { code: 'PLUGIN_MANIFEST_INVALID' });
});

test('visible direct capabilities include settings-only sources without exposing administrator-only dependencies', () => {
  const gateway = manifest('gateway', { pages: [{ id: 'settings', kind: 'settings', roles: ['admin'], scope: 'instance', label: 'Settings', icon: 'box' }] });
  assert.equal(isPluginVisibleToRole(gateway, 'member'), false);
  assert.equal(isPluginVisibleToRole(gateway, 'admin'), true);
  assert.equal(isPluginVisibleToRole({ ...gateway, capabilityRoles: ['member', 'admin'] }, 'member'), true);
  assert.equal(isPluginVisibleToRole(manifest('empty'), 'member'), false, 'the host overview is not a declared business capability');
  assert.equal(isPluginVisibleToRole(gateway, 'guest'), false);
});

test('locale claims require complete metadata, valid defaults and declared label resources', () => {
  const base = manifest('localized', { supportedLocales: ['en', 'zh'], defaultLocale: 'en', metadata: {
    en: { name: 'Example', description: 'English example' }, zh: { name: '示例', description: '中文示例' },
  }, messages: { en: { editor: 'Editor' }, zh: { editor: '编辑' } }, pages: [
    { id: 'editor', kind: 'service', roles: ['admin', 'member'], labelKey: 'editor', icon: 'box' },
  ] });
  validatePluginManifests([base]);
  for (const patch of [{ defaultLocale: 'ja' }, { supportedLocales: ['en', 'en'] }, { supportedLocales: ['en', 'fr'] },
    { metadata: { en: base.metadata.en } }, { messages: { en: { editor: 'Editor' }, zh: {} } },
    { messages: { en: { editor: 'Editor' }, zh: { editor: 8 } } }]) {
    assert.throws(() => validatePluginManifests([{ ...base, ...patch }]), { code: 'PLUGIN_MANIFEST_INVALID' });
  }
  assert.throws(() => validatePluginManifests([manifest('legacy', { messages: { en: {} } })]), { code: 'PLUGIN_MANIFEST_INVALID' });
});

test('compiled Xiaomi is pure shared data with personal pages and generic entry slots', () => {
  assert.equal(validatePluginManifests(compiledPluginManifests), compiledPluginManifests);
  const xiaomi = compiledPluginManifests.find(plugin => plugin.id === 'xiaomi-speaker');
  assert.equal(xiaomi.version, '1.1.0'); assert.equal(xiaomi.dataVersion, 0);
  assert.deepEqual(xiaomi.pages.map(page => page.id), ['connection', 'devices', 'playback']);
  assert.ok(xiaomi.pages.every(page => page.access === 'authenticated'));
  assert.ok(xiaomi.entries.filter(entry => entry.slot.startsWith('menu.')).every(entry => entry.action === 'output'));
  assert.ok(!canonicalPluginManifest(xiaomi).includes('loadContent'));
  assert.equal(canonicalPluginManifest({ b: 1, a: { d: 2, c: 3 } }), canonicalPluginManifest({ a: { c: 3, d: 2 }, b: 1 }));
});

test('invalid identifiers, duplicates, targets, access, slots and executable values are rejected', () => {
  const page = { id: 'settings', kind: 'settings', access: 'admin', playerPlacement: 'inherit', label: 'Settings', icon: 'box' };
  const entry = { id: 'settings', slot: 'sidebar.primary', page: 'settings', label: 'Settings', icon: 'box', order: 1, access: 'admin' };
  const cases = [
    [manifest('Bad_ID')], [manifest('a'), manifest('a')], [manifest('a', { version: 'latest' })],
    [manifest('a', { pages: [{ ...page, id: 'overview' }] })],
    [manifest('a', { pages: [page], entries: [{ ...entry, page: 'missing' }] })],
    [manifest('a', { pages: [page], entries: [{ ...entry, access: 'authenticated' }] })],
    [manifest('a', { pages: [page], entries: [{ ...entry, slot: 'sidebar.secondary' }] })],
    [manifest('a', { loadContent() {} })], [manifest('a', { dependencies: { gateway: { apiVersion: 0 } } })],
  ];
  for (const value of cases) assert.throws(() => validatePluginManifests(value), { code: 'PLUGIN_MANIFEST_INVALID' });
});

test('required missing, incompatible, uninstalled and cyclic dependencies block availability', () => {
  const consumer = manifest('consumer', { dependencies: { gateway: { apiVersion: 1, version: '^1.0.0' } } });
  assert.equal(resolvePluginAvailability([consumer], ['consumer'], 'consumer').reason, 'missing_dependency');
  assert.equal(resolvePluginAvailability([consumer, manifest('gateway')], ['consumer'], 'consumer').reason, 'dependency_not_installed');
  assert.equal(resolvePluginAvailability([consumer, manifest('gateway', { apiVersion: 2 })], ['consumer', 'gateway'], 'consumer').reason, 'incompatible_dependency');
  const cycle = [consumer, manifest('gateway', { dependencies: { consumer: { apiVersion: 1 } } })];
  assert.ok(resolvePluginAvailability(cycle, ['consumer', 'gateway'], 'consumer').issues.some(issue => issue.code === 'dependency_cycle'));
  assert.equal(resolvePluginAvailability([manifest('a', { hostApiVersion: HOST_PLUGIN_API_VERSION + 1 })], ['a'], 'a').reason, 'host_incompatible');
});

test('optional dependencies affect named features only and never block uninstall', () => {
  const catalog = [manifest('gateway'), manifest('assistant', { dependencies: { gateway: { apiVersion: 1 } } }),
    manifest('lyrics', { optionalDependencies: { gateway: { apiVersion: 1, features: ['ai'] } } }),
    manifest('consumer', { dependencies: { assistant: { apiVersion: 1 } } })];
  const without = resolvePluginAvailability(catalog, ['lyrics'], 'lyrics');
  assert.equal(without.available, true); assert.equal(without.optionalFeatures.ai.available, false);
  assert.equal(resolvePluginAvailability(catalog, ['lyrics', 'gateway'], 'lyrics').optionalFeatures.ai.available, true);
  assert.deepEqual(getRequiredDependents(catalog, ['assistant', 'consumer', 'lyrics', 'gateway'], 'gateway'), ['assistant', 'consumer']);
});

test('package versions distinguish exact, caret and tilde releases', () => {
  for (const [version, range, expected] of [['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false],
    ['1.8.0', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['1.3.0', '~1.2.0', false],
    ['0.2.9', '^0.2.0', true], ['0.3.0', '^0.2.0', false], ['0.0.2', '^0.0.1', false]]) {
    assert.equal(satisfiesPluginVersion(version, range), expected, `${version} ${range}`);
  }
});

test('entry display conditions and optional features are declarative and secondary navigation stays in owned groups', () => {
  const base = manifest('sample', { optionalDependencies: { gateway: { apiVersion: 1, features: ['ai'] } },
    pages: [{ id: 'editor', kind: 'service', access: 'authenticated', playerPlacement: 'sidebar', label: 'Editor', icon: 'box', group: 'workspace' }],
    entries: [{ id: 'edit', slot: 'sidebar.secondary', page: 'editor', label: 'Editor', icon: 'box', order: 1,
      access: 'authenticated', group: 'workspace', when: ['song', 'playing'], feature: 'ai' }] });
  assert.equal(validatePluginManifests([base])[0], base);
  for (const change of [{ group: 'another-plugin' }, { when: 'song' }, { when: ['eval'] }, { when: ['song', 'song'] }, { feature: 'unregistered' }]) {
    assert.throws(() => validatePluginManifests([{ ...base, entries: [{ ...base.entries[0], ...change }] }]), { code: 'PLUGIN_MANIFEST_INVALID' });
  }
});
