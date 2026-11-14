import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPluginContribution, getPluginContribution } from './contributions.js';

test('contribution actions and readers retire with their installation/account lease', () => {
  let current = true, calls = 0, publish, unsubscribed = 0;
  const cleanup = registerPluginContribution('fixture', 'queue', {
    isCurrent: () => current, getSnapshot: () => ({ available: true }),
    subscribe(fn) { publish = fn; return () => { unsubscribed++; }; }, actions: { start: () => ++calls },
  });
  const contribution = getPluginContribution('fixture', 'queue');
  assert.equal(contribution.actions.start(), 1);
  current = false;
  assert.equal(getPluginContribution('fixture', 'queue'), undefined);
  assert.equal(contribution.actions.start(), false); assert.equal(calls, 1);
  publish(); cleanup(); assert.equal(unsubscribed, 1);
});
test('replacing a contribution removes its subscriptions and stale cleanup cannot remove the new renderer', () => {
  let stopped = 0;
  const first = registerPluginContribution('fixture', 'same-slot', { isCurrent: () => true,
    getSnapshot: () => ({ version: 1 }), subscribe: () => () => stopped++, actions: { start: () => true } });
  const old = getPluginContribution('fixture', 'same-slot');
  const next = registerPluginContribution('fixture', 'same-slot', { isCurrent: () => true,
    getSnapshot: () => ({ version: 2 }), actions: { start: () => true } });
  first(); assert.equal(stopped, 1); assert.equal(old.actions.start(), false);
  assert.equal(getPluginContribution('fixture', 'same-slot').version, 2);
  next(); assert.equal(getPluginContribution('fixture', 'same-slot'), undefined);
});
