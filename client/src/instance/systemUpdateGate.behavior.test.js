import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import * as instanceState from './state.js';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const AUTH_UPDATED = 'test-auth-updated', AUTH_INVALIDATED = 'test-auth-invalidated', AUTH_CHECK_FAILED = 'test-check-failed', UPDATE_STATUS = 'test-update-status';
const account = id => ({ authenticated: true, mustChangePassword: false, csrfToken: `csrf-${id}`,
  user: { accountId: id, username: id.toLowerCase(), displayName: id, role: 'admin', status: 'active', uiLanguage: 'en' } });
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)] : [];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

async function gateSubject(t, { maintenance = false, initialSession = account('OLD-A') } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-update-gate-'));
  const file = join(directory, 'InstanceGate.cjs');
  // Preserve the real component while making its lazy store imports use the
  // same controlled module loader as ordinary imports in the hook harness.
  const source = await readFile(new URL('./InstanceGate.jsx', import.meta.url), 'utf8');
  await writeFile(file, transformSync(source, { loader: 'jsx', format: 'cjs', supported: { 'dynamic-import': false } }).code);
  const listeners = new Map(), statusRequests = [], sessionRequests = [], scopes = [];
  const window = {
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
  };
  const store = { setAuthSession() {} };
  const useUIStore = { subscribe: () => () => {}, getState: () => store };
  const App = () => null;
  const harness = createBackgroundModuleHarness({ file: pathToFileURL(file), modules: {
    'lucide-react': {}, './state.js': instanceState,
    './api.js': {
      getInstanceStatus: () => { const request = deferred(); statusRequests.push(request); return request.promise; },
      getSession: () => { const request = deferred(); sessionRequests.push(request); return request.promise; },
      logout: async () => {},
    },
    '../authNavigation.js': { AUTH_SESSION_UPDATED_EVENT: AUTH_UPDATED, AUTH_SESSION_INVALIDATED_EVENT: AUTH_INVALIDATED,
      AUTH_SESSION_CHECK_FAILED_EVENT: AUTH_CHECK_FAILED },
    '../services/systemUpdate.js': { SYSTEM_UPDATE_STATUS_EVENT: UPDATE_STATUS, recheckSystemUpdateStatus: async () => false },
    '../utils/imageLoadRegistry.js': { imageLoadRegistry: { setSessionScope: value => scopes.push(value?.user?.accountId || null) } },
    '../components/TuneWordmark.jsx': {}, '../components/GoogleLogin.jsx': {},
    '../components/SystemUpdatePanel.jsx': 'system-update-panel',
    '../store/useUIStore.js': { useUIStore }, './theme.js': { useInstanceTheme() {} },
    '../i18n/index.js': { t: value => value, useLocale() {}, setUiLanguage() {}, getUiLanguage: () => 'en' }, './instance.css': {},
  }, globals: { window, Event } });
  t.after(async () => { harness.unmount(); await rm(file); await rmdir(directory); });
  const render = () => harness.render({ App });
  render(); statusRequests.shift().resolve({ state: 'maintenance', ...(maintenance ? { reason: 'system_update_running' } : {}) });
  await flushBackgroundAsync();
  if (maintenance) { sessionRequests.shift().resolve(initialSession); await flushBackgroundAsync(); }
  const refresh = render().props.onRefresh;
  assert.equal(typeof refresh, 'function');
  if (!maintenance) {
    const ready = refresh({ background: true });
    statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
    sessionRequests.shift().resolve(account('OLD-A')); await ready;
    render(); await flushBackgroundAsync(); render();
  }
  return { render, refresh, window, scopes, statusRequests, sessionRequests, App,
    maintenanceTree() { const view = render(); assert.equal(view.type.name, 'MaintenanceScreen'); return harness.exports.MaintenanceScreen(view.props); },
    dispatch(type, detail) { window.dispatchEvent({ type, detail }); },
    appSession() { return nodes(render()).find(node => node.type === App)?.props.validatedSession; },
  };
}

test('refreshing during an update authenticates administrators and restores only update management', async t => {
  for (let reload = 0; reload < 2; reload++) {
    const s = await gateSubject(t, { maintenance: true });
    const panel = nodes(s.maintenanceTree()).find(node => node.type === 'system-update-panel');
    assert.equal(panel.props.session.user.accountId, 'OLD-A');
    assert.equal(s.appSession(), undefined);
    const refresh = s.refresh({ background: true });
    s.statusRequests.shift().resolve({ state: 'maintenance', reason: 'system_update_running' }); await flushBackgroundAsync();
    s.sessionRequests.shift().resolve(account('OLD-A')); await refresh;
    assert.ok(nodes(s.maintenanceTree()).find(node => node.type === 'system-update-panel'));
    assert.equal(s.appSession(), undefined);
  }
});

test('members and password-change sessions see waiting and sign-out without update tasks', async t => {
  for (const session of [{ ...account('MEMBER'), user: { ...account('MEMBER').user, role: 'member' } },
    { ...account('TEMP-ADMIN'), mustChangePassword: true }]) {
    const s = await gateSubject(t, { maintenance: true, initialSession: session });
    assert.equal(nodes(s.maintenanceTree()).some(node => node.type === 'system-update-panel'), false);
    assert.ok(nodes(s.maintenanceTree()).some(node => node.type === 'button'));
    assert.equal(s.appSession(), undefined);
    await s.render().props.onLogout(); await flushBackgroundAsync();
    assert.equal(s.render().props.session.authenticated, false);
    assert.equal(nodes(s.maintenanceTree()).some(node => node.type === 'system-update-panel'), false);
  }
});

test('anonymous maintenance has an explicit local login and returns to update management', async t => {
  const s = await gateSubject(t, { maintenance: true, initialSession: instanceState.normalizeSession(null) });
  assert.equal(nodes(s.maintenanceTree()).some(node => node.type === 'system-update-panel'), false);
  s.render().props.onLogin();
  const login = s.render(); assert.equal(login.type.name, 'LoginPage'); assert.equal(login.props.localOnly, true);
  login.props.onBack(); assert.equal(s.render().type.name, 'MaintenanceScreen');
  s.render().props.onLogin();
  const complete = s.render().props.onSuccess();
  s.sessionRequests.shift().resolve(account('NEW-ADMIN')); await complete;
  const panel = nodes(s.maintenanceTree()).find(node => node.type === 'system-update-panel');
  assert.equal(panel.props.session.user.accountId, 'NEW-ADMIN'); assert.equal(s.appSession(), undefined);
});

test('an unavailable raw-schema session remains waiting and cannot expose update tasks or the app', async t => {
  const s = await gateSubject(t);
  const refresh = s.refresh({ background: true });
  s.statusRequests.shift().resolve({ state: 'maintenance', reason: 'system_update_running', schemaVersion: null });
  await flushBackgroundAsync(); s.sessionRequests.shift().reject({ status: 503, code: 'maintenance' }); await refresh;
  const tree = s.maintenanceTree();
  assert.equal(s.render().props.sessionUnavailable, true);
  assert.equal(nodes(tree).some(node => node.type === 'system-update-panel' || node.type === 'button'), false);
  assert.equal(s.appSession(), undefined);
  const broken = s.refresh({ background: true });
  s.statusRequests.shift().resolve({ state: 'recovery_required', schemaVersion: null }); await broken;
  assert.equal(s.render().props.title, '实例需要维护'); assert.equal(s.sessionRequests.length, 0);
  assert.equal(s.appSession(), undefined);
});

test('completion leaves maintenance for the normal validated app or login entry', async t => {
  for (const initialSession of [account('OLD-A'), instanceState.normalizeSession(null)]) {
    const s = await gateSubject(t, { maintenance: true, initialSession });
    assert.equal(s.appSession(), undefined);
    const refresh = s.refresh({ background: true });
    s.statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
    s.sessionRequests.shift().resolve(initialSession); await refresh;
    s.render(); await flushBackgroundAsync();
    if (initialSession.authenticated) assert.equal(s.appSession().user.accountId, 'OLD-A');
    else assert.equal(s.render().type.name, 'LoginPage');
  }
});

test('a late background session response cannot replace a newer account or its image scope', async t => {
  const s = await gateSubject(t);
  s.dispatch(UPDATE_STATUS); s.statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
  const oldSession = s.sessionRequests.shift();
  s.dispatch(AUTH_UPDATED, account('NEW-B')); s.render(); await flushBackgroundAsync(); s.render();
  const boundary = s.scopes.length;
  oldSession.resolve(account('OLD-A')); await flushBackgroundAsync(); s.render();
  assert.equal(s.appSession().user.accountId, 'NEW-B');
  assert.equal(s.scopes.includes('NEW-B'), true);
  assert.equal(s.scopes.slice(boundary).includes('OLD-A'), false);
});

test('a revoked account stays signed out when an older background session finishes', async t => {
  const s = await gateSubject(t);
  s.dispatch(UPDATE_STATUS); s.statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
  const oldSession = s.sessionRequests.shift();
  s.dispatch(AUTH_INVALIDATED); s.render(); await flushBackgroundAsync();
  const boundary = s.scopes.length;
  oldSession.resolve(account('OLD-A')); await flushBackgroundAsync();
  assert.equal(s.render().type.name, 'LoginPage');
  assert.equal(s.appSession(), undefined);
  assert.equal(s.scopes.slice(boundary).includes('OLD-A'), false);
});

test('two refreshes resolving out of order retain the newest session', async t => {
  const s = await gateSubject(t);
  const first = s.refresh({ background: true });
  s.statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
  const oldSession = s.sessionRequests.shift();
  const second = s.refresh({ background: true });
  s.statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
  s.sessionRequests.shift().resolve(account('NEW-B')); await second;
  s.render(); await flushBackgroundAsync();
  const boundary = s.scopes.length;
  oldSession.resolve(account('OLD-A')); assert.equal(await first, null);
  assert.equal(s.appSession().user.accountId, 'NEW-B');
  assert.equal(s.scopes.slice(boundary).includes('OLD-A'), false);
});

test('a stale status response cannot enter maintenance or request another account session', async t => {
  const s = await gateSubject(t);
  const first = s.refresh({ background: true }), oldStatus = s.statusRequests.shift();
  const second = s.refresh({ background: true });
  s.statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
  s.sessionRequests.shift().resolve(account('NEW-B')); await second;
  s.render(); await flushBackgroundAsync();
  oldStatus.resolve({ state: 'maintenance', reason: 'system_update_running' }); assert.equal(await first, null);
  assert.equal(s.appSession().user.accountId, 'NEW-B'); assert.equal(s.sessionRequests.length, 0);
});

test('stale foreground rejection and finally cannot overwrite or finish a newer refresh', async t => {
  const s = await gateSubject(t);
  const first = s.refresh(), oldStatus = s.statusRequests.shift();
  const second = s.refresh();
  oldStatus.reject(Error('old request offline')); assert.equal(await first, null);
  assert.equal(s.render().props.title, '正在连接');
  s.statusRequests.shift().resolve({ state: 'ready' }); await flushBackgroundAsync();
  s.sessionRequests.shift().resolve(account('NEW-B')); await second;
  s.render(); await flushBackgroundAsync();
  assert.equal(s.appSession().user.accountId, 'NEW-B');
});

test('account change invalidates pending status before it can open another maintenance page', async t => {
  const s = await gateSubject(t);
  const refresh = s.refresh({ background: true }), oldStatus = s.statusRequests.shift();
  s.dispatch(AUTH_UPDATED, account('NEW-B')); s.render(); await flushBackgroundAsync();
  const boundary = s.scopes.length;
  oldStatus.resolve({ state: 'maintenance', reason: 'system_update_running' }); assert.equal(await refresh, null);
  assert.equal(s.appSession().user.accountId, 'NEW-B');
  assert.equal(s.scopes.slice(boundary).includes(null), false);
});

for (const authEvent of [AUTH_UPDATED, AUTH_INVALIDATED, AUTH_CHECK_FAILED]) {
  test(`${authEvent} finishes superseded foreground loading without accepting its late result`, async t => {
    const s = await gateSubject(t);
    const refresh = s.refresh(), oldStatus = s.statusRequests.shift();
    assert.equal(s.render().props.title, '正在连接');
    s.dispatch(authEvent, account('NEW-B')); s.render(); await flushBackgroundAsync();
    if (authEvent === AUTH_UPDATED) {
      assert.equal(s.appSession().user.accountId, 'NEW-B');
      oldStatus.resolve({ state: 'maintenance', reason: 'system_update_running' });
    } else if (authEvent === AUTH_INVALIDATED) {
      assert.equal(s.render().type.name, 'LoginPage');
      oldStatus.reject(Error('superseded request'));
    } else {
      assert.equal(s.render().props.title, '暂时无法连接');
      oldStatus.resolve({ state: 'ready' });
    }
    const boundary = s.scopes.length;
    assert.equal(await refresh, null);
    if (authEvent === AUTH_UPDATED) assert.equal(s.appSession().user.accountId, 'NEW-B');
    else if (authEvent === AUTH_INVALIDATED) assert.equal(s.render().type.name, 'LoginPage');
    else assert.equal(s.render().props.title, '暂时无法连接');
    assert.equal(s.sessionRequests.length, 0);
    assert.equal(s.scopes.length, boundary);
  });
}
