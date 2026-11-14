import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';
import { activeSystemUpdate, retryableSystemUpdate } from '../hooks/useSystemUpdate.js';
import { systemUpdateErrorMessage } from '../services/systemUpdate.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children, tree.props?.action].flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const field = (tree, label) => nodes(tree).find(node => node.type === 'label' && text(node).startsWith(label))?.props.children.flat(Infinity).find(node => node?.type === 'input');
const event = () => ({ preventDefault() {} });
function subject() {
  const writes = [], data = { revision: 1, configured: true, current: { version: '1.2.1', sourceDigest: 'old' },
    latest: { id: 'approved', version: '1.3.0', host: { sourceDigest: 'next' }, channel: 'stable', notes: { zh: '正式更新说明', en: 'Release notes' }, migration: { compatible: true } },
    job: null, configuration: { hookConfigured: true, tokenConfigured: true }, blockingReason: null };
  const update = { data, loading: false, busy: false, error: '', demo: false, refresh: async () => { writes.push(['refresh']); },
    action: async (...args) => { writes.push(structuredClone(args)); return data; } };
  const harness = createBackgroundModuleHarness({ file: new URL('./SystemUpdatePanel.jsx', import.meta.url), exportName: 'SystemUpdateView',
    modules: { '../i18n/index.js': { t: key => key, useLocale: () => 'zh' },
      '../hooks/useSystemUpdate.js': { activeSystemUpdate, retryableSystemUpdate }, '../services/systemUpdate.js': { systemUpdateErrorMessage },
      './SettingsSection.jsx': 'section', './SettingsEditDialog.jsx': 'dialog', './SettingsSkeleton.jsx': 'skeleton',
      './SettingsControls.jsx': { SettingsButton: 'button', SettingsActions: 'actions' } },
    globals: { crypto, navigator: { clipboard: { writeText: async () => {} } }, window: { location: { reload() {} } } } });
  return { ...harness, data, update, writes, view: () => harness.render({ update }) };
}

test('checking versions never starts an upgrade; only the confirmation submits its fixed release', async () => {
  const s = subject(); assert.match(text(s.view()), /FlareTune 1.2.1/);
  button(s.view(), '检查更新').props.onClick(); await flushBackgroundAsync();
  assert.deepEqual(s.writes, [['/check']]);
  button(s.view(), '升级系统').props.onClick();
  assert.equal(s.writes.length, 1); assert.match(text(s.view()), /正式更新说明/);
  const dialog = nodes(s.view()).find(node => node.type === 'dialog');
  assert.equal(dialog.props.title, '确认系统升级');
  await nodes(dialog).find(node => node.type === 'form').props.onSubmit(event());
  assert.deepEqual(s.writes[1], ['/start', 'POST', { releaseId: 'approved' }]);
  assert.equal(nodes(s.view()).some(node => node.type === 'dialog'), false); s.unmount();
});

test('configuration cancellation clears new secrets; blank fields preserve saved credentials', async () => {
  const s = subject(); button(s.view(), '配置更新通道').props.onClick();
  field(s.view(), '构建触发地址').props.onChange({ target: { value: 'private-hook-fixture' } });
  field(s.view(), '构建访问密钥').props.onChange({ target: { value: 'private-token-fixture' } });
  nodes(s.view()).find(node => node.type === 'dialog').props.onClose();
  assert.deepEqual(s.writes, []);
  button(s.view(), '配置更新通道').props.onClick();
  assert.equal(field(s.view(), '构建触发地址').props.value, '');
  assert.equal(field(s.view(), '构建访问密钥').props.value, '');
  assert.equal(field(s.view(), '构建访问密钥').props.type, 'password');
  await nodes(s.view()).find(node => node.type === 'form').props.onSubmit(event());
  assert.deepEqual(s.writes, [['', 'PUT', {}]]); s.unmount();
});

test('an unconfigured channel cannot start updates and missing credentials stay in the form', async () => {
  const s = subject(); s.data.configured = false; s.data.configuration = { hookConfigured: false, tokenConfigured: false };
  assert.equal(button(s.view(), '升级系统').props.disabled, true);
  button(s.view(), '配置更新通道').props.onClick();
  await nodes(s.view()).find(node => node.type === 'form').props.onSubmit(event());
  assert.equal(s.writes.length, 0);
  assert.equal(nodes(s.view()).find(node => node.type === 'dialog').props.message, '请填写构建触发地址和访问密钥。');
  button(s.view(), '生成新密钥').props.onClick();
  assert.match(field(s.view(), '构建访问密钥').props.value, /^[a-f0-9]{64}$/);
  s.unmount();
});

test('unknown results lock new targets and recovery retries the same persisted task', async () => {
  const s = subject(); s.data.job = { taskId: 'persisted-task', status: 'activation_pending', target: s.data.latest };
  assert.equal(button(s.view(), '升级系统').props.disabled, true);
  assert.equal(button(s.view(), '检查更新').props.disabled, true);
  assert.equal(button(s.view(), '配置更新通道').props.disabled, true);
  assert.match(text(s.view()), /当前目标已锁定/);
  assert.doesNotMatch(text(s.view()), /当前版本继续运行/);
  assert.equal(button(s.view(), '撤销待应用变更'), undefined);
  button(s.view(), '继续核实更新').props.onClick(); await flushBackgroundAsync();
  assert.deepEqual(s.writes, [['/retry', 'POST', { taskId: 'persisted-task' }]]); s.unmount();
});

test('failed jobs have real retry; blocking plugin changes explain the disabled update', async () => {
  const s = subject(); s.data.blockingReason = 'SYSTEM_UPDATE_PLUGIN_PENDING';
  assert.equal(button(s.view(), '升级系统').props.disabled, true);
  assert.match(text(s.view()), /请先完成或撤销待应用的插件变更/);
  s.data.blockingReason = null; s.data.job = { taskId: 'failed-task', status: 'failed', error: 'unsafe upstream fixture' };
  assert.match(text(s.view()), /系统更新未完成，请刷新核实状态/);
  assert.doesNotMatch(text(s.view()), /unsafe upstream fixture/);
  button(s.view(), '重试本次更新').props.onClick(); await flushBackgroundAsync();
  assert.deepEqual(s.writes, [['/retry', 'POST', { taskId: 'failed-task' }]]); s.unmount();
});

test('candidate builds are marked as unannounced and a changed release cannot be submitted', async () => {
  const s = subject(); s.data.current.version = '1.3.0'; s.data.latest.channel = 'candidate';
  assert.equal(s.exports.systemUpdateAvailable(s.data), true);
  assert.match(text(s.view()), /待正式发布版本/);
  button(s.view(), '升级系统').props.onClick();
  assert.match(text(s.view()), /尚未正式发布/);
  s.data.latest = { ...s.data.latest, id: 'different-approved-release' };
  assert.equal(button(s.view(), '确认升级').props.disabled, true);
  await nodes(s.view()).find(node => node.type === 'form').props.onSubmit(event());
  assert.deepEqual(s.writes, []); s.unmount();
});

test('Demo and initial errors expose no update or configuration action', () => {
  const demo = subject(); demo.update.demo = true;
  assert.match(text(demo.view()), /演示模式不连接真实更新通道/);
  assert.equal(button(demo.view(), '升级系统'), undefined); assert.equal(button(demo.view(), '配置更新通道'), undefined);
  demo.unmount();
  const failed = subject(); failed.update.data = null; failed.update.error = '无法读取系统更新状态。';
  assert.equal(nodes(failed.view()).find(node => node.props?.role === 'alert').props.children[0], '无法读取系统更新状态。');
  assert.equal(button(failed.view(), '升级系统'), undefined); assert.ok(button(failed.view(), '重试')); failed.unmount();
});

test('an open confirmation rechecks blockers and tolerates unavailable current runtime metadata', async () => {
  const s = subject(); button(s.view(), '升级系统').props.onClick();
  for (const change of [() => { s.data.blockingReason = 'SYSTEM_UPDATE_PLUGIN_PENDING'; },
    () => { s.data.blockingReason = null; s.data.current = null; }]) {
    change();
    assert.equal(button(s.view(), '确认升级').props.disabled, true);
    await nodes(s.view()).find(node => node.type === 'form').props.onSubmit(event());
    assert.deepEqual(s.writes, []);
  }
  assert.match(text(s.view()), /未知 → 1.3.0/);
  s.unmount();
});

test('only a backend-confirmed resumable active task offers same-task verification', async () => {
  const s = subject();
  s.data.job = { taskId: 'stalled-migration', status: 'migrating', target: s.data.latest, resumable: false };
  assert.equal(button(s.view(), '继续核实更新'), undefined);
  assert.equal(button(s.view(), '升级系统').props.disabled, true);
  s.data.job.resumable = true;
  assert.equal(button(s.view(), '继续核实更新').props.disabled, false);
  assert.match(text(s.view()), /更新暂时没有继续推进/);
  button(s.view(), '继续核实更新').props.onClick(); await flushBackgroundAsync();
  assert.deepEqual(s.writes, [['/retry', 'POST', { taskId: 'stalled-migration' }]]);
  assert.equal(button(s.view(), '升级系统').props.disabled, true);
  s.unmount();
});
