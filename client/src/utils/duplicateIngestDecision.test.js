import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectDuplicateDecisionAfterCheckFailure } from './duplicateIngestDecision.js';
import { setUiLanguage, t } from '../i18n/index.js';

test('failed recheck revokes a previously selected replacement and exposes explicit add choice', () => {
  const entry = { allowDuplicate: true, replaceTarget: { id: 'old', version: 'a'.repeat(64) },
    reviewStale: true, status: 'checking', duplicateMatches: [] };
  const next = rejectDuplicateDecisionAfterCheckFailure(entry, new Error('network'));
  assert.equal(next.allowDuplicate, false);
  assert.equal(next.replaceTarget, null);
  assert.equal(next.reviewStale, false);
  assert.equal(next.duplicateState, 'error');
  assert.match(next.message, /明确忽略并新增/);
  assert.equal(next.messageValues.reason, 'network');
});

test('duplicate errors remain translatable after a language switch and keep provider details', async () => {
  const next = rejectDuplicateDecisionAfterCheckFailure({}, new Error('Network failure'));
  try {
    await setUiLanguage('en');
    assert.equal(t(next.message, next.messageValues), 'Duplicate check failed: Network failure. This track has not been uploaded. Retry, or explicitly skip the check and add it.');
    await setUiLanguage('ja');
    assert.match(t(next.message, next.messageValues), /^重複チェックに失敗しました：Network failure。/);
  } finally { await setUiLanguage('en'); }
});
