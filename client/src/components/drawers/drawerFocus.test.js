import test from 'node:test';
import assert from 'node:assert/strict';
import { isTopmostModal, trapDrawerTabKey } from './drawerFocus.js';

const makeElement = (name) => ({
  name,
  tabIndex: 0,
  hasAttribute: () => false,
  getAttribute: () => null,
  focusCount: 0,
  focus() { this.focusCount += 1; },
});

test('trapDrawerTabKey loops focus in both directions', () => {
  const first = makeElement('first');
  const last = makeElement('last');
  const container = {
    querySelectorAll: () => [first, last],
    contains: (element) => element === first || element === last,
  };
  let prevented = 0;

  assert.equal(trapDrawerTabKey({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented += 1; } }, container, last), true);
  assert.equal(first.focusCount, 1);
  assert.equal(trapDrawerTabKey({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented += 1; } }, container, first), true);
  assert.equal(last.focusCount, 1);
  assert.equal(prevented, 2);
});

test('trapDrawerTabKey keeps ordinary Tab movement inside the drawer', () => {
  const first = makeElement('first');
  const middle = makeElement('middle');
  const last = makeElement('last');
  const container = {
    querySelectorAll: () => [first, middle, last],
    contains: (element) => [first, middle, last].includes(element),
  };

  assert.equal(trapDrawerTabKey({ key: 'Tab', shiftKey: false, preventDefault() {} }, container, middle), false);
  assert.equal(first.focusCount + last.focusCount, 0);
});

test('only the last visible modal in document order owns the focus loop', () => {
  const lowerDrawer = { getAttribute: () => null };
  const upperModal = { getAttribute: () => null };
  const hiddenModal = { getAttribute: (name) => (name === 'aria-hidden' ? 'true' : null) };
  const documentRef = {
    querySelectorAll: () => [lowerDrawer, hiddenModal, upperModal],
  };

  assert.equal(isTopmostModal(lowerDrawer, documentRef), false);
  assert.equal(isTopmostModal(hiddenModal, documentRef), false);
  assert.equal(isTopmostModal(upperModal, documentRef), true);
});
