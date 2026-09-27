import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_SESSION_INVALIDATED_EVENT, notifyAuthenticationRequired } from './authNavigation.js';

test('a protected API 401 emits the global session invalidation signal', () => {
  const events = [];
  const target = {
    Event: class Event { constructor(type) { this.type = type; } },
    dispatchEvent: (event) => events.push(event.type),
  };

  const response = { status: 401 };
  assert.equal(notifyAuthenticationRequired(response, target), response);
  assert.deepEqual(events, [AUTH_SESSION_INVALIDATED_EVENT]);
  notifyAuthenticationRequired({ status: 403 }, target);
  assert.deepEqual(events, [AUTH_SESSION_INVALIDATED_EVENT]);
});
