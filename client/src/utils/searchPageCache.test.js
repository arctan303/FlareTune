import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchPageCache, searchPageKey } from './searchPageCache.js';

test('manual refresh removes only its query and normal results expire after fifteen minutes', () => {
  let now = 0;
  const cache = createSearchPageCache({ now: () => now });
  cache.set('one', { songs: [] }); cache.set('two', { songs: [] });
  cache.delete('one');
  assert.equal(cache.get('one'), undefined);
  now = 899999;
  assert.ok(cache.get('two'));
  now = 900000;
  assert.equal(cache.get('two'), undefined);
});

test('returning to search restores expanded results, with bounded lifetime and capacity', () => {
  let time = 0;
  const cache = createSearchPageCache({ now: () => time, ttlMs: 100, limit: 2 });
  const key = searchPageKey(' artist ', 'all');
  const page = { songs: Array.from({ length: 40 }, (_, id) => ({ id })), hasMore: true };
  cache.set(key, page);
  assert.equal(cache.get(searchPageKey('artist', 'all')), page);
  assert.equal(cache.get(searchPageKey('artist', 'ja')), undefined);
  cache.set('b', page);
  cache.get(key);
  cache.set('c', page);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get(key).songs.length, 40);
  time = 100;
  assert.equal(cache.get(key), undefined);
});

test('song changes apply while search is unmounted without renewing cache freshness', () => {
  let time = 0;
  const cache = createSearchPageCache({ now: () => time, ttlMs: 100 });
  cache.set('q', { songs: [{ id: 1, title: 'old' }], hasMore: false });
  time = 50;
  cache.updateSong({ id: '1', title: 'new' });
  assert.equal(cache.get('q').songs[0].title, 'new');
  time = 100;
  assert.equal(cache.get('q'), undefined);
  assert.equal(createSearchPageCache().get('q'), undefined);
});
