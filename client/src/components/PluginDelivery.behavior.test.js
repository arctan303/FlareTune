import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';
import { activePluginBuild } from '../hooks/usePluginDelivery.js';
import { localizePlugin } from '../plugins/registry.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children, tree.props?.action].flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const row = (version = '1.0.0') => ({ id: 'test-plugin', version, sourceId: 'workspace', sourceName: 'Current deployment',
  manifest: { id: 'test-plugin', version, name: 'Test plugin', description: 'Fixture', pages: [], entries: [] } });
function subject(file, exportName = 'default') {
  const writes = [], data = { revision: 1, settings: { mode: 'manual', hookConfigured: true, buildTokenConfigured: true },
    sources: [{ id: 'official', name: 'FlareTune', official: true, url: 'https://plugins.flaretune.dev/repository.json', status: 'unpublished' }],
    catalog: [row()], running: [], desired: [], pending: [], build: null };
  const delivery = { data, busy: false, error: '', action: async (...args) => { writes.push(structuredClone(args)); return data; } };
  const harness = createBackgroundModuleHarness({ file: new URL(file, import.meta.url), exportName,
    modules: { '../i18n/index.js': { t: key => key, useLocale: () => 'zh' },
      '../plugins/registry.js': { localizePlugin }, './SelectControl.jsx': 'select', './SettingsSection.jsx': 'section', './SettingsEditDialog.jsx': 'dialog',
      './SettingsControls.jsx': { SettingsButton: 'button', SettingsActions: 'actions', SettingsToggle: 'toggle' },
      './PluginConfirmDialog.jsx': 'confirmation', './PluginDeliveryView.jsx': { PluginDeliveryStatus: 'delivery-status' },
      '../hooks/usePluginDelivery.js': { activePluginBuild }, '../services/pluginDelivery.js': { deliveryErrorMessage: error => error } }, globals: { crypto },
  });
  return { ...harness, data, delivery, writes, view: () => harness.render({ delivery, renderLinks: () => 'links', renderOverviewLink: () => 'overview' }) };
}

test('discovery installs only after confirmation and does not change the running list', async () => {
  const s = subject('./PluginCatalogView.jsx');
  assert.match(text(s.view()), /暂无已安装/);
  button(s.view(), '发现插件').props.onClick();
  button(s.view(), '安装插件').props.onClick();
  assert.deepEqual(s.writes, []);
  const confirm = nodes(s.view()).find(node => node.type === 'confirmation');
  assert.equal(confirm.props.deliveryMode, 'manual'); assert.equal(confirm.props.deferred, true);
  await confirm.props.onConfirm();
  assert.deepEqual(s.writes, [['/selection', 'PUT', { pluginId: 'test-plugin', installed: true, sourceId: 'workspace', version: '1.0.0', trustCode: true }]]);
  assert.deepEqual(s.data.running, []);
  s.unmount();
});

test('the installed list offers newer versions only and locks selection during builds', () => {
  const s = subject('./PluginCatalogView.jsx');
  s.data.running = [row('1.1.0')]; s.data.desired = [row('1.1.0')];
  s.data.catalog = [row('1.0.0')];
  assert.equal(button(s.view(), '更新插件'), undefined);
  s.data.catalog.push(row('1.2.0'));
  assert.ok(button(s.view(), '更新插件'));
  s.data.build = { status: 'building' };
  assert.equal(button(s.view(), '更新插件').props.disabled, true);
  assert.equal(button(s.view(), '卸载插件').props.disabled, true);
  s.unmount();
});

test('manual batches build once and uncertainty offers explicit recovery without discarding', async () => {
  const s = subject('./PluginDeliveryView.jsx', 'PluginDeliveryStatus');
  s.data.pending = [{ id: 'test-plugin', operation: 'install', fromVersion: null, toVersion: '1.0.0' }];
  assert.match(text(s.view()), /当前版本继续运行/);
  button(s.view(), '构建并部署').props.onClick();
  await flushBackgroundAsync();
  assert.deepEqual(s.writes, [['/build']]);
  s.data.build = { id: 'unknown', status: 'failed', resultUnknown: true, error: 'timeout' };
  assert.equal(button(s.view(), '撤销待应用变更').props.disabled, true);
  button(s.view(), '核实并解除冻结').props.onClick();
  assert.match(text(s.view()), /不会替你取消远端构建/);
  await button(s.view(), '已核实远端任务停止').props.onClick();
  await flushBackgroundAsync();
  assert.deepEqual(s.writes.at(-1), ['/build/resolve', 'POST', { confirmedStopped: true }]);
  s.data.build.deploymentStarted = true;
  assert.equal(button(s.view(), '核实并解除冻结'), undefined);
  assert.equal(button(s.view(), '重试构建并部署').props.disabled, true);
  assert.match(text(s.view()), /受控恢复命令/);
  s.unmount();
});

test('configuration keeps stored secrets write-only and does not trigger a build', async () => {
  const s = subject('./PluginDeliveryView.jsx');
  assert.equal(nodes(s.view()).some(node => node.type === 'input'), false);
  button(s.view(), '配置构建').props.onClick();
  let tree = s.view(), inputs = nodes(tree).filter(node => node.type === 'input');
  assert.deepEqual(inputs.map(node => node.props.value), ['', '']);
  inputs[0].props.onChange({ target: { value: 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-hook-0123456789' } });
  tree = s.view();
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(s.writes, [['', 'PUT', { deployHookUrl: 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-hook-0123456789' }]]);
  button(s.view(), '添加插件源').props.onClick();
  tree = s.view();
  nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: 'https://plugins.flaretune.dev/repository.json' } });
  await nodes(s.view()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(s.writes.at(-1), ['/sources', 'POST', { url: 'https://plugins.flaretune.dev/repository.json' }]);
  assert.equal(s.writes.some(([path]) => path === '/build'), false);
  s.unmount();
});
