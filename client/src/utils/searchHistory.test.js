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
    assert.deepEqual(loadRecentSearches(), []);

    // Add search terms
    saveRecentSearchToStorage('周杰伦');
    saveRecentSearchToStorage('晴天');
    assert.deepEqual(loadRecentSearches(), ['晴天', '周杰伦']);

    // Deduplicate and move to top
    saveRecentSearchToStorage('周杰伦');
    assert.deepEqual(loadRecentSearches(), ['周杰伦', '晴天']);

    // Ignore empty/whitespace
    saveRecentSearchToStorage('   ');
    assert.deepEqual(loadRecentSearches(), ['周杰伦', '晴天']);

    // Remove single
    removeRecentSearchFromStorage('晴天');
    assert.deepEqual(loadRecentSearches(), ['周杰伦']);

    // Clear all
    clearRecentSearchesFromStorage();
    assert.deepEqual(loadRecentSearches(), []);

    // Caps at 10 items
    for (let i = 1; i <= 15; i++) {
      saveRecentSearchToStorage(`Query ${i}`);
    }
    const capped = loadRecentSearches();
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
    assert.deepEqual(loadRecentSearchEntities(), []);

    // Invalid entity without type is ignored
    assert.deepEqual(saveRecentSearchEntity({ foo: 'bar' }), []);

    // Save song entity
    const song1 = { type: 'song', id: '101', title: '晴天', artist: '周杰伦', coverUrl: 'http://example.com/101.jpg' };
    saveRecentSearchEntity(song1);
    assert.deepEqual(loadRecentSearchEntities(), [song1]);

    // Save artist entity
    const artist1 = { type: 'artist', name: '凤凰传奇', coverUrl: 'http://example.com/fh.jpg' };
    saveRecentSearchEntity(artist1);
    assert.deepEqual(loadRecentSearchEntities(), [artist1, song1]);

    // Deduplicate song and move to top by id
    const song1Updated = { type: 'song', id: '101', title: '晴天 (现场版)', artist: '周杰伦' };
    saveRecentSearchEntity(song1Updated);
    const afterSongDedup = loadRecentSearchEntities();
    assert.equal(afterSongDedup.length, 2);
    assert.equal(afterSongDedup[0].id, '101');
    assert.equal(afterSongDedup[0].title, '晴天 (现场版)');

    // Deduplicate artist case-insensitively and move to top
    const artist1Dup = { type: 'artist', name: ' 凤凰传奇 ', coverUrl: 'http://example.com/fh2.jpg' };
    saveRecentSearchEntity(artist1Dup);
    const afterArtistDedup = loadRecentSearchEntities();
    assert.equal(afterArtistDedup.length, 2);
    assert.equal(afterArtistDedup[0].type, 'artist');

    // Remove song entity
    removeRecentSearchEntity({ type: 'song', id: '101' });
    assert.equal(loadRecentSearchEntities().length, 1);
    assert.equal(loadRecentSearchEntities()[0].type, 'artist');

    // Clear all entities
    clearRecentSearchEntities();
    assert.deepEqual(loadRecentSearchEntities(), []);

    // Caps at MAX_RECENT_ENTITIES (10 items)
    for (let i = 1; i <= 15; i++) {
      saveRecentSearchEntity({ type: 'song', id: String(i), title: `Song ${i}` });
    }
    const capped = loadRecentSearchEntities();
    assert.equal(capped.length, 10);
    assert.equal(capped[0].id, '15');
    assert.equal(capped[9].id, '6');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});
