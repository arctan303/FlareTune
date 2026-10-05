import test from 'node:test';
import assert from 'node:assert/strict';
import { canHandlePlayerEscape, registerPlayerMenuEscape } from './playerOverlayKeyboard.js';

function fixture() {
  const fullscreen = { getAttribute: () => null };
  let modals = [fullscreen];
  const listeners = [];
  const documentRef = {
    querySelectorAll: () => modals,
    addEventListener(name, handler, capture) { listeners.push({ name, handler, capture }); },
    removeEventListener(name, handler, capture) {
      const index = listeners.findIndex(item => item.name === name && item.handler === handler && item.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const trigger = {
    isConnected: true, inert: false, focused: 0,
    closest(selector) { return selector === '[inert]' ? (this.inert ? {} : null) : fullscreen; },
    focus() { this.focused += 1; },
  };
  const dispatch = (key = 'Escape', defaultPrevented = false) => {
    const event = {
      key, defaultPrevented, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    for (const { handler } of [...listeners]) handler(event);
    return event;
  };
  return { documentRef, trigger, dispatch, listeners, setModals(value) { modals = value; }, fullscreen };
}

test('fullscreen Escape remains available, but inert or covered players yield to the upper modal', () => {
  const f = fixture();
  assert.equal(canHandlePlayerEscape(f.trigger, f.documentRef), true);
  f.trigger.inert = true;
  assert.equal(canHandlePlayerEscape(f.trigger, f.documentRef), false);
  f.trigger.inert = false;
  f.setModals([f.fullscreen, { getAttribute: () => null }]);
  assert.equal(canHandlePlayerEscape(f.trigger, f.documentRef), false);
  f.setModals([f.fullscreen, { getAttribute: name => name === 'aria-hidden' ? 'true' : null }]);
  assert.equal(canHandlePlayerEscape(f.trigger, f.documentRef), true);
});

test('Escape closes only the latest player menu and returns focus to its trigger', () => {
  const f = fixture();
  const closed = [];
  const cleanupFirst = registerPlayerMenuEscape({ ...f, onClose: () => closed.push('first') });
  const cleanupLast = registerPlayerMenuEscape({ ...f, onClose: () => closed.push('last') });
  const firstEscape = f.dispatch();
  assert.deepEqual(closed, ['last']);
  assert.equal(firstEscape.defaultPrevented, true);
  assert.equal(firstEscape.stopped, true);
  assert.equal(f.trigger.focused, 1);
  cleanupLast();
  f.dispatch();
  assert.deepEqual(closed, ['last', 'first']);
  cleanupFirst();
  assert.equal(f.listeners.length, 0);
  assert.equal(f.dispatch().defaultPrevented, false);
});

test('menus do not steal keys from an upper dialog or a previously handled event', () => {
  const f = fixture();
  let closed = 0;
  const cleanup = registerPlayerMenuEscape({ ...f, onClose: () => { closed += 1; } });
  f.setModals([f.fullscreen, { getAttribute: () => null }]);
  assert.equal(f.dispatch().defaultPrevented, false);
  f.setModals([f.fullscreen]);
  f.dispatch('Enter');
  f.dispatch('Escape', true);
  assert.equal(closed, 0);
  cleanup();
});
