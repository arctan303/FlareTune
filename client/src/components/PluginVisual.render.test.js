import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as registry from '../plugins/registry.js';
import * as catalog from '../plugins/catalog.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
import { UI_LANGUAGES } from '../../../shared/uiLanguages.js';
import { t, getLocale, setUiLanguage } from '../i18n/index.js';

// Render the real catalog, overview, links and shared controls. Only external
// resource hooks and inactive plugin content/delivery surfaces are fixtures.
function visualView({ admin = true, manifest, manifests } = {}) {
  const require = createRequire(import.meta.url), cache = new Map();
  const api = manifest ? registry.createPluginRegistry(manifests || [manifest]) : registry;
  const plugin = api.getPlugin(manifest?.id || 'xiaomi-speaker');
  const session = { authenticated: true, user: { accountId: 'visual-fixture', role: admin ? 'admin' : 'member' }, csrfToken: 'fixture' };
  const rows = (manifests || [manifest || compiledPluginManifests.find(item => item.id === plugin.id)]).map(item => ({ id: item.id, version: item.version, sourceId: 'workspace', sourceName: 'Current deployment', manifest: item }));
  const resource = { plugins: rows.map(item => ({ id: item.id, installed: true, version: item.version, revision: 1 })), installedIds: rows.map(item => item.id),
    loaded: true, loading: false, busy: false, refresh: async () => {} };
  const delivery = { data: { running: rows, catalog: rows, desired: rows, pending: [], sources: [], settings: { mode: 'manual' } }, busy: false };
  const modules = {
    '../i18n/index.js': { t, useLocale: getLocale },
    '../../../shared/uiLanguages.js': { UI_LANGUAGES },
    '../plugins/registry.js': { ...registry, ...api },
    '../plugins/catalog.js': catalog,
    '../hooks/usePlugins.js': { usePlugins: () => resource },
    '../hooks/usePluginDelivery.js': { usePluginDelivery: () => delivery, activePluginBuild: () => false },
    '../utils/navigation.js': { formatPath: route => route.pluginId ? `/plugins/${route.pluginId}/${route.pluginPage}` : '/plugins', syncBrowserHistory() {} },
    './PluginContentBoundary.jsx': () => null,
    './PluginConfirmDialog.jsx': () => null,
    './PluginDeliveryView.jsx': { __esModule: true, default: () => null, PluginDeliveryStatus: () => null },
    // The shared selector has its own browser tests; native select keeps this
    // server-render check free of browser-only layout effects.
    './SelectControl.jsx': ({ children, ...props }) => React.createElement('select', props, children),
  };
  function load(file) {
    if (cache.has(String(file))) return cache.get(String(file));
    const module = { exports: {} }; cache.set(String(file), module);
    vm.runInNewContext(transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
      module, exports: module.exports, React, console,
      require(id) {
        if (id === 'react') return React;
        if (id in modules) return modules[id];
        return id.startsWith('.') ? load(new URL(id, file)).exports : require(id);
      },
    }, { filename: String(file) });
    return module;
  }
  const View = load(new URL('./PluginSettingsView.jsx', import.meta.url)).exports.default;
  return route => renderToStaticMarkup(React.createElement(View, { route: { type: 'page', page: 'plugin', ...route }, session }));
}

test('five-language catalog and overview render named controls, complete metadata and a separate danger region', async () => {
  for (const language of UI_LANGUAGES) {
    await setUiLanguage(language.id);
    const render = visualView();
    const catalog = render({ section: 'list' });
    assert.match(catalog, /class="[^"]*plugin-catalog-card__summary/);
    assert.match(catalog, /href="\/plugins\/xiaomi-speaker\/overview"/);
    assert.ok(catalog.includes(`aria-label="${t('设置')}"`));
    assert.ok(catalog.includes(`aria-label="${t('卸载插件')}"`));
    assert.doesNotMatch(catalog, /<details|alert\(/);
    const overview = render({ pluginId: 'xiaomi-speaker', pluginPage: 'overview' });
    assert.match(overview, /plugin-overview__metadata/);
    assert.match(overview, /plugin-overview__locales/);
    assert.ok(overview.includes(t('宿主 API')));
    assert.ok(overview.includes(t('支持语言')));
    assert.ok(overview.includes(registry.getPlugin('xiaomi-speaker').version));
    assert.ok(overview.includes('English'));
    assert.ok(overview.indexOf('plugin-overview__danger') > overview.indexOf('plugin-overview__metadata'));
    assert.ok(overview.includes(t('卸载将在构建并部署成功后生效，并保留插件数据和配置。')));
  }
  await setUiLanguage('en');
});

test('member overview keeps settings in the sidebar without a duplicate or administrator uninstall region', () => {
  const html = visualView({ admin: false })({ pluginId: 'xiaomi-speaker', pluginPage: 'overview' });
  assert.doesNotMatch(html, /href="\/plugins\/xiaomi-speaker\/connection"/);
  assert.doesNotMatch(html, /plugin-overview__danger/);
});

test('overview renders plugin-owned introduction paragraphs in every supported language and keeps the information compactly grouped', async () => {
  const manifest = { id: 'intro-fixture', version: '1.0.0', hostApiVersion: 3, apiVersion: 1, icon: 'puzzle', name: 'Intro fixture', description: 'Short catalog summary',
    supportedLocales: UI_LANGUAGES.map(item => item.id), defaultLocale: 'en', capabilityRoles: ['admin', 'member'],
    metadata: Object.fromEntries(UI_LANGUAGES.map(({ id }) => [id, { name: 'Plugin '+id, description: 'Short '+id,
      introduction: ['Purpose owned by plugin '+id, 'Setup and scope owned by plugin '+id] }])),
    pages: [{ id: 'connection', kind: 'settings', label: 'Connection', icon: 'settings', roles: ['admin', 'member'], scope: 'account' }], entries: [] };
  for (const { id } of UI_LANGUAGES) {
    await setUiLanguage(id);
    const render = visualView({ manifest });
    const html = render({ pluginId: manifest.id, pluginPage: 'overview' });
    assert.ok(html.includes(`<p>Purpose owned by plugin ${id}</p>`));
    assert.ok(html.includes(`<p>Setup and scope owned by plugin ${id}</p>`));
    assert.ok(html.includes('plugin-overview__summary-layout'));
    assert.ok(html.includes(`aria-label="${t('插件信息')}"`));
    assert.doesNotMatch(html, /href="\/plugins\/intro-fixture\/connection"/);
    const settings = render({ pluginId: manifest.id, pluginPage: 'connection' });
    assert.ok(settings.includes(`>${t('设置')}</h1>`));
  }
  await setUiLanguage('en');
});
