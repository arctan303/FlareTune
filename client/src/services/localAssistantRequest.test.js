import assert from 'node:assert/strict';
import test from 'node:test';
import { localAssistantMutationHeaders } from './localAssistantRequest.js';

test('assistant mutations use the local session CSRF contract', () => {
  assert.deepEqual(localAssistantMutationHeaders('csrf-test'), {
    'Content-Type': 'application/json',
    'X-Requested-With': 'FlareTune',
    'X-CSRF-Token': 'csrf-test',
  });
  assert.throws(() => localAssistantMutationHeaders(''), /登录会话已失效/);
  assert.throws(() => localAssistantMutationHeaders(undefined), /登录会话已失效/);
});
