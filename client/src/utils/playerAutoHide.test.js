import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerAutoHide, acquirePlayerInteraction, subscribePlayerInteractions, getPlayerInteraction } from './playerAutoHide.js';

function clock() {
  let now = 0;
  let id = 0;
  const tasks = new Map();
  return {
    setTimer(fn, delay) { tasks.set(++id, { fn, at: now + delay }); return id; },
    clearTimer(key) { tasks.delete(key); },
    advance(ms) {
      now += ms;
      for (const [key, task] of [...tasks]) if (task.at <= now) { tasks.delete(key); task.fn(); }
    },
    tasks,
  };
}

for (const delay of [2600, 4200]) test(`idle controls hide after their existing ${delay}ms delay`, () => {
  const time = clock();
  const states = [];
  const autoHide = createPlayerAutoHide({ delay, onVisibleChange: value => states.push(value), ...time });
  autoHide.setEnabled(true);
  time.advance(delay - 1);
  assert.equal(autoHide.isVisible(), true);
  time.advance(1);
  assert.equal(autoHide.isVisible(), false);
  autoHide.reveal();
  assert.equal(autoHide.isVisible(), true);
  autoHide.destroy();
  assert.equal(time.tasks.size, 0);
});

test('hover, focus, open menu and drag holds overlap; the last release starts a full idle period', () => {
  const time = clock();
  const autoHide = createPlayerAutoHide({ delay: 2600, onVisibleChange() {}, ...time });
  autoHide.setEnabled(true);
  for (const hold of ['hover', 'focus', 'menu', 'pointer']) autoHide.hold(hold);
  time.advance(20000);
  assert.equal(autoHide.isVisible(), true);
  for (const hold of ['hover', 'focus', 'menu']) autoHide.release(hold);
  time.advance(20000);
  assert.equal(autoHide.isVisible(), true);
  autoHide.release('pointer');
  time.advance(2599);
  assert.equal(autoHide.isVisible(), true);
  time.advance(1);
  assert.equal(autoHide.isVisible(), false);
});

test('repeated motion while already visible does not rewrite shared UI state', () => {
  const time = clock();
  const states = [];
  const autoHide = createPlayerAutoHide({ delay: 2600, onVisibleChange: value => states.push(value), ...time });
  autoHide.setEnabled(true);
  for (let i = 0; i < 100; i += 1) autoHide.reveal();
  assert.deepEqual(states, [true]);
  time.advance(2600);
  assert.deepEqual(states, [true, false]);
});

test('paused or inactive mobile lyric view stays visible without a timer', () => {
  const time = clock();
  const autoHide = createPlayerAutoHide({ delay: 4200, onVisibleChange() {}, ...time });
  autoHide.setEnabled(true);
  time.advance(4200);
  autoHide.setEnabled(false);
  time.advance(20000);
  assert.equal(autoHide.isVisible(), true);
  assert.equal(time.tasks.size, 0);
});

test('menu and portal locks survive separate owners and release only after the final owner closes', () => {
  const states = [];
  const unsubscribe = subscribePlayerInteractions(active => states.push(active));
  const releaseMenu = acquirePlayerInteraction();
  const releasePortal = acquirePlayerInteraction();
  releaseMenu();
  assert.equal(states.at(-1), true);
  releasePortal();
  assert.equal(states.at(-1), false);
  const count = states.length;
  releasePortal();
  assert.equal(states.length, count);
  unsubscribe();
});

test('keyboard-only lyric regions cannot preempt the first touch wake protection', () => {
  const region = { closest: () => null, getAttribute: () => 'keyboard' };
  const target = { closest: () => region };
  assert.equal(getPlayerInteraction(target), region);
  assert.equal(getPlayerInteraction(target, { pointer: true }), null);
  region.closest = () => ({});
  assert.equal(getPlayerInteraction(target), null);
});
