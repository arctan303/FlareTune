import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object'
  ? [tree, ...[tree.props?.children, tree.props?.action].flat(Infinity).flatMap(nodes)] : [];
const text = tree => typeof tree === 'string' ? tree
  : [tree?.props?.children].flat(Infinity).filter(value => value !== undefined).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const form = tree => nodes(tree).find(node => node.type === 'form');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const modelData = () => ({ revision: 12, updateRequired: false,
  value: { schemaVersion: 1, selection: { providerId: 'provider-a', model: 'saved-model', supportsImages: true,
    generationOptions: { temperature: 0.6 } } },
  providers: [{ id: 'provider-a', name: 'Configured provider', revision: 31, hasKey: true }] });

function modelFixture(request) {
  const calls = [], notices = [];
  const host = { isCurrent: () => true, notify: value => notices.push(value),
    request: async (path, options) => { calls.push({ path, options }); return request(path, options); } };
  const view = createBackgroundModuleHarness({ file: new URL('./ServiceModelSettings.jsx', import.meta.url),
    modules: { '../i18n/index.js': { t: value => value, useLocale: () => 'en' },
      './SettingsSection.jsx': 'section', './SettingsEditDialog.jsx': 'dialog', './SettingsSkeleton.jsx': 'skeleton',
      './SelectControl.jsx': 'select',
      './SettingsControls.jsx': { SettingsActions: 'actions', SettingsButton: 'button', SettingsToggle: 'toggle' },
      './SettingsReadOnly.jsx': { SettingsInput: 'input', useSettingsReadOnly: () => false } }, globals: {} });
  return { ...view, calls, notices, renderSettings: () => view.render({ host }) };
}

test('model settings show loading before a failed read, then recover through the local retry', async () => {
  const first = deferred(), retry = deferred(); let reads = 0;
  const f = modelFixture(() => ++reads === 1 ? first.promise : retry.promise);
  let tree = f.renderSettings();
  assert.ok(nodes(tree).some(node => node.type === 'skeleton'));
  assert.equal(button(tree, '重试'), undefined, 'a normal in-flight read is not presented as a failure');
  first.reject(Object.assign(new Error('unavailable'), { status: 503 })); await flushBackgroundAsync();
  tree = f.renderSettings();
  assert.ok(nodes(tree).some(node => node.props.role === 'alert'));
  assert.ok(button(tree, '重试'));
  assert.ok(!nodes(tree).some(node => node.type === 'skeleton'));
  button(tree, '重试').props.onClick(); tree = f.renderSettings();
  assert.ok(nodes(tree).some(node => node.type === 'skeleton'));
  retry.resolve(modelData()); await flushBackgroundAsync(); tree = f.renderSettings();
  assert.ok(text(tree).includes('saved-model'));
  assert.equal(button(tree, '重试'), undefined);
  assert.ok(!nodes(tree).some(node => node.props.role === 'alert'));
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => !call.options.method)); f.unmount();
});

test('cancelling a model draft makes no write and reopening restores the saved values', async () => {
  const f = modelFixture(async () => modelData()); f.renderSettings(); await flushBackgroundAsync();
  button(f.renderSettings(), '配置方案').props.onClick(); let tree = f.renderSettings();
  nodes(tree).find(node => node.type === 'input' && node.props.id === 'service-model-id')
    .props.onChange({ target: { value: 'discard-this-model' } });
  tree = f.renderSettings();
  nodes(tree).find(node => node.type === 'input' && node.props.type === 'number')
    .props.onChange({ target: { value: '1.3' } });
  button(f.renderSettings(), '取消').props.onClick(); tree = f.renderSettings();
  assert.ok(!nodes(tree).some(node => node.type === 'dialog'));
  assert.equal(f.calls.length, 1);
  button(tree, '配置方案').props.onClick(); tree = f.renderSettings();
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.id === 'service-model-id').props.value, 'saved-model');
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.type === 'number').props.value, 0.6);
  assert.equal(nodes(tree).find(node => node.type === 'toggle').props.checked, true); f.unmount();
});

test('a failed model save keeps the draft and the retry uses its original setting and provider revisions', async () => {
  let writes = 0;
  const f = modelFixture(async (_path, options) => {
    if (options.method !== 'PUT') return modelData();
    if (++writes === 1) throw Object.assign(new Error('conflict'), { status: 409 });
    return { ...modelData(), revision: 13, value: { schemaVersion: 1, selection: {
      providerId: options.body.providerId, model: options.body.model, supportsImages: options.body.supportsImages,
      generationOptions: options.body.generationOptions } } };
  });
  f.renderSettings(); await flushBackgroundAsync(); button(f.renderSettings(), '配置方案').props.onClick();
  nodes(f.renderSettings()).find(node => node.type === 'input' && node.props.id === 'service-model-id')
    .props.onChange({ target: { value: 'replacement-model' } });
  await form(f.renderSettings()).props.onSubmit({ preventDefault() {} }); let tree = f.renderSettings();
  assert.ok(nodes(tree).find(node => node.type === 'dialog').props.message);
  assert.equal(nodes(tree).find(node => node.type === 'input' && node.props.id === 'service-model-id').props.value, 'replacement-model');
  assert.deepEqual(f.notices, []);
  await form(tree).props.onSubmit({ preventDefault() {} }); tree = f.renderSettings();
  assert.ok(!nodes(tree).some(node => node.type === 'dialog'));
  assert.ok(text(tree).includes('replacement-model'));
  const saved = f.calls.filter(call => call.options.method === 'PUT'); assert.equal(saved.length, 2);
  for (const call of saved) {
    assert.equal(call.path, 'model'); assert.equal(call.options.admin, true);
    assert.equal(call.options.body.expectedRevision, 12); assert.equal(call.options.body.providerRevision, 31);
    assert.equal(call.options.body.model, 'replacement-model'); assert.equal(call.options.body.supportsImages, false);
    assert.equal(call.options.body.generationOptions.temperature, 0.6);
  }
  assert.equal(f.notices.length, 1); f.unmount();
});

function accountFixture(request) {
  const calls = [], messages = [], saved = [];
  let busy = false;
  const props = { account: { accountId: 'member-a', username: 'alex', displayName: 'Saved name', role: 'member', status: 'active', updatedAt: 49 },
    csrfToken: 'fixture-csrf', onSaved: value => saved.push(value), onMessage: value => messages.push(value),
    setBusy: value => { busy = value; } };
  class FixtureFormData { constructor(value) { this.value = value; } get(name) { return this.value[name]; } }
  const view = createBackgroundModuleHarness({ file: new URL('./AdminAccountRow.jsx', import.meta.url), modules: {
    '../i18n/index.js': { t: (key, values = {}) => key.replace(/\{([^}]+)\}/g, (_, name) => values[name] ?? name) },
    'lucide-react': {}, './SettingsReadOnly.jsx': { SettingsInput: 'input', SettingsWriteButton: 'button' },
    './SettingsControls.jsx': { SettingsActions: 'actions', SettingsButton: 'button' }, './SelectControl.jsx': 'select',
    './AdminSettingsFields.jsx': { Field: 'field', inputClass: 'input', buttonClass: 'primary' },
    './api.js': { instanceRequest: async (path, options) => { calls.push({ path, options }); return request(path, options); } },
  }, globals: { FormData: FixtureFormData, TextEncoder } });
  return { ...view, calls, messages, saved, renderRow: () => view.render({ ...props, busy }) };
}

test('account editing keeps a failed change and its error in the affected row, then retains the concurrency contract on retry', async () => {
  let writes = 0;
  const f = accountFixture(async (_path, options) => {
    if (++writes === 1) throw Object.assign(new Error('conflict'), { status: 409 });
    return { account: { accountId: 'member-a', ...options.body, updatedAt: 50 } };
  });
  button(f.renderRow(), '编辑').props.onClick(); let tree = f.renderRow();
  nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: 'Edited name' } });
  await form(f.renderRow()).props.onSubmit({ preventDefault() {} }); tree = f.renderRow();
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && text(node).includes('内容已被其他会话更改')));
  assert.equal(nodes(tree).find(node => node.type === 'input').props.value, 'Edited name');
  assert.ok(f.messages.every(value => value === ''), 'the actionable error is not only sent to the page header');
  await form(tree).props.onSubmit({ preventDefault() {} }); tree = f.renderRow();
  assert.ok(!nodes(tree).some(node => node.props.role === 'alert'));
  assert.equal(form(tree), undefined); assert.equal(f.saved.length, 1);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.path, 'admin/accounts/member-a'); assert.equal(call.options.method, 'PATCH');
    assert.equal(call.options.csrfToken, 'fixture-csrf'); assert.equal(call.options.body.expectedUpdatedAt, 49);
    assert.equal(call.options.body.displayName, 'Edited name'); assert.equal(call.options.body.role, 'member'); assert.equal(call.options.body.status, 'active');
  }
  f.unmount();
});

test('a failed password reset stays in the same row and does not claim success or clear the form', async () => {
  const f = accountFixture(async () => { throw Object.assign(new Error('bad input'), { status: 400 }); });
  button(f.renderRow(), '重置密码').props.onClick(); let tree = f.renderRow();
  assert.ok(text(tree).includes('重置将退出该账号的所有会话'));
  let cleared = false;
  await form(tree).props.onSubmit({ preventDefault() {}, currentTarget: { temporaryPassword: 'valid-password', reset() { cleared = true; } } });
  tree = f.renderRow();
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && text(node).includes('输入不符合要求')));
  assert.ok(form(tree)); assert.equal(cleared, false); assert.equal(f.saved.length, 0);
  assert.ok(f.messages.every(value => value === ''));
  assert.equal(f.calls[0].path, 'admin/accounts/member-a/reset-password');
  assert.equal(f.calls[0].options.method, 'POST'); assert.equal(f.calls[0].options.csrfToken, 'fixture-csrf');
  assert.equal(f.calls[0].options.body.temporaryPassword, 'valid-password'); f.unmount();
});

function catalogFixture(request) {
  const calls = [], file = new URL('./AdminCatalogSection.jsx', import.meta.url);
  const originalRead = fs.readFileSync;
  // The existing deterministic hook harness predates useId. Only replace that
  // React-generated identifier during in-memory compilation; no product state,
  // requests, branches or working files are substituted.
  fs.readFileSync = function (target, ...options) {
    const source = originalRead.call(this, target, ...options);
    if (String(target) !== file.href) return source;
    assert.equal(typeof source, 'string');
    assert.ok(source.split('React.useId()').length <= 2);
    return source.replace('React.useId()', "'fixture-catalog-editor'");
  };
  syncBuiltinESMExports();
  let view;
  try {
    view = createBackgroundModuleHarness({ file, modules: {
      '../i18n/index.js': { t: value => value }, 'lucide-react': {}, 'react-dom': { createPortal: value => value },
      './SettingsReadOnly.jsx': { SettingsInput: 'input', SettingsWriteButton: 'button' },
      './SettingsControls.jsx': { SettingsActions: 'actions', SettingsButton: 'button' },
      './SelectControl.jsx': 'select', './SettingsEditDialog.jsx': 'dialog', './SettingsSkeleton.jsx': 'skeleton',
      './PrivateCoverImage.jsx': 'image', '../constants/language.js': { ALL_LANGUAGES: [], getLanguageLabel: value => value },
      '../utils.js': { resolveCoverUrl: () => null, formatDuration: value => String(value) },
      '../services/catalogAdminApi.js': { listCatalogSongs: async options => { calls.push(options); return request(options); } },
    }, globals: {} });
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  return { ...view, calls, renderCatalog: () => view.render() };
}

test('catalog refresh retains usable rows during waiting and failure and retries without losing the query', async () => {
  const refresh = deferred(); let reads = 0;
  const f = catalogFixture(async () => ++reads === 1
    ? { songs: [{ id: 'cached-song', title: 'Cached song', artist: 'Artist' }], total: 1, limit: 30 }
    : reads === 2 ? refresh.promise : { songs: [{ id: 'new-song', title: 'Updated song' }], total: 1, limit: 30 });
  let tree = f.renderCatalog();
  await flushBackgroundAsync(); tree = f.renderCatalog(); assert.ok(text(tree).includes('Cached song'));
  nodes(tree).find(node => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value: 'title filter' } });
  tree = f.renderCatalog(); form(tree).props.onSubmit({ preventDefault() {} }); tree = f.renderCatalog();
  assert.ok(text(tree).includes('Cached song')); assert.ok(!nodes(tree).some(node => node.type === 'skeleton'));
  assert.ok(nodes(tree).some(node => node.props.role === 'status'));
  refresh.reject(new Error('catalog temporarily unavailable')); await flushBackgroundAsync(); tree = f.renderCatalog();
  assert.ok(text(tree).includes('Cached song'));
  const alert = nodes(tree).find(node => node.props.role === 'alert'); assert.ok(text(alert).includes('catalog temporarily unavailable'));
  assert.ok(!text(tree).includes('暂无符合条件的歌曲'));
  button(alert, '重试').props.onClick(); await flushBackgroundAsync(); tree = f.renderCatalog();
  assert.ok(text(tree).includes('Updated song')); assert.ok(!text(tree).includes('Cached song'));
  assert.ok(!nodes(tree).some(node => node.props.role === 'alert'));
  assert.equal(f.calls.length, 3); assert.equal(f.calls[1].q, 'title filter'); assert.equal(f.calls[2].q, 'title filter'); f.unmount();
});

test('a first catalog read failure offers local recovery without claiming a zero-result search', async () => {
  let reads = 0;
  const f = catalogFixture(async () => { if (++reads === 1) throw new Error('first read failed');
    return { songs: [{ id: 'recovered', title: 'Recovered song' }], total: 1, limit: 30 }; });
  f.renderCatalog(); await flushBackgroundAsync(); let tree = f.renderCatalog();
  assert.ok(!text(tree).includes('暂无符合条件的歌曲'));
  const alert = nodes(tree).find(node => node.props.role === 'alert'); assert.ok(text(alert).includes('first read failed'));
  button(alert, '重试').props.onClick(); await flushBackgroundAsync(); tree = f.renderCatalog();
  assert.ok(text(tree).includes('Recovered song')); assert.equal(f.calls.length, 2); f.unmount();
});
