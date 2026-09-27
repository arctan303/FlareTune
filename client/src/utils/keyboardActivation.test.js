import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKeyboardActivation, isInteractiveKeyboardTarget } from './keyboardActivation.js';

test('handleKeyboardActivation activates a row with Enter or Space', () => {
  for (const key of ['Enter', ' ']) {
    let activated = 0;
    let prevented = 0;
    let stopped = 0;
    const target = {};
    const handled = handleKeyboardActivation({
      key,
      target,
      currentTarget: target,
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
    }, () => { activated += 1; });

    assert.equal(handled, true);
    assert.equal(activated, 1);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
  }
});

test('isInteractiveKeyboardTarget protects native and ARIA controls from global shortcuts', () => {
  const interactiveSelectors = [];
  const target = {
    closest(selector) {
      interactiveSelectors.push(selector);
      return selector.includes('[role="button"]') ? this : null;
    },
  };

  assert.equal(isInteractiveKeyboardTarget(target), true);
  assert.match(interactiveSelectors[0], /\[role="button"\]/);
  assert.match(interactiveSelectors[0], /\[role="link"\]/);
  assert.equal(isInteractiveKeyboardTarget(null), false);
});

test('handleKeyboardActivation ignores unrelated keys and nested controls', () => {
  let activated = 0;
  const row = {};
  const child = {};

  assert.equal(handleKeyboardActivation({
    key: 'ArrowDown', target: row, currentTarget: row, preventDefault() {},
  }, () => { activated += 1; }), false);
  assert.equal(handleKeyboardActivation({
    key: 'Enter', target: child, currentTarget: row, preventDefault() {},
  }, () => { activated += 1; }), false);
  assert.equal(activated, 0);
});
