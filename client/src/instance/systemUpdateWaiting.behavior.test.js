import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] : [];
function subject(exportName = 'SystemUpdateWaitingPage') {
  const scheduler = createBackgroundScheduler();
  const harness = createBackgroundModuleHarness({ file: new URL('./InstanceGate.jsx', import.meta.url), exportName,
    modules: { 'lucide-react': {}, './state.js': {}, './api.js': {}, '../authNavigation.js': {},
      '../utils/imageLoadRegistry.js': {}, '../components/TuneWordmark.jsx': {}, '../components/GoogleLogin.jsx': { GoogleSignInButton: 'google-sign-in' },
      '../components/SystemUpdatePanel.jsx': 'system-update-panel',
      './theme.js': {}, '../i18n/index.js': { t: value => value }, './instance.css': {} }, globals: scheduler });
  return { ...harness, scheduler };
}

test('system update maintenance waits without asking for initialization credentials', async () => {
  const s = subject(), calls = [], pending = [];
  const props = { onRefresh: options => { calls.push(options); return new Promise(resolve => pending.push(resolve)); } };
  let tree = s.render(props);
  assert.equal(tree.props.title, '系统正在更新');
  assert.equal(nodes(tree).some(node => node.type === 'input' || node.type === 'form'), false);
  assert.equal(s.scheduler.intervals.size, 1);
  s.scheduler.rotate(); s.scheduler.rotate();
  assert.equal(calls.length, 1); assert.equal(calls[0].background, true);
  tree = s.render(); assert.equal(nodes(tree).find(node => node.type === 'button').props.disabled, true);
  pending[0](null); await flushBackgroundAsync(); tree = s.render();
  assert.equal(nodes(tree).find(node => node.type?.name === 'StatusMessage').props.error, '暂时无法核实更新进度，将继续自动检查。');
  s.scheduler.rotate(); assert.equal(calls.length, 2);
  pending[1]({ state: 'ready' }); await flushBackgroundAsync(); tree = s.render();
  assert.equal(nodes(tree).find(node => node.type?.name === 'StatusMessage').props.error, '');
  assert.equal(nodes(tree).some(node => node.type === 'input'), false);
  s.unmount(); assert.equal(s.scheduler.intervals.size, 0);
});

test('the wait branch does not replace ordinary maintenance or recovery', () => {
  const s = subject('MaintenanceScreen');
  const onRefresh = async () => {};
  assert.equal(s.render({ status: { state: 'maintenance', reason: 'system_update_running' }, onRefresh }).type.name, 'SystemUpdateWaitingPage');
  assert.equal(s.render({ status: { state: 'maintenance', reason: 'migration_pending' }, onRefresh }).type.name, 'MaintenancePage');
  assert.equal(s.render({ status: { state: 'maintenance' }, onRefresh }).type.name, 'MaintenancePage');
  s.unmount();
});

test('unmounting while a background check is pending stops polling', async () => {
  const s = subject(); let resolve;
  s.render({ onRefresh: () => new Promise(done => { resolve = done; }) });
  s.scheduler.rotate(); s.unmount();
  assert.equal(s.scheduler.intervals.size, 0);
  resolve({ state: 'ready' }); await flushBackgroundAsync();
  assert.equal(s.scheduler.intervals.size, 0);
});

test('maintenance login reuses local credentials without mounting Google sign-in', () => {
  const s = subject('LoginPage'); let returned = false;
  assert.ok(nodes(s.render({ onSuccess() {} })).some(node => node.type === 'google-sign-in'));
  const tree = s.render({ onSuccess() {}, localOnly: true, onBack: () => { returned = true; } });
  assert.equal(nodes(tree).some(node => node.type === 'google-sign-in'), false);
  assert.equal(nodes(tree).filter(node => node.type === 'form').length, 1);
  assert.deepEqual(nodes(tree).filter(node => node.type?.name === 'Field').map(node => node.props.id), ['login-username', 'login-password']);
  const back = nodes(tree).find(node => node.type === 'button' && node.props.onClick);
  back.props.onClick(); assert.equal(returned, true);
  s.unmount();
});
