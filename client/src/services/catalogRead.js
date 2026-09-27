import { authenticatedFetch } from './authenticatedFetch.js';
import { getApiBaseUrl } from './apiBase.js';
import { hydratePlayableSong } from '../utils.js';

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
  const data = await read(`/api/albums/${encodeURIComponent(id)}`, signal);
  return { ...data, songs: (data.songs || []).map(hydratePlayableSong).filter(Boolean) };
}

export async function readArtist(name, { offset = 0, limit = 50, signal } = {}) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const data = await read(`/api/artists/${encodeURIComponent(name)}?${params}`, signal);
  return { ...data, songs: (data.songs || []).map(hydratePlayableSong).filter(Boolean) };
}
