import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';
import { serviceModelMessages, changeServiceModel, serviceModelDraft } from './serviceModelSettings.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.children, tree.props?.action].flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : [node?.props?.children].flat(Infinity).map(child => child === undefined ? '' : text(child)).join('');
const selected = { schemaVersion: 1, selection: { providerId: 'p', model: 'vision', supportsImages: true,
  providerBinding: 'connection', generationOptions: { temperature: 0.7 } } };
const configured = () => ({ value: structuredClone(selected), revision: 4, providers: [{ id: 'p', name: 'Provider', revision: 7, hasKey: true }], updateRequired: false, configured: true });
function subject({ initial = configured(), locale = 'en', readOnly = false, request } = {}) {
  let live = true; const calls = [];
  const host = { isCurrent: () => live, notify() {}, async request(path, options) { calls.push({ path, options });
    if (request) return request(path, options);
    if (path === 'model/initialize') return configured();
    return initial; } };
  const harness = createBackgroundModuleHarness({ file: new URL('./ServiceModelSettings.jsx', import.meta.url), modules: {
    '../i18n/index.js': { t: value => value, useLocale: () => locale },
    './SettingsSection.jsx': 'section', './SettingsEditDialog.jsx': 'dialog', './SelectControl.jsx': 'select',
    './SettingsControls.jsx': { SettingsActions: 'actions', SettingsButton: 'button', SettingsToggle: 'toggle' },
    './SettingsReadOnly.jsx': { SettingsInput: 'input', useSettingsReadOnly: () => readOnly },
  }, globals: {} });
  return { ...harness, calls, view: () => harness.render({ host }), retire: () => { live = false; } };
}
const button = (view, label) => nodes(view).find(node => node.type === 'button' && text(node) === label);

test('all five locales explain initialization and GET never starts it', async () => {
  for (const locale of Object.keys(serviceModelMessages)) {
    const s = subject({ locale, initial: { ...configured(), value: null, revision: 0, updateRequired: true, configured: false } });
    s.view(); await flushBackgroundAsync(); const view = s.view();
    assert.ok(text(view).includes(serviceModelMessages[locale].update));
    assert.deepEqual(s.calls.map(call => call.path), ['model']);
    await button(view, serviceModelMessages[locale].initialize).props.onClick();
    assert.equal(s.calls[1].path, 'model/initialize'); assert.equal(s.calls[1].options.method, 'POST');
    assert.deepEqual(structuredClone(s.calls[1].options.body), { expectedRevision: 0 }); s.unmount();
  }
});
test('model/provider edits clear vision while explicit save uses the captured revision', async () => {
  const s = subject(); s.view(); await flushBackgroundAsync();
  button(s.view(), '配置方案').props.onClick();
  let view = s.view();
  nodes(view).find(node => node.type === 'input' && node.props.id === 'service-model-id').props.onChange({ target: { value: 'new-model' } });
  view = s.view(); assert.equal(nodes(view).find(node => node.type === 'toggle').props.checked, false);
  assert.equal(s.calls.length, 1);
  await nodes(view).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const saved = s.calls.at(-1); assert.equal(saved.path, 'model'); assert.equal(saved.options.method, 'PUT');
  assert.equal(saved.options.body.expectedRevision, 4); assert.equal(saved.options.body.providerRevision, 7);
  assert.equal(saved.options.body.supportsImages, false); assert.equal(saved.options.body.model, 'new-model');
  assert.equal(saved.options.body.generationOptions.temperature, 0.7); s.unmount();
  const draft = serviceModelDraft(selected);
  assert.equal(changeServiceModel(draft, 'model', 'vision').supportsImages, true);
  assert.equal(changeServiceModel(draft, 'providerId', 'other').supportsImages, false);
});
test('late model lists are discarded after changing the provider and retired hosts cannot save', async () => {
  let resolveModels;
  const s = subject({ request: path => path === 'model/models' ? new Promise(resolve => { resolveModels = resolve; }) : configured() });
  s.view(); await flushBackgroundAsync(); button(s.view(), '配置方案').props.onClick();
  const loading = button(s.view(), '获取模型').props.onClick();
  nodes(s.view()).find(node => node.type === 'select' && node.props['aria-label'] === '供应商').props.onChange({ target: { value: '' } });
  resolveModels({ models: ['stale'], hasMore: false }); await loading; await flushBackgroundAsync();
  assert.equal(nodes(s.view()).some(node => node.type === 'option' && text(node) === 'stale'), false);
  s.retire(); await nodes(s.view()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(s.calls.length, 2); s.unmount();
});
test('read-only mode disables initialization and editing without making writes', async () => {
  const s = subject({ readOnly: true }); s.view(); await flushBackgroundAsync();
  assert.equal(button(s.view(), '配置方案').props.disabled, true);
  button(s.view(), '配置方案').props.onClick(); assert.equal(nodes(s.view()).some(node => node.type === 'dialog'), false);
  assert.equal(s.calls.length, 1); s.unmount();
});
test('blank temperature describes the system default and duplicate submits make one CAS write', async () => {
  for (const labels of Object.values(serviceModelMessages)) assert.ok(labels.temperature.includes('0.2'));
  let finish;
  const s = subject({ request: (path, options) => options.method === 'PUT'
    ? new Promise(resolve => { finish = resolve; }) : configured() });
  s.view(); await flushBackgroundAsync(); button(s.view(), '配置方案').props.onClick();
  let view = s.view();
  nodes(view).find(node => node.type === 'input' && node.props.type === 'number').props.onChange({ target: { value: '' } });
  view = s.view(); const submit = nodes(view).find(node => node.type === 'form').props.onSubmit;
  const first = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
  assert.equal(s.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.equal(Object.hasOwn(s.calls.at(-1).options.body.generationOptions, 'temperature'), false);
  finish(configured()); await first; s.unmount();
});
