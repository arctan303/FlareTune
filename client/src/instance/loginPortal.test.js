import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHELL_THEME } from '../constants/shellThemes.js';
import { applyInstanceTheme, resolveInstanceDarkMode } from './theme.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const gate = read('./InstanceGate.jsx');
const css = read('./instance.css');
const login = gate.slice(gate.indexOf('function LoginPage'), gate.indexOf('function ChangePasswordPage'));

const createRoot = () => {
  const props = new Map();
  const classes = new Set();
  return {
    props,
    classes,
    dataset: {},
    style: { colorScheme: '', setProperty: (name, value) => props.set(name, value) },
    classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
  };
};

test('the gate applies the full shell tokens so login matches the app in both appearances', () => {
  const light = createRoot();
  applyInstanceTheme(false, light);
  assert.equal(light.classes.has('dark'), false);
  assert.equal(light.style.colorScheme, 'light');
  assert.equal(light.dataset.shellTheme, SHELL_THEME.id);
  assert.equal(light.props.get('--page'), SHELL_THEME.modes.light.page);
  assert.equal(light.props.get('--ink'), SHELL_THEME.modes.light.ink);

  const dark = createRoot();
  applyInstanceTheme(true, dark);
  assert.equal(dark.classes.has('dark'), true);
  assert.equal(dark.props.get('--page'), SHELL_THEME.modes.dark.page);

  assert.match(gate, /useInstanceTheme\(\)/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
});

test('the login appearance follows the stored preference and otherwise the system', () => {
  const store = (value) => ({ getItem: () => (value ? JSON.stringify({ value }) : null), removeItem: () => {} });
  assert.equal(resolveInstanceDarkMode(store('dark'), { matches: false }), true);
  assert.equal(resolveInstanceDarkMode(store('light'), { matches: true }), false);
  assert.equal(resolveInstanceDarkMode(store('system'), { matches: true }), true);
  assert.equal(resolveInstanceDarkMode(store(null), { matches: false }), false);
});

test('the other gate pages retain the product content-page grammar', () => {
  assert.doesNotMatch(gate, /\.jpg|\.png|assets\//);
  assert.match(gate, /<TuneWordmark className="instance-wordmark" \/>/);
  assert.match(gate, /className="instance-portal"/);
  assert.match(gate, /className="instance-portal__body"/);
  assert.match(css, /\.instance-page \{[\s\S]*background:[\s\S]*radial-gradient\(120% 80% at 6% -12%, color-mix\(in srgb, var\(--accent[\s\S]*var\(--page, #ffffff\)/);
  assert.match(css, /\.instance-portal \{[\s\S]*max-width: 460px/);
  assert.match(css, /\.instance-wordmark\.tune-wordmark \{[\s\S]*font-size: 22px/);
  assert.match(css, /\.instance-portal h1 \{[\s\S]*font-size: clamp\(34px, 4vw, 46px\)/);
  // 没有卡片、玻璃或独立配色层
  assert.doesNotMatch(css, /instance-card|instance-visual|instance-aura|backdrop-filter|border-radius: 999px/);
});

test('shared fields retain hairline and focus states while login stacks labels above inputs', () => {
  assert.match(css, /\.instance-field \{[\s\S]*grid-template-columns: 82px minmax\(0, 1fr\)[\s\S]*border-bottom: 1px solid var\(--line/);
  assert.match(css, /\.instance-field::after \{[\s\S]*transform: scaleX\(0\)[\s\S]*transition: transform 200ms/);
  assert.match(css, /\.instance-field:focus-within::after \{ transform: scaleX\(1\); \}/);
  assert.match(css, /\.instance-field:focus-within > label \{ color: var\(--accent-strong/);
  assert.match(css, /\.instance-field\[data-invalid='true'\]::after \{ background: var\(--danger/);
  assert.match(css, /\.instance-field input \{[\s\S]*min-height: 34px[\s\S]*background: transparent[\s\S]*font-size: 16px/);
  assert.match(css, /\.instance-hint,\n\.instance-field-status \{ grid-column: 2; \}/);
  assert.match(css, /\.instance-page--login \.instance-field \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.instance-page--login \.instance-field > label \{ grid-column: 1; grid-row: auto/);
  assert.match(css, /\.instance-page--login \.instance-field input \{ min-height: 46px;[\s\S]*font-size: 18px/);
});

test('login uses an open split layout without a form card, image, or new entry', () => {
  assert.match(login, /<main className="instance-page instance-page--login">/);
  assert.match(login, /className="instance-login__identity"[\s\S]*<TuneWordmark className="instance-wordmark" \/>[\s\S]*id="instance-title"/);
  assert.match(login, /<h1 id="instance-title">欢迎回来<\/h1>/);
  assert.match(login, /className="instance-login__access"[\s\S]*id="instance-login-title"/);
  assert.match(css, /\.instance-login \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(340px, 420px\)/);
  assert.match(css, /\.instance-login__headline \{ margin-block: auto; \}/);
  assert.doesNotMatch(css, /\.instance-login__identity \{[^}]*justify-content: space-between/);
  assert.match(css, /\.instance-page--login::before \{[\s\S]*background: var\(--surface/);
  assert.match(css, /\.instance-page--login \*,[\s\S]*box-sizing: border-box/);
  assert.match(css, /html\.dark \.instance-page--login \.instance-primary \{ color: var\(--page/);
  assert.doesNotMatch(login, /<Page|instance-portal|登录后继续聆听/);
  assert.doesNotMatch(css, /\.instance-page--login[^{}]*\{[^{}]*backdrop-filter/);
  assert.match(login, /id="login-username" label="用户名" autoComplete="username"/);
  assert.match(login, /id="login-password" label="密码" type="password" autoComplete="current-password"/);
  assert.match(login, /className="instance-primary" type="submit"/);
  assert.doesNotMatch(login, /恢复管理员访问|onRecovery/);
  assert.doesNotMatch(login, /注册|忘记密码|找回|OAuth|邮箱|第三方登录|访客|关于/);
});

test('login feedback, busy and keyboard states keep their accessible contracts', () => {
  assert.match(gate, /function StatusMessage\(\{ error, errorRef \}\)[\s\S]*className="instance-error" role="alert" tabIndex=\{-1\} ref=\{errorRef\}/);
  assert.match(login, /setError\(messageForError\(cause, 'login'\)\)/);
  assert.match(login, /queueMicrotask\(\(\) => errorRef\.current\?\.focus\(\)\)/);
  assert.match(login, /setCredentialError\(!\[429, 503, 0\]\.includes\(cause\?\.status\)\)/);
  assert.match(login, /invalid=\{credentialError\}/);
  assert.match(gate, /aria-invalid=\{invalid \|\| undefined\}/);
  assert.match(login, /readOnly=\{busy\}/);
  assert.match(login, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(login, /busyRef\.current\) return;/);
  assert.match(login, /大写锁定已开启/);
  assert.match(gate, /role="status">\{status\}<\/p>/);
});

test('the password reveal is an accessible 44px icon control', () => {
  assert.match(gate, /className="instance-reveal"[\s\S]{0,120}aria-pressed=\{visible\}/);
  assert.match(gate, /aria-label=\{`\$\{visible \? '隐藏' : '显示'\}\$\{label\}`\}/);
  assert.match(gate, /<EyeOff size=\{17\}/);
  assert.match(css, /\.instance-reveal \{[\s\S]*width: 44px;[\s\S]*height: 44px/);
  assert.match(css, /\.instance-reveal:hover \{ color: var\(--ink[^}]*var\(--hover-tint/);
});

test('the primary action and error block reuse the shared accent and radius tokens', () => {
  assert.match(css, /\.instance-primary,\s*\.instance-secondary \{[\s\S]*border-radius: var\(--radius-control/);
  assert.match(css, /\.instance-primary \{[\s\S]*margin-top: 26px[\s\S]*background: var\(--accent/);
  assert.match(css, /\.instance-primary:hover:not\(:disabled\) \{[\s\S]*background: var\(--accent-strong/);
  assert.match(css, /\.instance-error \{[\s\S]*border-radius: var\(--radius-control[\s\S]*animation: instance-error-enter 200ms/);
  assert.match(css, /\.instance-primary:focus-visible,[\s\S]*outline: 3px solid var\(--accent/);
});

test('the portal degrades on phone widths and honours reduced motion', () => {
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.instance-login \{[\s\S]*display: block/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*safe-area-inset-bottom/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.instance-login__identity \{[\s\S]*min-height: clamp\(220px, 33svh, 320px\)/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*font-size: clamp\(30px, 9vw, 38px\)/);
  assert.match(css, /@media \(max-width: 400px\)[\s\S]*grid-template-columns: 68px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: \.01ms !important/);
});
