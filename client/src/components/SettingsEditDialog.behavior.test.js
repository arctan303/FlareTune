import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler } from '../test/fullscreenBackgroundHarness.js';

function dialogHarness() {
  const scheduler = createBackgroundScheduler();
  let closes = 0;
  let restoredFocus = 0;
  const opener = { isConnected: true, focus: () => restoredFocus++ };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; },
    querySelector: () => ({ focus() {} }) };
  const harness = createBackgroundModuleHarness({
    file: new URL('./SettingsEditDialog.jsx', import.meta.url),
    modules: {
      'react-dom': { createPortal: element => element },
      '../i18n/index.js': { t: text => text },
      './SettingsControls.jsx': { SettingsButton: 'button', SettingsDialogContext: { Provider: 'provider' } },
    },
    globals: {
      document: { activeElement: opener, body: {}, querySelector: () => dialog.open ? dialog : null },
      window: { matchMedia: () => ({ matches: false }) },
      setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
    },
    nodes: { dialog },
  });
  const props = { title: 'Settings', onClose: () => closes++, children: null, busy: false };
  return { scheduler, props, render: overrides => harness.render({ ...props, ...overrides }).props.children[0],
    unmount: harness.unmount, closes: () => closes, restoredFocus: () => restoredFocus };
}

test('closing a settings dialog blocks immediate submission before and after the closing render', () => {
  const harness = dialogHarness();
  let dialog = harness.render();
  dialog.props.onCancel({ preventDefault() {} });
  for (let render = 0; render < 2; render++) {
    let prevented = false;
    let stopped = false;
    dialog.props.onSubmitCapture({ preventDefault: () => prevented = true, stopPropagation: () => stopped = true });
    assert.equal(prevented && stopped, true, 'a form cannot start saving during the close transition');
    dialog = harness.render();
    assert.equal(dialog.props.inert, '');
  }
  harness.scheduler.expire(150);
  assert.equal(harness.closes(), 1);
  harness.unmount();
  assert.equal(harness.restoredFocus(), 1);
});

test('a busy update cancels a pending close and restores an interactive visible dialog', () => {
  const harness = dialogHarness();
  const dialog = harness.render();
  dialog.props.onCancel({ preventDefault() {} });
  const busy = harness.render({ busy: true });
  assert.equal(busy.props['data-closing'], undefined);
  assert.equal(busy.props.inert, undefined);
  assert.equal(harness.scheduler.timeouts.size, 0);
  harness.scheduler.expire(150);
  assert.equal(harness.closes(), 0);
  harness.render({ busy: false }).props.onCancel({ preventDefault() {} });
  harness.scheduler.expire(150);
  assert.equal(harness.closes(), 1, 'close remains available after the save settles');
  harness.unmount();
});

test('unmount clears a settings close transition without a late parent callback', () => {
  const harness = dialogHarness();
  harness.render().props.onCancel({ preventDefault() {} });
  harness.unmount();
  assert.equal(harness.scheduler.timeouts.size, 0);
  harness.scheduler.expire(150);
  assert.equal(harness.closes(), 0);
});
