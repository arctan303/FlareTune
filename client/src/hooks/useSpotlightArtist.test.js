import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSpotlightExcludeParam,
  extractFallbackSpotlightArtist,
  getLocalTodayDateString,
  getStoredSpotlightCache,
  saveStoredSpotlightCache,
  SPOTLIGHT_ARTIST_STORAGE_KEY,
} from './useSpotlightArtist.js';

test('buildSpotlightExcludeParam formats comma-separated URL query param', () => {
  assert.equal(buildSpotlightExcludeParam([]), '');
  assert.equal(buildSpotlightExcludeParam(['周杰伦']), '?exclude=%E5%91%A8%E6%9D%B0%E4%BC%A6');
  assert.equal(buildSpotlightExcludeParam(['A', 'B']), '?exclude=A%2CB');
});

test('extractFallbackSpotlightArtist handles empty and null inputs safely', () => {
  assert.equal(extractFallbackSpotlightArtist(null), null);
  assert.equal(extractFallbackSpotlightArtist([]), null);
});

test('extractFallbackSpotlightArtist extracts rich artist and excludes junk names', () => {
  const songs = [
    { id: '1', title: 'Song 1', artist: '纯音乐', cover_url: '/c1.jpg' },
    { id: '2', title: 'Song 2', artist: '未知歌手', cover_url: '/c2.jpg' },
    { id: '3', title: 'Song 3', artist: '周杰伦', cover_url: '/c3.jpg' },
    { id: '4', title: 'Song 4', artist: '周杰伦', cover_url: '/c4.jpg' },
  ];
  const result = extractFallbackSpotlightArtist(songs);
  assert.ok(result);
  assert.equal(result.artist, '周杰伦');
  assert.equal(result.songs.length, 2);
  assert.equal(result.songCount, 2);
  assert.match(result.coverUrl, /c3\.jpg/);
});

test('getLocalTodayDateString formats date as YYYY-MM-DD and handles padding', () => {
  const specificDate = new Date(2026, 0, 5); // 2026-01-05
  assert.equal(getLocalTodayDateString(specificDate), '2026-01-05');

  const autumnDate = new Date(2026, 8, 18); // 2026-09-18
  assert.equal(getLocalTodayDateString(autumnDate), '2026-09-18');

  // 默认无参调用返回合法的当前日历字符串
  const todayStr = getLocalTodayDateString();
  assert.match(todayStr, /^\d{4}-\d{2}-\d{2}$/);
});

function createMockStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, val) {
      store.set(key, String(val));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

test('getStoredSpotlightCache returns null when storage is missing or invalid', () => {
  assert.equal(getStoredSpotlightCache(null), null);

  const mock = createMockStorage();
  assert.equal(getStoredSpotlightCache(mock), null);

  mock.setItem(SPOTLIGHT_ARTIST_STORAGE_KEY, 'invalid json');
  assert.equal(getStoredSpotlightCache(mock), null);

  mock.setItem(SPOTLIGHT_ARTIST_STORAGE_KEY, JSON.stringify({ date: '2026-09-18', data: {} }));
  assert.equal(getStoredSpotlightCache(mock), null);
});

test('saveStoredSpotlightCache writes valid payload and getStoredSpotlightCache reads it back', () => {
  const mock = createMockStorage();
  const sampleData = {
    artist: '林俊杰',
    songs: [{ id: 's1', title: '江南' }],
    coverUrl: '/covers/jj.jpg',
    photoUrl: '/photos/jj.webp',
    songCount: 1,
  };

  saveStoredSpotlightCache(sampleData, '2026-09-18', mock);

  const cached = getStoredSpotlightCache(mock);
  assert.ok(cached);
  assert.equal(cached.date, '2026-09-18');
  assert.equal(cached.data.artist, '林俊杰');
  assert.equal(cached.data.coverUrl, '/covers/jj.jpg');
  assert.equal(cached.data.photoUrl, '/photos/jj.webp');
  assert.equal(cached.data.songCount, 1);
  assert.equal(cached.data.songs.length, 1);
});

test('natural day cache detects day change correctly', () => {
  const mock = createMockStorage();
  const yesterday = '2026-09-17';
  const today = '2026-09-18';

  // 模拟昨天保存了缓存
  saveStoredSpotlightCache({ artist: '陶喆', songs: [] }, yesterday, mock);

  const cached = getStoredSpotlightCache(mock);
  assert.ok(cached);
  assert.equal(cached.date, yesterday);

  // 跨天判断：缓存日期与今日不同，判定已失效需重新拉取
  const isCacheFreshForToday = cached.date === today;
  assert.equal(isCacheFreshForToday, false);

  // 手动更新或隔天拉取后存入新的一天
  saveStoredSpotlightCache({ artist: '周杰伦', songs: [] }, today, mock);
  const updatedCache = getStoredSpotlightCache(mock);
  assert.equal(updatedCache.date, today);
  assert.equal(updatedCache.data.artist, '周杰伦');
  assert.equal(updatedCache.date === today, true);
});

