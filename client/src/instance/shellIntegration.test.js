import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSession, toShellAuthSession } from './state.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('normal local session is the sole bridge into the business shell', () => {
  const user = { accountId: 'local-admin', username: 'owner', displayName: 'Owner', role: 'admin' };
  const session = normalizeSession({ authenticated: true, user, csrfToken: 'csrf-token' });
  assert.equal(toShellAuthSession(session).user.accountId, 'local-admin');
  assert.equal(toShellAuthSession(session).csrfToken, 'csrf-token');
  const gate = read('./InstanceGate.jsx');
  const app = read('../app.jsx');
  assert.match(gate, /current === 'app'[\s\S]*<App validatedSession=\{session\}/);
  assert.match(gate, /import\('\.\.\/store\/useUIStore\.js'\)[\s\S]*setAuthSession\(toShellAuthSession\(session\)\)/);
  assert.match(app, /function App\(\{ validatedSession \}\)/);
  assert.doesNotMatch(app, /AuthGateView|clearPlaylist\(\)|readPendingAuthTarget|clearPendingAuthTarget/);
});

test('account row revalidates local session while account settings signs out with CSRF', () => {
  const menu = read('../components/AccountMenu.jsx');
  const accountSettings = read('../components/AccountSettings.jsx');
  const gate = read('./InstanceGate.jsx');
  const fetch = read('../services/authenticatedFetch.js');
  const navigation = read('../authNavigation.js');
  assert.match(menu, /getSession\(\)/);
  assert.match(accountSettings, /logout\(authSession\.csrfToken\)/);
  assert.doesNotMatch(menu, /api\/ai\/auth|auth\/start|sso_attempted|yifang_error|sessionStorage/);
  assert.match(fetch, /notifyAuthenticationRequired\(response\)/);
  assert.match(navigation, /response\?\.status !== 401/);
  assert.match(gate, /AUTH_SESSION_INVALIDATED_EVENT[\s\S]*setSession\(normalizeSession\(null\)\)/);
  assert.doesNotMatch(gate, /clearPlaylist\(\)/);
});

test('maintenance and broken instance screens do not offer setup-secret recovery', () => {
  const gate = read('./InstanceGate.jsx');
  assert.match(gate, /current === 'maintenance'[\s\S]*请联系部署者检查实例/);
  assert.match(gate, /current === 'instance_error'[\s\S]*实例需要维护/);
  assert.doesNotMatch(gate, /RecoveryPage|onRecovery|auth\/recovery|使用初始化密钥续接/);
});
