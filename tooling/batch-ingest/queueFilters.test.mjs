import assert from 'node:assert/strict';
import test from 'node:test';
import { filterEntries } from './web/queueFilters.js';

test('status, language and text filters combine without hiding failed songs', () => {
  const base = { draft: { artist: 'Singer' }, path: 'music/zh', skip: false,
    reviewStale: false, matches: [], allowDuplicate: false };
  const entries = [
    { ...base, draft: { ...base.draft, title: 'Alpha', language: 'zh' }, status: 'error' },
    { ...base, draft: { ...base.draft, title: 'Beta', language: 'zh' }, status: 'ready', matches: [{}] },
    { ...base, draft: { ...base.draft, title: 'Gamma', language: 'en' }, status: 'saved' },
  ];
  assert.deepEqual(filterEntries(entries, { status: 'error', language: 'zh' }), [entries[0]]);
  assert.deepEqual(filterEntries(entries, { status: 'duplicate' }), [entries[1]]);
  assert.deepEqual(filterEntries(entries, { status: 'saved', query: 'gamma' }), [entries[2]]);
  assert.deepEqual(filterEntries(entries, { status: 'pending' }), []);
});
