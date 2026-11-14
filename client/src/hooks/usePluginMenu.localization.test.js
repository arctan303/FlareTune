import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { createPluginRegistry, getPluginEntryRoute } from '../plugins/registry.js';

test('plugin menus follow language changes using package messages without a host translation dictionary', () => {
  const plugin = { id: 'custom-shelf', version: '1.0.0', apiVersion: 1, hostApiVersion: 1,
    name: 'Custom shelf', description: 'Synthetic package', icon: 'library', supportedLocales: ['en', 'zh'], defaultLocale: 'en',
    metadata: { en: { name: 'Custom shelf', description: 'Custom package' }, zh: { name: '自定义书架', description: '自定义插件' } },
    messages: { en: { 'shelf.save': 'Save to the custom shelf' }, zh: { 'shelf.save': '保存到自定义书架' } },
    pages: [], entries: [{ id: 'save', action: 'bookmark', slot: 'menu.song', roles: ['admin', 'member'],
      labelKey: 'shelf.save', icon: 'library', order: 1 }],
  };
  const registry = createPluginRegistry([plugin]);
  const installation = { loaded: true, installedIds: [plugin.id], availabilityById: {}, plugins: [{ id: plugin.id, installed: true, revision: 3 }] };
  const auth = { authenticated: true, user: { accountId: 'member-A', role: 'member' } };
  let locale = 'zh';
  const useStore = state => Object.assign(selector => selector ? selector(state) : state, { getState: () => state });
  const harness = createBackgroundModuleHarness({ file: new URL('./usePluginMenu.js', import.meta.url),
    modules: {
      '../i18n/index.js': { useLocale: () => locale },
      '../store/useUIStore.js': { useUIStore: useStore({ authSession: auth }) },
      '../store/usePlayerStore.js': { usePlayerStore: useStore({ currentSong: { id: 'playing' }, isPlaying: false }) },
      '../store/usePluginStore.js': { usePluginStore: useStore(installation) },
      '../store/useOutputTargetStore.js': { useOutputTargetStore: useStore({ target: null }) },
      '../plugins/registry.js': { ...registry, getPluginEntryRoute },
      '../plugins/compiled.js': { pluginBindings: { [plugin.id]: { actions: ['bookmark'] } } },
      '../plugins/menu.js': { createPluginMenuContext: () => ({}) },
      '../utils/navigation.js': { formatPath() {}, syncBrowserHistory() {} },
    }, globals: {}, render: exports => exports.usePluginMenu('menu.song', { song: { id: 'selected' } }),
  });
  let menu = harness.render();
  assert.equal(menu.entries[0].label, '保存到自定义书架');
  assert.equal(menu.entries[0].pluginId, plugin.id);
  assert.equal(menu.entries[0].action, 'bookmark');
  locale = 'en'; menu = harness.render();
  assert.equal(menu.entries[0].label, 'Save to the custom shelf');
  locale = 'ja'; menu = harness.render();
  assert.equal(menu.entries[0].label, 'Save to the custom shelf');
  assert.equal(menu.entries[0].plugin.localization.fallback, true);
  assert.equal(plugin.entries[0].label, undefined, 'language changes must not mutate the package declaration');
  menu.open(menu.entries[0]);
  assert.equal(harness.render().selection.entry.action, 'bookmark');
  installation.installedIds = [];
  assert.equal(harness.render().entries.length, 0, 'localization must retain installation gating');
  harness.unmount();
});
