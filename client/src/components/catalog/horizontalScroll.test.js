import test from 'node:test';
import assert from 'node:assert/strict';
import { horizontalScrollState, moveHorizontalScroll } from './horizontalScroll.js';

test('horizontal controls follow actual overflow and both reachable directions', () => {
  const viewport = { scrollWidth: 840, clientWidth: 400, scrollLeft: 0 };
  assert.deepEqual(horizontalScrollState(viewport), { overflow: true, left: false, right: true });
  viewport.scrollLeft = 440;
  assert.deepEqual(horizontalScrollState(viewport), { overflow: true, left: true, right: false });
  viewport.scrollWidth = 400;
  viewport.scrollLeft = 0;
  assert.deepEqual(horizontalScrollState(viewport), { overflow: false, left: false, right: false });
});

test('horizontal movement advances a card or column and stays within content', () => {
  let command;
  const viewport = { scrollWidth: 1000, clientWidth: 400, scrollLeft: 210,
    scrollTo(next) { command = next; } };
  moveHorizontalScroll(viewport, 1, 200);
  assert.equal(command.left, 400);
  moveHorizontalScroll(viewport, -1, 200, { snap: false });
  assert.equal(command.left, 10);
  viewport.scrollLeft = 550;
  moveHorizontalScroll(viewport, 1, 200);
  assert.equal(command.left, 600);
});
