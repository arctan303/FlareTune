import test from 'node:test';
import assert from 'node:assert/strict';
import { startNavigationMotion } from './navigationMotion.js';

function fixture(reduced = false) {
  const listeners = new Set();
  const preference = {
    matches: reduced,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  };
  const calls = [];
  const element = {
    ownerDocument: { defaultView: { matchMedia: () => preference } },
    animate: (frames, options) => {
      const call = { frames, options, canceled: false };
      calls.push(call);
      return { cancel: () => { call.canceled = true; } };
    },
  };
  return { element, calls, preference, listeners };
}

test('switches animate in either direction and leave no filled final transform', () => {
  const { element, calls } = fixture();
  const stopEnter = startNavigationMotion(element, 1);
  assert.equal(calls[0].frames[0].transform, 'translateX(10px)');
  assert.equal(calls[0].options.duration, 180);
  assert.equal(calls[0].options.fill, undefined);
  stopEnter();
  startNavigationMotion(element, -1)();
  assert.equal(calls[1].frames[0].transform, 'translateX(-10px)');
  assert.ok(calls.every((call) => call.canceled));
});

test('cleanup cancels previous animation without a system-preference listener', () => {
  const { element, calls, listeners } = fixture();
  const stop = startNavigationMotion(element, 1);
  assert.equal(listeners.size, 0);
  stop();
  assert.equal(calls[0].canceled, true);
  assert.equal(listeners.size, 0);
});

test('system preference does not skip navigation and missing animation APIs remain safe', () => {
  const { element, calls } = fixture(true);
  startNavigationMotion(element, 1)();
  assert.equal(calls.length, 1);
  assert.doesNotThrow(() => startNavigationMotion(null, 1)());
  assert.doesNotThrow(() => startNavigationMotion({}, 1)());
});

test('changing system preference does not interrupt an application transition', () => {
  const { element, calls, preference, listeners } = fixture();
  const stop = startNavigationMotion(element, 1);
  preference.matches = true;
  for (const listener of listeners) listener();
  assert.equal(calls[0].canceled, false);
  stop();
  assert.equal(calls[0].canceled, true);
  assert.equal(listeners.size, 0);
});
