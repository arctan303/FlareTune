import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSongLanguageCounts } from './useSongLanguageCounts.js';

test('language counts are derived only from the current API payload', () => {
  assert.deepEqual(normalizeSongLanguageCounts({ zh: 2, en: 3, ja: 1, yue: 4, other: 2 }), {
    zh: 2,
    en: 3,
    ja: 1,
    other: 6,
    all: 12,
  });
});

test('language counts reject missing or unusable payloads instead of inventing zeroes', () => {
  assert.equal(normalizeSongLanguageCounts(null), null);
  assert.equal(normalizeSongLanguageCounts([]), null);
  assert.equal(normalizeSongLanguageCounts({ zh: '234', en: -1 }), null);
});
