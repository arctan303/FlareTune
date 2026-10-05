import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricDocument } from '../utils/lyricDocument.js';
import {
  compareAutomaticDocuments, preferredAutomaticDocument, reliableAutomaticMatch,
} from './lyricAutomaticSelection.js';

const document = (syncMode, delta, translated = false) => createLyricDocument({
  source: 'kugou', format: syncMode === 'word' ? 'krc' : 'lrc',
  providerMeta: { durationDelta: delta },
  lines: [{ text: 'Sing together', ...(syncMode !== 'none' ? { time: 1 } : {}),
    ...(syncMode === 'word' ? { endTime: 2, words: [{ text: 'Sing together', startTime: 1, endTime: 2 }] } : {}),
    ...(translated ? { tlyric: '一起唱歌' } : {}) }],
});

test('close recordings prefer precision before translation and duration without the former three-second cliff', () => {
  assert.equal(preferredAutomaticDocument(document('word', 3.01), document('line', 3, true)), true);
  assert.equal(preferredAutomaticDocument(document('word', 5), document('line', 0, true)), true);
  assert.equal(preferredAutomaticDocument(document('line', 5), document('none', 0, true)), true);
  assert.equal(preferredAutomaticDocument(document('word', 5, true), document('word', 0)), true);
  assert.equal(preferredAutomaticDocument(document('word', 1), document('word', 2)), true);
});

test('confidence decays continuously outside five seconds while large discrepancies and wrong versions are excluded', () => {
  assert.equal(preferredAutomaticDocument(document('word', 5.01), document('line', 5)), true);
  assert.equal(preferredAutomaticDocument(document('word', 14), document('line', 1)), false);
  assert.equal(preferredAutomaticDocument(document('word', 14, true), document('line', 1)), false);
  assert.equal(reliableAutomaticMatch(document('word', 15)), true);
  assert.equal(reliableAutomaticMatch(document('word', 15.01)), false);
  const mismatched = document('word', 0, true);
  mismatched.providerMeta.versionMismatch = true;
  assert.equal(preferredAutomaticDocument(mismatched, document('line', 1)), false);
});

test('unknown durations remain usable with a conservative penalty and ties keep the current document', () => {
  assert.equal(reliableAutomaticMatch(document('word', null)), true);
  assert.equal(preferredAutomaticDocument(document('word', null), document('line', 1)), true);
  assert.equal(preferredAutomaticDocument(document('word', null), document('word', 1)), false);
  assert.equal(preferredAutomaticDocument(document('word', 0), document('word', 0)), false);
  assert.equal(compareAutomaticDocuments(null, null), 0);
  assert.equal(preferredAutomaticDocument(null, document('line', 0)), false);
});
