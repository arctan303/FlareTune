import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';
import { activeSystemUpdate, activePluginUpdate, retryableSystemUpdate } from '../hooks/useSystemUpdate.js';
import { systemUpdateErrorMessage } from '../services/systemUpdate.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children, tree.props?.action].flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const field = (tree, label) => nodes(tree).find(node => node.type === 'label' && text(node).startsWith(label))?.props.children.flat(Infinity).find(node => node?.type === 'input');
const dialogOf = tree => nodes(tree).find(node => node.type === 'dialog');
const submit = dialog => nodes(dialog).find(node => node.type === 'form').props.onSubmit(event());
const event = () => ({ preventDefault() {} });
function subject() {
  const writes = [], data = { revision: 1, configured: true, current: { version: '1.2.1', sourceDigest: 'old' },
    latest: { id: 'approved', version: '1.3.0', host: { sourceDigest: 'next' }, channel: 'stable', notes: { zh: '正式更新说明', en: 'Release notes' }, migration: { compatible: true } },
    job: null, configuration: { hookConfigured: true, tokenConfigured: true }, blockingReason: null };
  const update = { data, loading: false, busy: false, error: '', demo: false, refresh: async () => { writes.push(['refresh']); },
    action: async (...args) => { writes.push(structuredClone(args)); return data; } };
  const harness = createBackgroundModuleHarness({ file: new URL('./SystemUpdatePanel.jsx', import.meta.url), exportName: 'SystemUpdateView',
    modules: { '../i18n/index.js': { t: key => key, useLocale: () => 'zh' },
      '../hooks/useSystemUpdate.js': { activeSystemUpdate, activePluginUpdate, retryableSystemUpdate }, '../services/systemUpdate.js': { systemUpdateErrorMessage },
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

function includePlugins(s) {
  s.data.current.hostApiVersion = 6;
  s.data.latest.hostApiVersion = 7;
  s.data.pluginUpdates = { revision: 11, configured: true, blockedReason: null, build: null,
    candidates: [{ id: 'music', name: 'Music tools', sourceId: 'original', sourceName: 'Original source',
      sourceUrl: 'https://example.com/catalog.json', version: '2.0.0', currentVersion: '1.1.0', hostApiVersion: 6 },
    { id: 'radio', name: 'Radio tools', sourceId: 'official', version: '2.0.0', currentVersion: '1.0.0', hostApiVersion: 7 }] };
}

test('one confirmation shows code sources and sends only the selected host and plugins', async () => {
  const s = subject(); includePlugins(s);
  assert.equal(button(s.view(), '升级系统'), undefined);
  assert.match(text(s.view()), /Music tools1.1.0 → 2.0.0/u);
  button(s.view(), '选择更新').props.onClick();
  const dialog = () => dialogOf(s.view());
  assert.equal(button(dialog(), '确认升级').props.disabled, true);
  assert.equal(field(dialog(), 'Radio tools').props.disabled, true);
  field(dialog(), '基础服务').props.onChange({ target: { checked: true } });
  assert.equal(field(dialog(), 'Radio tools').props.disabled, false);
  field(dialog(), 'Radio tools').props.onChange({ target: { checked: true } });
  assert.match(text(dialog()), /Original sourcehttps:\/\/example\.com\/catalog\.json/u);
  assert.match(text(dialog()), /确认即表示信任所选来源/u);
  assert.match(text(dialog()), /基础服务验证完成后/u);
  assert.deepEqual(s.writes, []);
  await submit(dialog());
  assert.deepEqual(s.writes, [['/start', 'POST', { releaseId: 'approved', pluginRevision: 11,
    plugins: [{ id: 'radio', sourceId: 'official', version: '2.0.0' }], trustCode: true }]]);
  s.unmount();
});

test('plugin-only selection requires no available host release but refuses changed catalog targets', async () => {
  const s = subject(); includePlugins(s); s.data.latest = null;
  button(s.view(), '选择更新').props.onClick();
  const dialog = () => dialogOf(s.view());
  assert.equal(field(dialog(), '基础服务'), undefined);
  field(dialog(), 'Music tools').props.onChange({ target: { checked: true } });
  s.data.pluginUpdates.revision++;
  assert.equal(button(dialog(), '确认升级').props.disabled, true);
  assert.match(text(dialog()), /可用版本已变化/u);
  await submit(dialog()); assert.deepEqual(s.writes, []);
  dialog().props.onClose(); button(s.view(), '选择更新').props.onClick();
  assert.equal(field(dialog(), 'Music tools').props.checked, false);
  field(dialog(), 'Music tools').props.onChange({ target: { checked: true } });
  await submit(dialog());
  assert.deepEqual(s.writes, [['/start', 'POST', { releaseId: null, pluginRevision: 12,
    plugins: [{ id: 'music', sourceId: 'original', version: '2.0.0' }], trustCode: true }]]);
  s.unmount();
});

test('a persisted partial failure continues the plugin step, while an uncertain build stays locked', async () => {
  const s = subject(); includePlugins(s);
  s.data.job = { taskId: 'same-host-task', status: 'deployed', target: s.data.latest,
    followUp: { status: 'failed', canContinue: true, plugins: [{ id: 'radio', version: '2.0.0' }] } };
  s.data.pluginUpdates.build = { id: 'linked-child', updateTaskId: 'same-host-task', status: 'failed', retryable: true };
  assert.match(text(s.view()), /系统更新已完成/u);
  assert.match(text(s.view()), /插件更新未完成/u);
  assert.equal(button(s.view(), '选择更新').props.disabled, true);
  await button(s.view(), '继续更新插件').props.onClick();
  assert.deepEqual(s.writes, [['/continue', 'POST', { taskId: 'same-host-task' }]]);
  s.data.job.followUp = { ...s.data.job.followUp, status: 'awaiting_verification', canContinue: false };
  s.data.pluginUpdates.build = { ...s.data.pluginUpdates.build, status: 'activation_pending', resultUnknown: true };
  assert.equal(button(s.view(), '继续更新插件'), undefined);
  assert.equal(button(s.view(), '选择更新').props.disabled, true);
  assert.match(text(s.view()), /部署结果待确认/u);
  s.data.job.followUp = { ...s.data.job.followUp, status: 'failed', error: 'PLUGIN_DELIVERY_CHANGED' };
  s.data.pluginUpdates.build = null;
  assert.equal(button(s.view(), '继续更新插件'), undefined);
  assert.equal(button(s.view(), '选择更新').props.disabled, false);
  assert.match(text(s.view()), /插件更新未完成/u);
  s.data.job.followUp = { ...s.data.job.followUp, status: 'deployed', error: null };
  s.data.pluginUpdates.candidates = [];
  s.data.current.plugins = [{ id: 'radio', manifest: { name: 'Radio stations' } }];
  assert.match(text(s.view()), /Radio stations · 2\.0\.0/u);
  s.unmount();
});

test('only a known independent plugin failure offers retry and sends the matched build revision', async () => {
  const s = subject(); includePlugins(s);
  s.data.pluginUpdates.build = { id: 'plugin-only', status: 'failed', retryable: true, resultUnknown: true };
  assert.equal(button(s.view(), '继续更新插件'), undefined);
  s.data.pluginUpdates.build.resultUnknown = false;
  await button(s.view(), '继续更新插件').props.onClick();
  assert.deepEqual(s.writes, [['/plugin-retry', 'POST', { pluginRevision: 11, buildId: 'plugin-only' }]]);
  s.unmount();
});

test('Cloudflare verification shows evidence and a safe link without reporting update completion', async () => {
  const s = subject();
  s.data.job = { taskId: 'same-host-task', status: 'activation_pending', providerBuildId: 'same-build' };
  s.update.verify = async taskId => { s.writes.push(['verify', taskId]); };
  await button(s.view(), '核对云端状态').props.onClick();
  assert.deepEqual(s.writes, [['verify', 'same-host-task']]);
  s.update.verification = { result: { status: 'deployment_confirmed', buildUrl: 'https://dash.cloudflare.com/abcd/workers/builds/abcd' } };
  assert.match(text(s.view()), /云端正在为新版本提供服务，站内更新仍待完成/u);
  assert.doesNotMatch(text(s.view()), /系统更新已完成/u);
  const link = () => nodes(s.view()).find(node => node.type === 'a');
  assert.equal(link().props.rel, 'noopener noreferrer');
  s.update.verification.result.buildUrl = 'https://dash.cloudflare.com@other.example/build';
  assert.equal(link(), undefined);
  s.unmount();
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

test('a rejected Cloudflare deployment explains the permission repair and retries the original update', async () => {
  const s = subject();
  s.data.job = { taskId: 'rejected-deployment', status: 'activation_pending', target: s.data.latest, resumable: true,
    error: 'SYSTEM_UPDATE_PROMOTION_REJECTED' };
  const view = s.view();
  const alert = nodes(view).find(node => node.props?.role === 'alert');
  assert.match(text(alert), /Cloudflare 拒绝了这次发布。修复权限后可以继续原任务。/u);
  assert.match(text(view), /发布被拒绝/u);
  assert.doesNotMatch(text(view), /部署结果尚未确认/u);
  assert.equal(button(view, '升级系统').props.disabled, true);
  assert.equal(button(view, '继续核实更新'), undefined);
  button(view, '重试本次更新').props.onClick(); await flushBackgroundAsync();
  assert.deepEqual(s.writes, [['/retry', 'POST', { taskId: 'rejected-deployment' }]]);
  s.unmount();
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
