import test from 'node:test';
import assert from 'node:assert/strict';
import { focusPlayerMenuItem, handlePlayerMenuKeyDown } from './playerMenuKeyboard.js';

function menuFixture() {
  const items = Array.from({ length: 4 }, (_, index) => ({
    tabIndex: -1, clicked: 0, focused: false, disabled: index === 1,
    getAttribute: name => name === 'aria-checked' && index === 2 ? 'true' : null,
    focus() { items.forEach(item => { item.focused = item === this; }); },
    click() { this.clicked += 1; },
    closest() { return this; },
  }));
  const menu = { querySelectorAll: () => items };
  const press = key => {
    const event = { key, target: items.find(item => item.focused), prevented: false,
      preventDefault() { this.prevented = true; }, stopPropagation() {} };
    handlePlayerMenuKeyDown(event, menu);
    return event;
  };
  return { items, menu, press };
}

test('menus start on the selected item and maintain exactly one enabled tab stop', () => {
  const { items, menu } = menuFixture();
  focusPlayerMenuItem(menu);
  assert.equal(items[2].focused, true);
  assert.deepEqual(items.map(item => item.tabIndex), [-1, -1, 0, -1]);
});

test('Arrow keys wrap, skip disabled items, and Home/End choose the edges', () => {
  const { items, menu, press } = menuFixture();
  focusPlayerMenuItem(menu, 'first');
  press('ArrowDown');
  assert.equal(items[2].focused, true);
  press('End');
  assert.equal(items[3].focused, true);
  press('ArrowDown');
  assert.equal(items[0].focused, true);
  press('ArrowUp');
  assert.equal(items[3].focused, true);
  press('Home');
  assert.equal(items[0].focused, true);
  assert.equal(items.filter(item => item.tabIndex === 0).length, 1);
});

test('Enter and Space activate once while Tab remains available to leave the menu', () => {
  const { items, menu, press } = menuFixture();
  focusPlayerMenuItem(menu, 'first');
  assert.equal(press('Enter').prevented, true);
  assert.equal(press(' ').prevented, true);
  assert.equal(items[0].clicked, 2);
  assert.equal(press('Tab').prevented, false);
});
