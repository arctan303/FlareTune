import test from 'node:test';
import assert from 'node:assert/strict';
import { assertToolResult, createToolResult } from './toolResult.js';

test('assistant tools share the current result DTO and reject retired fields', () => {
  const result = createToolResult({
    modelText: '模型文本',
    summary: '摘要',
    eventData: { type: 'knowledge', ok: true },
  });
  assert.deepEqual(Object.keys(result), ['modelText', 'summary', 'eventData', 'playerAction']);
  assert.equal(result.playerAction, null);
  assert.deepEqual(assertToolResult(result), result);
  assert.throws(() => assertToolResult({ ...result, result: '{"ok":true}' }), /retired DTO field/);
});
