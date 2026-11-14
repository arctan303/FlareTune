import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueContinuationRegistry } from './queueContinuation.js';

test('a retired provider loses continuation and autoplay permission without touching a queue', () => {
  const registry = createQueueContinuationRegistry();
  let current = true, calls = 0;
  registry.register({ onQueueEnd() { calls++; return true; } }, () => current);
  assert.equal(registry.notify('onQueueEnd', {}), true);
  assert.equal(registry.canResume(), true);
  current = false;
  assert.equal(registry.notify('onQueueEnd', {}), false);
  assert.equal(registry.canResume(), false);
  assert.equal(registry.isWaiting(), false);
  assert.equal(calls, 1);
});

test('pause permits a requested batch to remain pending while revoking autoplay', () => {
  const registry = createQueueContinuationRegistry();
  registry.register({ onQueueEnd: () => true });
  registry.notify('onQueueEnd', {});
  registry.notify('onPause', {});
  assert.equal(registry.isWaiting(), true);
  assert.equal(registry.canResume(), false);
  registry.notify('onQueueCleared', {});
  assert.equal(registry.isWaiting(), false);
});

test('cleanup is idempotent and an old cleanup cannot unregister a newer provider', () => {
  const registry = createQueueContinuationRegistry();
  const old = registry.register({ onQueueEnd: () => true });
  assert.throws(() => registry.register({ onQueueEnd: () => true }), /already registered/);
  old(); old();
  registry.register({ onQueueEnd: () => true }); old();
  assert.equal(registry.notify('onQueueEnd', {}), true);
});

test('a provider exception fails closed and removes pending resume authorization', () => {
  const registry = createQueueContinuationRegistry();
  registry.register({ onQueueEnd() { throw new Error('plugin failed'); } });
  assert.equal(registry.notify('onQueueEnd', {}), false);
  assert.equal(registry.canResume(), false);
  registry.register({ onQueueEnd: () => false });
  assert.equal(registry.notify('onQueueEnd', {}), false);
});
