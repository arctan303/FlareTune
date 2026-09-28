import { authenticatedFetch } from './authenticatedFetch.js';
import { getApiBaseUrl } from './apiBase.js';
import { hydratePlayableSong } from '../utils.js';
import { AUTH_SESSION_INVALIDATED_EVENT, AUTH_SESSION_UPDATED_EVENT } from '../authNavigation.js';

const ALBUM_DETAIL_TTL_MS = 5 * 60_000;
const ALBUM_DETAIL_CACHE_LIMIT = 40;
const albumDetailCache = new Map();

const clearAlbumDetailCache = () => albumDetailCache.clear();
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, clearAlbumDetailCache);
  window.addEventListener(AUTH_SESSION_UPDATED_EVENT, clearAlbumDetailCache);
  window.addEventListener('flaretune:catalog-song-updated', clearAlbumDetailCache);
  import.meta.hot?.dispose(() => {
    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, clearAlbumDetailCache);
    window.removeEventListener(AUTH_SESSION_UPDATED_EVENT, clearAlbumDetailCache);
    window.removeEventListener('flaretune:catalog-song-updated', clearAlbumDetailCache);
  });
}

async function read(path, signal) {
  const response = await authenticatedFetch(`${getApiBaseUrl()}${path}`, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`曲库请求失败（${response.status}）`);
  const body = await response.json();
  return body?.data || {};
}

export async function readCatalog(type, { query = '', language = '', artist = '', offset = 0, limit = 20, signal } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (query.trim()) params.set('q', query.trim());
  if (artist.trim()) params.set('artist', artist.trim());
  if (language && language !== 'all') params.set('language', language);
  if (type === 'songs') {
    if (!query.trim() && language && language !== 'all') {
      const page = Math.floor(offset / limit) + 1;
      const data = await read(`/api/songs?language=${encodeURIComponent(language)}&page=${page}&limit=${limit}`, signal);
      return { items: (data.songs || []).map(hydratePlayableSong).filter(Boolean), hasMore: Boolean(data.hasMore), total: data.total };
    }
    const data = await read(`/api/songs/search?${params}`, signal);
    const items = (data.songs || []).map(hydratePlayableSong).filter(Boolean);
    return { items, hasMore: items.length === limit, total: null };
  }
  const endpoint = type === 'artists' ? 'artists' : 'albums';
  const data = await read(`/api/${endpoint}?${params}`, signal);
  return { items: data[endpoint] || [], hasMore: Boolean(data.hasMore), total: data.total };
}

export async function readAlbum(id, signal) {
  const key = JSON.stringify([getApiBaseUrl(), id]);
  const cached = albumDetailCache.get(key);
  if (cached && Date.now() - cached.savedAt < ALBUM_DETAIL_TTL_MS) {
    albumDetailCache.delete(key);
    albumDetailCache.set(key, cached);
    return cached.album;
  }
  albumDetailCache.delete(key);
  const data = await read(`/api/albums/${encodeURIComponent(id)}`, signal);
  const album = { ...data, songs: (data.songs || []).map(hydratePlayableSong).filter(Boolean) };
  albumDetailCache.set(key, { album, savedAt: Date.now() });
  if (albumDetailCache.size > ALBUM_DETAIL_CACHE_LIMIT) {
    albumDetailCache.delete(albumDetailCache.keys().next().value);
  }
  return album;
}

export async function readArtist(name, { offset = 0, limit = 50, signal } = {}) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const data = await read(`/api/artists/${encodeURIComponent(name)}?${params}`, signal);
  return { ...data, songs: (data.songs || []).map(hydratePlayableSong).filter(Boolean) };
}
