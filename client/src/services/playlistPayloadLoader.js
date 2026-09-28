import { accountPlaylistsStore } from '../accountPlaylists.js';
import { useUIStore } from '../store/useUIStore.js';
import { hydrateSong } from '../utils.js';
import {
  createExpiringAsyncCache,
  revalidateExpiringCache,
} from '../utils/expiringAsyncCache.js';
import { getApiBaseUrl } from './apiBase.js';
import { authenticatedFetch } from './authenticatedFetch.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const libraryPayloadCache = createExpiringAsyncCache({ ttlMs: CACHE_TTL_MS });

export const invalidateLibraryPayloadCache = () => libraryPayloadCache.clear();
if (typeof window !== 'undefined') {
  window.addEventListener('flaretune:catalog-song-updated', invalidateLibraryPayloadCache);
}

const formatDate = (ts) => {
  if (!ts) return '';
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const createMemberPlaylistInfo = (playlist, currentUser) => ({
  description: playlist?.description || '',
  creator: currentUser?.name?.trim() || '用户',
  createdAt: formatDate(playlist?.createdAt),
});

export const createPlaylistPayloadLoader = ({
  getApiBaseUrl: resolveApiBase = getApiBaseUrl,
  getAuthenticated = () => Boolean(useUIStore.getState().authSession?.authenticated),
  getAccountId = () => useUIStore.getState().authSession?.user?.accountId || null,
  hydrateSong: hydrate = hydrateSong,
  loadMemberDetail = (id) => accountPlaylistsStore.getState().loadDetail(id),
  fetchImpl = (url, init) => fetch(url, init),
  cache = libraryPayloadCache,
} = {}) => async (
  playlist,
  currentUser,
  { revalidate = false, staleWhileRevalidate = false, onRefresh = null } = {},
) => {
  if (playlist.source === 'member') {
    const detail = await loadMemberDetail(playlist.id);
    return {
      playlist: { ...playlist, ...detail, source: 'member' },
      songs: (detail.songs || []).map((song) => hydrate(song)).filter(Boolean),
      info: createMemberPlaylistInfo(detail, currentUser),
    };
  }
  if (playlist.type === 'library' || playlist.id?.startsWith('lang-')) {
    const isAuthed = getAuthenticated();
    if (!isAuthed) {
      throw new Error('曲库探索仅对登录用户开放，请先登录');
    }
    const langKey = playlist.langKey || playlist.id.replace('lang-', '');
    const sort = playlist.sort || 'desc';
    const page = playlist.page || 1;
    const limit = playlist.limit || 30;
    const apiBase = resolveApiBase();
    const cacheKey = JSON.stringify([apiBase, getAccountId(), langKey, sort, page, limit]);
    const loader = async () => {
      const apiUrl = `${apiBase}/api/songs?language=${encodeURIComponent(langKey)}&page=${page}&limit=${limit}&sort=${sort}`;
      const response = await authenticatedFetch(apiUrl, { credentials: 'include', cache: 'no-store' }, fetchImpl);
      if (!response.ok) throw new Error(`曲库加载失败（${response.status}）`);
      const json = await response.json();
      if (json.code !== 200 || !json.data) throw new Error('曲库数据格式无效');
      const rawSongs = json.data.songs || [];
      const songs = rawSongs.map((songObj) => hydrate(songObj)).filter(Boolean);
      const langLabelMap = { zh: '中文', en: '英语', ja: '日语', ko: '韩语', instrumental: '纯音乐', other: '其他' };
      const label = langLabelMap[langKey] || langKey;
      const total = json.data.total != null ? json.data.total : songs.length;
      const hasMore = Boolean(json.data.hasMore);
      return {
        playlist: {
          ...playlist,
          id: `lang-${langKey}`,
          name: `${label}歌曲`,
          type: 'library',
          langKey,
          cover_url: songs[0]?.cover_url || playlist.cover_url,
          previewCovers: songs.slice(0, 4).map((song) => song.cover_url).filter(Boolean),
          pagination: {
            total,
            page,
            pageSize: limit,
            hasMore,
            sort,
            langKey,
          },
        },
        songs,
        info: {
          description: `全库共收录 ${total} 首${label}歌曲 · 支持新旧排序与单曲收听`,
          creator: '官方曲库',
          createdAt: sort === 'desc' ? '按最新收录' : '按最早收录',
        },
      };
    };
    if (!revalidate) return cache.load(cacheKey, loader);
    // Navigation can reuse a fresh value. Identity changes pass required
    // revalidation without staleWhileRevalidate and still fetch from D1.
    const fresh = staleWhileRevalidate ? cache.peek(cacheKey) : null;
    if (fresh !== null) return fresh;
    return revalidateExpiringCache(cache, cacheKey, loader, {
      staleWhileRevalidate,
      onRefresh,
    });
  }
  if (playlist.preloadedSongs) {
    return {
      songs: playlist.preloadedSongs,
      info: playlist.info || (playlist.description ? {
        description: playlist.description,
        creator: playlist.creator || '每日推荐',
      } : null),
    };
  }
  if (playlist.songs) {
    return {
      songs: playlist.songs,
      info: null,
    };
  }

  throw new Error('歌单不存在');
};

export const loadPlaylistPayload = createPlaylistPayloadLoader();
