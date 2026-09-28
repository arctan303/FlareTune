import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylistPayloadLoader } from './playlistPayloadLoader.js';
import { createExpiringAsyncCache } from '../utils/expiringAsyncCache.js';

const jsonResponse = (data, status = 200) => new Response(JSON.stringify({
  code: status === 200 ? 200 : status,
  data,
}), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const createLoader = (overrides = {}) => createPlaylistPayloadLoader({
  getApiBaseUrl: () => 'https://music-api.example',
  getAuthenticated: () => false,
  hydrateSong: (song) => song && ({ ...song, hydrated: true }),
  loadMemberDetail: async () => {
    throw new Error('member detail was not expected');
  },
  fetchImpl: async () => {
    throw new Error('fetch was not expected');
  },
  ...overrides,
});

test('member playlists load account detail without HTTP or shared-cache mediation', async () => {
  let detailCalls = 0;
  const createdAt = new Date(2024, 0, 2).getTime();
  const loadPlaylistPayload = createLoader({
    loadMemberDetail: async (id) => {
      detailCalls += 1;
      assert.equal(id, 'member-1');
      return {
        id,
        name: '我的歌单',
        description: '个人描述',
        createdAt,
        songs: [{ id: 'song-1' }, null],
      };
    },
  });

  const payload = await loadPlaylistPayload(
    { id: 'member-1', name: '旧标题', source: 'member' },
    { name: ' Alice ' },
  );
  assert.equal(detailCalls, 1);
  assert.deepEqual(payload.playlist, {
    id: 'member-1',
    name: '我的歌单',
    source: 'member',
    description: '个人描述',
    createdAt,
    songs: [{ id: 'song-1' }, null],
  });
  assert.deepEqual(payload.songs, [{ id: 'song-1', hydrated: true }]);
  assert.deepEqual(payload.info, {
    description: '个人描述',
    creator: 'Alice',
    createdAt: '2024-01-02',
  });
});

test('library and lang playlists keep the login gate, request shape, hydration, and payload contract', async () => {
  let authenticated = false;
  const requests = [];
  const loadPlaylistPayload = createLoader({
    getAuthenticated: () => authenticated,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        songs: [{ id: 'song-1', cover_url: 'cover/one.jpg' }, null],
        total: 12,
        hasMore: true,
      });
    },
  });
  const playlist = {
    id: 'library-custom',
    name: '旧标题',
    type: 'library',
    langKey: 'zh Hans',
    page: 2,
    limit: 15,
    sort: 'asc',
    cover_url: 'cover/fallback.jpg',
  };

  await assert.rejects(
    loadPlaylistPayload(playlist, null),
    /曲库探索仅对登录用户开放，请先登录/,
  );
  assert.equal(requests.length, 0);

  authenticated = true;
  const payload = await loadPlaylistPayload(playlist, null);
  assert.deepEqual(requests, [{
    url: 'https://music-api.example/api/songs?language=zh%20Hans&page=2&limit=15&sort=asc',
    init: { credentials: 'include', cache: 'no-store' },
  }]);
  assert.deepEqual(payload.songs, [{ id: 'song-1', cover_url: 'cover/one.jpg', hydrated: true }]);
  assert.deepEqual(payload.playlist, {
    ...playlist,
    id: 'lang-zh Hans',
    name: 'zh Hans歌曲',
    type: 'library',
    langKey: 'zh Hans',
    cover_url: 'cover/one.jpg',
    previewCovers: ['cover/one.jpg'],
    pagination: {
      total: 12,
      page: 2,
      pageSize: 15,
      hasMore: true,
      sort: 'asc',
      langKey: 'zh Hans',
    },
  });
  assert.deepEqual(payload.info, {
    description: '全库共收录 12 首zh Hans歌曲 · 支持新旧排序与单曲收听',
    creator: '官方曲库',
    createdAt: '按最早收录',
  });

  const languagePayload = await loadPlaylistPayload({ id: 'lang-en' }, null);
  assert.equal(requests[1].url, 'https://music-api.example/api/songs?language=en&page=1&limit=30&sort=desc');
  assert.deepEqual(requests[1].init, { credentials: 'include', cache: 'no-store' });
  assert.equal(languagePayload.playlist.id, 'lang-en');
  assert.equal(languagePayload.playlist.name, '英语歌曲');
  assert.equal(languagePayload.playlist.pagination.sort, 'desc');
});

test('opening a fresh language playlist does not revalidate; expiry and account change do', async () => {
  let clock = 0;
  let accountId = 'account-a';
  let requests = 0;
  const cache = createExpiringAsyncCache({ ttlMs: 300_000, now: () => clock });
  const loadPlaylistPayload = createLoader({
    cache,
    getAuthenticated: () => true,
    getAccountId: () => accountId,
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({ songs: [{ id: `song-${requests}` }], total: 1, hasMore: false });
    },
  });
  const open = () => loadPlaylistPayload({ id: 'lang-en' }, null,
    { revalidate: true, staleWhileRevalidate: true });

  assert.equal((await open()).songs[0].id, 'song-1');
  assert.equal((await open()).songs[0].id, 'song-1');
  assert.equal(requests, 1);
  clock = 300_001;
  assert.equal((await open()).songs[0].id, 'song-2');
  accountId = 'account-b';
  assert.equal((await open()).songs[0].id, 'song-3');
  assert.equal(requests, 3);
});

test('identity revalidation bypasses a fresh language playlist cache', async () => {
  let requests = 0;
  const cache = createExpiringAsyncCache({ ttlMs: 300_000, now: () => 0 });
  const loadPlaylistPayload = createLoader({
    cache,
    getAuthenticated: () => true,
    getAccountId: () => 'account-a',
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse({ songs: [{ id: `song-${requests}` }], total: 1, hasMore: false });
    },
  });
  assert.equal((await loadPlaylistPayload({ id: 'lang-en' }, null)).songs[0].id, 'song-1');
  assert.equal((await loadPlaylistPayload({ id: 'lang-en' }, null, { revalidate: true }))
    .songs[0].id, 'song-2');
  assert.equal(requests, 2);
});

test('preloaded and inline song payloads bypass auth, HTTP, hydration, and cache work', async () => {
  const preloadedSongs = [{ id: 'preloaded' }];
  const inlineSongs = [{ id: 'inline' }];
  const loadPlaylistPayload = createLoader();

  const preloaded = await loadPlaylistPayload({
    id: 'daily',
    preloadedSongs,
    description: '每日描述',
    creator: '推荐者',
  }, null);
  assert.equal(preloaded.songs, preloadedSongs);
  assert.deepEqual(preloaded.info, { description: '每日描述', creator: '推荐者' });

  const inline = await loadPlaylistPayload({ id: 'inline', songs: inlineSongs }, null);
  assert.equal(inline.songs, inlineSongs);
  assert.equal(inline.info, null);
});

test('unknown playlists never request the removed shared playlist endpoint', async () => {
  const loadPlaylistPayload = createLoader();
  await assert.rejects(loadPlaylistPayload({ id: 'unknown' }, null), /歌单不存在/);
});
