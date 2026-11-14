import test from 'node:test';
import assert from 'node:assert/strict';
import { pagedSearch, pagedArtist } from './pagination.mjs';
const makeSong = index => ({ id: 'a' + String(index).padStart(10, '0'), title: 'Song ' + index, item_type: 'song' });

test('search pagination keeps request-local cursors and reuses completed progress', async () => {
  let searches = 0, continuations = 0;
  const page = index => ({ contents: index === 0 ? [{ contents: Array.from({ length: 20 }, (_, n) => makeSong(index * 20 + n)) }] :
    { contents: Array.from({ length: 20 }, (_, n) => makeSong(index * 20 + n)) }, has_continuation: index < 2,
    async getContinuation() { continuations++; return page(index + 1); } });
  const yt = { music: { async search() { searches++; return page(0); } } };
  const base = { filter: 'song', hl: 'en', cacheNamespace: crypto.randomUUID() };
  const first = await pagedSearch(yt, 'query', { ...base, offset: 0, limit: 20 });
  assert.equal(first.songs.length, 20); assert.equal(first.hasMore, true);
  const more = await Promise.all([pagedSearch(yt, 'query', { ...base, offset: 20, limit: 20 }),
    pagedSearch(yt, 'query', { ...base, offset: 40, limit: 20 })]);
  // Separate Worker requests cannot inherit unfinished work. Both may advance
  // page one, then the later request publishes its furthest completed cursor.
  assert.equal(searches, 1); assert.equal(continuations, 3);
  assert.equal(more[0].songs.length, 40);
  assert.equal(more[1].songs[40].title, 'Song 40'); assert.equal(more[1].hasMore, false);
  const again = await pagedSearch(yt, 'query', { ...base, offset: 0, limit: 20 });
  assert.equal(again.songs.length, 60); assert.equal(again.hasMore, true); assert.equal(continuations, 3);
});

test('uncached far search offsets are bounded rather than silently skipping results', async () => {
  let calls = 0;
  const page = () => ({ contents: [{ contents: [makeSong(calls)] }], has_continuation: true,
    async getContinuation() { calls++; return page(); } });
  const yt = { music: { async search() { return page(); } } };
  await assert.rejects(pagedSearch(yt, 'far-query', { filter: 'song', hl: 'en', offset: 499, limit: 1,
    cacheNamespace: crypto.randomUUID() }), { code: 'YOUTUBE_PAGINATION_RESTART' });
  assert.equal(calls, 3);
  await assert.rejects(pagedSearch(yt, 'far-query', { filter: 'song', hl: 'en', offset: -1 }), { code: 'YOUTUBE_INVALID_PAGINATION' });
});

test('artist cached first shelf and browse continuation provide distinct subsequent tracks', async () => {
  let artistCalls = 0, firstShelfCalls = 0, continuationCalls = 0;
  const yt = { music: { async getArtist() { artistCalls++; return { header: { title: 'Singer' }, sections: [],
    async getAllSongs() { firstShelfCalls++; return { contents: [makeSong(0), makeSong(1)], continuation: 'fixed-cursor' }; } }; } },
  actions: { async execute(path, args) { continuationCalls++; assert.equal(path, '/browse');
    assert.equal(args.continuation, 'fixed-cursor'); assert.equal(args.client, 'YTMUSIC');
    return { continuation_contents: { contents: [makeSong(2), makeSong(3)], continuation: null } }; } } };
  const base = { hl: 'en', cacheNamespace: crypto.randomUUID(), limit: 2 };
  const first = await pagedArtist(yt, 'UCtest', base);
  assert.equal(first.songs.length, 2); assert.equal(first.hasMore, true);
  const second = await pagedArtist(yt, 'UCtest', { ...base, offset: 2 });
  assert.equal(second.songs[2].title, 'Song 2'); assert.equal(second.total, 4); assert.equal(second.hasMore, false);
  assert.equal(artistCalls, 1); assert.equal(firstShelfCalls, 1); assert.equal(continuationCalls, 1);
});
