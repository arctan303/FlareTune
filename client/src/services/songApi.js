import { getApiBaseUrl } from './apiBase.js';
import { authenticatedFetch } from './authenticatedFetch.js';

export class SongFetchError extends Error {
  constructor(status) {
    super(`song fetch failed (${status})`);
    this.name = 'SongFetchError';
    this.status = status;
  }
}

export async function fetchSongById(songId, {
  apiBase,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedId = String(songId || '').trim();
  if (!normalizedId) return null;

  const resolvedBase = String(apiBase ?? getApiBaseUrl()).replace(/\/$/, '');
  const response = await authenticatedFetch(`${resolvedBase}/api/songs/${encodeURIComponent(normalizedId)}`, {
    credentials: 'include',
    cache: 'no-store',
  }, fetchImpl);

  if (!response.ok) throw new SongFetchError(response.status);

  const payload = await response.json();
  const song = payload?.code === 200 && payload?.data && !Array.isArray(payload.data)
    ? payload.data
    : null;
  return song?.id ? song : null;
}
