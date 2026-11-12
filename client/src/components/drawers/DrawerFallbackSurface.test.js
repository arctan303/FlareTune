import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness } from '../../test/fullscreenBackgroundHarness.js';

for (const error of [false, true]) {
  test(`${error ? 'failed' : 'waiting'} drawer is labelled, closes with Escape and traps its own focus`, () => {
    const handlers = new Map();
    let closed = 0;
    const root = { getAttribute: () => null };
    const document = { activeElement: null, querySelectorAll: () => [root],
      addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
    const close = { tabIndex: 0, focus() { document.activeElement = this; }, getAttribute: () => null };
    const reload = { ...close, focus() { document.activeElement = this; } };
    const controls = error ? [close, reload] : [close];
    const panel = { querySelectorAll: () => controls, contains: element => controls.includes(element) };
    const harness = createBackgroundModuleHarness({
      file: new URL('./DrawerFallbackSurface.jsx', import.meta.url),
      modules: { '../../i18n/index.js': { t: text => text } },
      globals: { document }, nodes: { div: root, section: panel, button: close },
    });
    const props = { title: 'Current queue', isOpen: true, error, onClose: () => { closed++; }, onReload() {} };
    const view = harness.render(props);
    assert.equal(view.props.role, 'dialog');
    assert.equal(view.props['aria-modal'], 'true');
    assert.equal(view.props['aria-label'], 'Current queue');
    assert.equal(document.activeElement, close);
    const key = (key, extra = {}) => {
      const event = { key, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
      handlers.get('keydown')(event); return event;
    };
    document.activeElement = controls.at(-1);
    assert.equal(key('Tab').defaultPrevented, true);
    assert.equal(document.activeElement, close);
    assert.equal(key('Escape').defaultPrevented, true);
    assert.equal(closed, 1);
    assert.equal(harness.render({ ...props, isOpen: false }), null);
    assert.equal(handlers.size, 0);
    harness.unmount();
  });
}
