import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';

test('plugin lazy-load failure stays local, shows a safe error, and retry creates a fresh lazy loader', () => {
  let loads = 0;
  const react = { ...React, lazy: () => { loads++; return 'plugin-content'; } };
  const code = transformSync(readFileSync(new URL('./PluginContentBoundary.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  const dependencies = { react, '../i18n/index.js': { t: text => text }, '../plugins/host.js': { createPluginHost() {} }, './SettingsSkeleton.jsx': 'skeleton', './SettingsControls.jsx': { SettingsButton: 'button' } };
  new Function('require', 'module', 'exports', code)(id => dependencies[id], module, module.exports);
  const Boundary = module.exports.default;
  const boundary = new Boundary({ plugin: { id: 'test-plugin', loadContent() {} }, section: 'connection', session: {} });
  boundary.setState = patch => { boundary.state = { ...boundary.state, ...patch }; };
  boundary.render(); assert.equal(loads, 1);
  boundary.state = Boundary.getDerivedStateFromError(new Error('private import detail'));
  const failed = boundary.render();
  assert.equal(failed.props.role, 'alert');
  assert.equal(failed.props.children[0].props.children, '插件内容加载失败，请重试。');
  failed.props.children[1].props.onClick(); boundary.render();
  assert.equal(loads, 2);
  assert.equal(boundary.state.failed, false);
});

test('a content session reuses one facade and aborts its requests when its host page unmounts', () => {
  const scopes = [];
  const harness = createBackgroundModuleHarness({ file: new URL('./PluginContentBoundary.jsx', import.meta.url), exportName: 'PluginContentSession',
    modules: { '../i18n/index.js': { t: key => key }, './SettingsSkeleton.jsx': 'skeleton', './SettingsControls.jsx': { SettingsButton: 'button' },
      '../plugins/host.js': { createPluginHost: (plugin, options) => { const host = { pluginId: plugin.id, signal: options.signal }; scopes.push(host); return host; } } },
    globals: { AbortController } });
  const props = { Content: 'plugin-content', plugin: { id: 'reading-room' }, page: { id: 'browse' }, section: 'browse',
    session: { authenticated: true, user: { accountId: 'fixture' }, csrfToken: 'host-only-secret' } };
  const first = harness.render(props), second = harness.render(props);
  assert.equal(scopes.length, 1); assert.equal(first.props.host, second.props.host);
  assert.equal(first.props.pageId, 'browse'); assert.equal(first.props.host.signal.aborted, false);
  assert.equal(Object.hasOwn(first.props, 'session'), false);
  assert.equal(JSON.stringify(first.props).includes('host-only-secret'), false);
  harness.unmount(); assert.equal(first.props.host.signal.aborted, true);
});
