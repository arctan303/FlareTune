import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectDuplicateDecisionAfterCheckFailure } from './duplicateIngestDecision.js';

test('failed recheck revokes a previously selected replacement and exposes explicit add choice', () => {
  const entry = { allowDuplicate: true, replaceTarget: { id: 'old', version: 'a'.repeat(64) },
    reviewStale: true, status: 'checking', duplicateMatches: [] };
  const next = rejectDuplicateDecisionAfterCheckFailure(entry, new Error('network'));
  assert.equal(next.allowDuplicate, false);
  assert.equal(next.replaceTarget, null);
  assert.equal(next.reviewStale, false);
  assert.equal(next.duplicateState, 'error');
  assert.match(next.message, /明确忽略并新增/);
});
