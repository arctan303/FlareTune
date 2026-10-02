import test from 'node:test';
import assert from 'node:assert/strict';
import { useUIStore } from '../store/useUIStore.js';
import { loadRecentSearches, saveRecentSearchToStorage, loadRecentSearchEntities,
  saveRecentSearchEntity, clearRecentSearchEntities, removeRecentSearchEntity } from './searchHistory.js';

test('real auth transitions isolate browser histories and restore the same account', () => {
  const original = globalThis.localStorage;
  const values = new Map([
    ['arc_recent_searches', '["legacy private query"]'],
    ['arc_recent_search_entities', '[{"type":"song","id":"legacy"}]'],
  ]);
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const login = (id, csrfToken) => useUIStore.getState().setAuthSession({ initialized: true,
    authenticated: true, user: { accountId: id, role: 'member' }, csrfToken });
  try {
    login('A', 'csrf-A');
    assert.deepEqual(loadRecentSearchEntities('A'), []);
    assert.equal(values.has('arc_recent_search_entities'), false);
    saveRecentSearchToStorage('Query A', 'A');
    saveRecentSearchEntity({ type: 'song', id: 'song-A' }, 'A');
    login('B', 'csrf-B');
    assert.deepEqual(loadRecentSearchEntities('B'), []);
    assert.deepEqual(loadRecentSearches('B'), []);
    saveRecentSearchEntity({ type: 'artist', name: 'Artist B' }, 'B');
    removeRecentSearchEntity({ type: 'song', id: 'song-A' }, 'B');
    clearRecentSearchEntities('B');
    useUIStore.getState().setAuthSession({ initialized: true, authenticated: false, user: null });
    assert.deepEqual(loadRecentSearchEntities(), []);
    assert.deepEqual(saveRecentSearchEntity({ type: 'song', id: 'anonymous' }), []);
    assert.deepEqual(loadRecentSearches(), []);
    assert.deepEqual(saveRecentSearchToStorage('anonymous'), []);
    login('A', 'new-csrf-A');
    assert.deepEqual(loadRecentSearches('A'), ['Query A']);
    assert.deepEqual(loadRecentSearchEntities('A'), [{ type: 'song', id: 'song-A' }]);
    assert.deepEqual(loadRecentSearchEntities('B'), []);
  } finally {
    useUIStore.getState().setAuthSession({ initialized: true, authenticated: false, user: null });
    globalThis.localStorage = original;
  }
});

test('account keys cannot collide and unavailable/corrupt storage stays empty', () => {
  const original = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  try {
    saveRecentSearchEntity({ type: 'song', id: 'one' }, 'A:B');
    assert.deepEqual(loadRecentSearchEntities('A%3AB'), []);
    for (const key of values.keys()) values.set(key, '{invalid');
    assert.deepEqual(loadRecentSearchEntities('A:B'), []);
    globalThis.localStorage = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } };
    assert.deepEqual(saveRecentSearchEntity({ type: 'song', id: 'one' }, 'A'), []);
  } finally { globalThis.localStorage = original; }
});
