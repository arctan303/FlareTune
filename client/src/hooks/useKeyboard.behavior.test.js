import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';

test('search shortcuts respect edit modals and consumed events but remain available in the player and ordinary pages', () => {
  const handlers = new Map();
  let topModal = null, searches = 0;
  const harness = createBackgroundModuleHarness({
    file: new URL('./useKeyboard.js', import.meta.url), exportName: 'useGlobalKeyboardShortcuts',
    modules: { '../i18n/index.js': { t: text => text } },
    globals: {
      document: { querySelectorAll: () => topModal ? [topModal] : [] },
      window: { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) },
    },
  });
  harness.render({ onOpenSearch: () => { searches++; }, togglePlay() {}, playPrev() {}, playNext() {}, setVolume() {}, showToast() {} });
  const press = (extra = {}) => {
    const event = { key: 'k', ctrlKey: true, target: { closest: () => null }, preventDefault() { this.defaultPrevented = true; }, ...extra };
    handlers.get('keydown')(event);
    return event;
  };
  press();
  assert.equal(searches, 1);
  press({ defaultPrevented: true });
  assert.equal(searches, 1);
  topModal = { getAttribute: () => null, classList: { contains: () => false } };
  press();
  press({ key: '/', ctrlKey: false });
  assert.equal(searches, 1, 'a dialog or drawer keeps both search shortcuts inside its transaction');
  topModal = { getAttribute: () => null, classList: { contains: name => name === 'app-player-surface' } };
  press();
  assert.equal(searches, 2, 'the existing fullscreen-to-search path remains available');
  topModal = null;
  press({ key: '/', ctrlKey: false });
  assert.equal(searches, 3);
  harness.unmount();
  assert.equal(handlers.size, 0);
});
