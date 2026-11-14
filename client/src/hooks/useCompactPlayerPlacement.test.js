import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompactPlayerPlacement } from './useCompactPlayerPlacement.js';
import { createPluginRegistry, canAccessPluginDeclaration } from '../plugins/registry.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';

test('assistant temporarily uses the sidebar without replacing the chosen layout', () => {
  const selected = { preferred: 'dock' };
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'home' }), 'dock');
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'assistant' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'lyrics' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'roam' }), 'dock');
  assert.equal(selected.preferred, 'dock');
});

test('a registered service page temporarily avoids the dock without changing the saved player placement', () => {
  const registry = createPluginRegistry([{ id: 'reading-room', version: '1.0.0', apiVersion: 1, hostApiVersion: 1,
    name: 'Reading', description: 'Fixture only', icon: 'library', entries: [], pages: [
      { id: 'browse', label: 'Browse', icon: 'library', kind: 'service', access: 'authenticated', playerPlacement: 'sidebar' },
      { id: 'notes', label: 'Notes', icon: 'info', kind: 'service', access: 'authenticated', playerPlacement: 'inherit' },
    ] }]);
  const preferred = 'dock', activeRoute = { page: 'plugin', pluginId: 'reading-room', pluginPage: 'browse' };
  const pluginPage = registry.getPluginPage('reading-room', 'browse');
  assert.equal(resolveCompactPlayerPlacement({ preferred, activePage: 'plugin', activeRoute, pluginPage }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ preferred, activePage: 'plugin', activeRoute, pluginPage, pluginAvailable: false }), 'dock');
  assert.equal(resolveCompactPlayerPlacement({ preferred, activePage: 'plugin', activeRoute,
    pluginPage: registry.getPluginPage('reading-room', 'notes') }), 'dock');
  assert.equal(resolveCompactPlayerPlacement({ preferred, activePage: 'home' }), 'dock');
});

test('the global sidebar preference resumes after page overrides', () => {
  assert.equal(resolveCompactPlayerPlacement({ preferred: 'sidebar', activePage: 'home' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ preferred: 'sidebar', activePage: 'assistant' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ preferred: 'dock', activePage: 'home' }), 'dock');
});

test('actual business plugin pages override the dock only when the installed page is usable by the current role', () => {
  const registry = createPluginRegistry(compiledPluginManifests);
  const ui = { compactPlayerPlacement: 'dock', authSession: { authenticated: true, user: { role: 'member' } } };
  const plugins = { installedIds: [], availabilityById: {} };
  const view = createBackgroundModuleHarness({ file: new URL('./useCompactPlayerPlacement.js', import.meta.url), exportName: 'useCompactPlayerPlacement',
    modules: { '../store/useUIStore.js': { useUIStore: select => select(ui) },
      '../store/usePluginStore.js': { usePluginStore: select => select(plugins) },
      '../components/fullscreen/useMediaQuery.js': { useMediaQuery: () => true },
      '../plugins/registry.js': { ...registry, canAccessPluginDeclaration } }, globals: {} });
  const route = { page: 'plugin', pluginId: 'assistant', pluginPage: 'conversation' };
  assert.equal(view.render(route).placement, 'dock');
  plugins.installedIds = ['assistant'];
  assert.equal(view.render(route).isPageOverride, false);
  plugins.installedIds = ['assistant', 'ai-gateway'];
  assert.equal(view.render(route).placement, 'sidebar');
  assert.equal(ui.compactPlayerPlacement, 'dock');
  plugins.installedIds = ['lyrics-workbench'];
  assert.equal(view.render({ page: 'plugin', pluginId: 'lyrics-workbench', pluginPage: 'current' }).placement, 'sidebar', 'ordinary lyrics work without Gateway');
  assert.equal(view.render({ page: 'plugin', pluginId: 'lyrics-workbench', pluginPage: 'configuration' }).isPageOverride, false);
  view.unmount();
});
