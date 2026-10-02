import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRecentSearches,
  saveRecentSearchToStorage,
  removeRecentSearchFromStorage,
  clearRecentSearchesFromStorage,
  loadRecentSearchEntities,
  saveRecentSearchEntity,
  removeRecentSearchEntity,
  clearRecentSearchEntities,
} from './searchHistory.js';

test('searchHistory manages recent search terms with deduplication, order preservation, and cap', () => {
  const store = {};
  const mockLocalStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };

  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = mockLocalStorage;

  try {
    assert.deepEqual(loadRecentSearches('account-A'), []);

    // Add search terms
    saveRecentSearchToStorage('周杰伦', 'account-A');
    saveRecentSearchToStorage('晴天', 'account-A');
    assert.deepEqual(loadRecentSearches('account-A'), ['晴天', '周杰伦']);

    // Deduplicate and move to top
    saveRecentSearchToStorage('周杰伦', 'account-A');
    assert.deepEqual(loadRecentSearches('account-A'), ['周杰伦', '晴天']);

    // Ignore empty/whitespace
    saveRecentSearchToStorage('   ', 'account-A');
    assert.deepEqual(loadRecentSearches('account-A'), ['周杰伦', '晴天']);

    // Remove single
    removeRecentSearchFromStorage('晴天', 'account-A');
    assert.deepEqual(loadRecentSearches('account-A'), ['周杰伦']);

    // Clear all
    clearRecentSearchesFromStorage('account-A');
    assert.deepEqual(loadRecentSearches('account-A'), []);

    // Caps at 10 items
    for (let i = 1; i <= 15; i++) {
      saveRecentSearchToStorage(`Query ${i}`, 'account-A');
    }
    const capped = loadRecentSearches('account-A');
    assert.equal(capped.length, 10);
    assert.equal(capped[0], 'Query 15');
    assert.equal(capped[9], 'Query 6');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('searchHistory manages recent search entities (songs & artists) with deduplication, cap, and removal', () => {
  const store = {};
  const mockLocalStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => { store[key] = String(val); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };

  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = mockLocalStorage;

  try {
    assert.deepEqual(loadRecentSearchEntities('account-A'), []);

    // Invalid entity without type is ignored
    assert.deepEqual(saveRecentSearchEntity({ foo: 'bar' }, 'account-A'), []);

    // Save song entity
    const song1 = { type: 'song', id: '101', title: '晴天', artist: '周杰伦', coverUrl: 'http://example.com/101.jpg' };
    saveRecentSearchEntity(song1, 'account-A');
    assert.deepEqual(loadRecentSearchEntities('account-A'), [song1]);

    // Save artist entity
    const artist1 = { type: 'artist', name: '凤凰传奇', coverUrl: 'http://example.com/fh.jpg' };
    saveRecentSearchEntity(artist1, 'account-A');
    assert.deepEqual(loadRecentSearchEntities('account-A'), [artist1, song1]);

    // Deduplicate song and move to top by id
    const song1Updated = { type: 'song', id: '101', title: '晴天 (现场版)', artist: '周杰伦' };
    saveRecentSearchEntity(song1Updated, 'account-A');
    const afterSongDedup = loadRecentSearchEntities('account-A');
    assert.equal(afterSongDedup.length, 2);
    assert.equal(afterSongDedup[0].id, '101');
    assert.equal(afterSongDedup[0].title, '晴天 (现场版)');

    // Deduplicate artist case-insensitively and move to top
    const artist1Dup = { type: 'artist', name: ' 凤凰传奇 ', coverUrl: 'http://example.com/fh2.jpg' };
    saveRecentSearchEntity(artist1Dup, 'account-A');
    const afterArtistDedup = loadRecentSearchEntities('account-A');
    assert.equal(afterArtistDedup.length, 2);
    assert.equal(afterArtistDedup[0].type, 'artist');

    // Remove song entity
    removeRecentSearchEntity({ type: 'song', id: '101' }, 'account-A');
    assert.equal(loadRecentSearchEntities('account-A').length, 1);
    assert.equal(loadRecentSearchEntities('account-A')[0].type, 'artist');

    // Clear all entities
    clearRecentSearchEntities('account-A');
    assert.deepEqual(loadRecentSearchEntities('account-A'), []);

    // Caps at MAX_RECENT_ENTITIES (10 items)
    for (let i = 1; i <= 15; i++) {
      saveRecentSearchEntity({ type: 'song', id: String(i), title: `Song ${i}` }, 'account-A');
    }
    const capped = loadRecentSearchEntities('account-A');
    assert.equal(capped.length, 10);
    assert.equal(capped[0].id, '15');
    assert.equal(capped[9].id, '6');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});
