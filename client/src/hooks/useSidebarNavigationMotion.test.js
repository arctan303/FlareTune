import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSidebarNavigationScope } from './useSidebarNavigationMotion.js';

test('settings and service pages of one plugin share a sidebar workspace without replacing legacy workspaces', () => {
  const service = { page: 'plugin', pluginId: 'reading-room', pluginPage: 'browse' };
  assert.equal(resolveSidebarNavigationScope(service), 'plugin:reading-room');
  assert.equal(resolveSidebarNavigationScope({ page: 'settings', pluginId: 'reading-room', pluginSection: 'connection' }), 'plugin:reading-room');
  assert.equal(resolveSidebarNavigationScope({ ...service, pluginPage: 'notes' }), 'plugin:reading-room');
  assert.notEqual(resolveSidebarNavigationScope({ ...service, pluginId: 'other' }), resolveSidebarNavigationScope(service));
  assert.equal(resolveSidebarNavigationScope('lyrics'), 'lyrics');
  assert.equal(resolveSidebarNavigationScope('assistant'), 'assistant');
  assert.equal(resolveSidebarNavigationScope('home'), 'primary');
  assert.equal(resolveSidebarNavigationScope({ page: 'plugin', section: 'list' }), 'settings');
  assert.equal(resolveSidebarNavigationScope({ page: 'plugin', section: 'sources' }), 'settings');
});
