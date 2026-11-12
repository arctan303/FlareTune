import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler } from '../test/fullscreenBackgroundHarness.js';

test('custom modal traps both Tab boundaries, handles Escape and restores its opener', () => {
  const scheduler = createBackgroundScheduler();
  const listeners = new Set();
  const doc = { activeElement: null, modals: [], querySelectorAll() { return this.modals; },
    addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) };
  const focusable = name => ({ name, isConnected: true, tabIndex: 0, hasAttribute: () => false,
    getAttribute: () => null, getClientRects: () => [1], focus() { doc.activeElement = this; } });
  const opener = focusable('opener'), first = focusable('first'), last = focusable('last');
  const modal = { getAttribute: () => null, getClientRects: () => [1], querySelectorAll: () => [first, last],
    querySelector: () => first, contains: element => [first, last].includes(element) };
  doc.modals = [modal]; doc.activeElement = opener;
  let closes = 0;
  const harness = createBackgroundModuleHarness({ file: new URL('./useModalFocus.js', import.meta.url), exportName: 'useModalFocus',
    modules: {}, globals: { document: doc, ...scheduler } });
  const props = { active: true, modalRef: { current: modal }, onClose: () => closes++ };
  harness.render(props); scheduler.frame(); assert.equal(doc.activeElement, first);
  const press = (key, shiftKey = false) => {
    let prevented = false;
    for (const listener of listeners) listener({ key, shiftKey, preventDefault: () => prevented = true, stopPropagation() {} });
    return prevented;
  };
  assert.equal(press('Tab', true), true); assert.equal(doc.activeElement, last);
  assert.equal(press('Tab'), true); assert.equal(doc.activeElement, first);
  harness.render({ ...props, busy: true }); press('Escape'); assert.equal(closes, 0);
  harness.render({ ...props, busy: false }); press('Escape'); assert.equal(closes, 1);
  doc.modals = []; harness.render({ ...props, active: false });
  assert.equal(doc.activeElement, opener); assert.equal(listeners.size, 0);
  harness.unmount();
});

test('underlying custom modal does not steal focus or Escape from a newer modal', () => {
  const scheduler = createBackgroundScheduler(); const listeners = new Set(); let closes = 0, focus = 0;
  const modal = { getAttribute: () => null, getClientRects: () => [1], querySelector: () => ({ focus: () => focus++ }) };
  const newer = { getAttribute: () => null, getClientRects: () => [1], contains: () => false };
  const harness = createBackgroundModuleHarness({ file: new URL('./useModalFocus.js', import.meta.url), exportName: 'useModalFocus', modules: {},
    globals: { ...scheduler, document: { activeElement: null, querySelectorAll: () => [modal, newer],
      addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) } } });
  harness.render({ active: true, modalRef: { current: modal }, onClose: () => closes++ }); scheduler.frame();
  for (const listener of listeners) listener({ key: 'Escape', preventDefault() { throw new Error('wrong modal'); } });
  assert.equal(closes, 0); assert.equal(focus, 0); harness.unmount();
});
