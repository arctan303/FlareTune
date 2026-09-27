import { hydratePlayableSong } from './utils.js';
import { isValidSongLanguage } from './constants/language.js';
import { getApiBaseUrl } from './services/apiBase.js';
import { authenticatedFetch } from './services/authenticatedFetch.js';
import { useUIStore } from './store/useUIStore.js';

const normalizeSongIds = (values) => {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [id];
  });
};

export async function resolveSongs(songIds, {
  fetchImpl = globalThis.fetch,
  apiBase,
  hydrateSong = hydratePlayableSong,
  signal,
} = {}) {
  const normalizedIds = normalizeSongIds(songIds);
  if (normalizedIds.length === 0) return { songs: [], missingSongIds: [] };
  if (typeof fetchImpl !== 'function') throw new Error('歌曲解析服务不可用');

  const resolvedApiBase = apiBase ?? getApiBaseUrl();
  const csrfToken = useUIStore.getState().authSession?.csrfToken;
  const response = await authenticatedFetch(`${resolvedApiBase}/api/songs/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FlareTune',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    credentials: 'include',
    body: JSON.stringify({ song_ids: normalizedIds }),
    signal,
  }, fetchImpl);
  if (!response.ok) throw new Error(`歌曲解析失败（${response.status}）`);
  const payload = await response.json();
  if (payload?.code !== 200 || !Array.isArray(payload?.data?.songs)) throw new Error('歌曲解析数据格式无效');

  const songsById = new Map(payload.data.songs.map(hydrateSong).filter(Boolean).map((song) => [String(song.id), song]));
  const missingSet = new Set(Array.isArray(payload.data.missing_ids) ? payload.data.missing_ids.map(String) : []);
  for (const id of normalizedIds) if (!songsById.has(id)) missingSet.add(id);
  return {
    songs: normalizedIds.map((id) => songsById.get(id)).filter(Boolean),
    missingSongIds: normalizedIds.filter((id) => missingSet.has(id)),
  };
}

export const songHasValidLanguage = (song) => (
  Boolean(song) && typeof song === 'object' && isValidSongLanguage(song.language)
);

export const songsNeedLanguageRepair = (songs) => (
  Array.isArray(songs) && songs.some((song) => song?.id != null && !songHasValidLanguage(song))
);

/**
 * Only replaces songs whose language is missing/invalid. The server response is
 * authoritative, while unresolved songs remain in the queue without inventing a
 * language or falling back to legacy lyric flags.
 */
export async function repairSongLanguages(songs, resolveOptions = {}) {
  const sourceSongs = Array.isArray(songs) ? songs : [];
  const requestedIds = sourceSongs
    .filter((song) => song?.id != null && !songHasValidLanguage(song))
    .map((song) => String(song.id));

  if (requestedIds.length === 0) {
    return { songs: sourceSongs, repairedSongIds: [], unresolvedSongIds: [] };
  }

  const resolved = await resolveSongs(requestedIds, resolveOptions);
  const authoritativeById = new Map(
    resolved.songs
      .filter(songHasValidLanguage)
      .map((song) => [String(song.id), song]),
  );
  const repairedSongIds = [];
  const unresolvedSongIds = [];
  const repairedSongs = sourceSongs.map((song) => {
    if (song?.id == null || songHasValidLanguage(song)) return song;
    const id = String(song.id);
    const authoritative = authoritativeById.get(id);
    if (!authoritative) {
      unresolvedSongIds.push(id);
      return song;
    }
    repairedSongIds.push(id);
    return {
      ...song,
      ...authoritative,
    };
  });

  return {
    songs: repairedSongs,
    repairedSongIds,
    unresolvedSongIds: [...new Set([
      ...unresolvedSongIds,
      ...resolved.missingSongIds.map(String),
    ])],
  };
}

export function fillSongMetadata(song, { knownSongsMap, playerState } = {}) {
  if (!song || songHasValidLanguage(song)) return song;
  const id = String(song.id || '');
  if (!id) return song;

  const current = playerState?.currentSong;
  if (current && String(current.id) === id && isValidSongLanguage(current.language)) {
    return { ...song, language: current.language };
  }
  const inQueue = playerState?.playlist?.find((s) => String(s.id) === id && isValidSongLanguage(s.language));
  if (inQueue) {
    return { ...song, language: inQueue.language };
  }

  const known = knownSongsMap?.get(id);
  if (known && isValidSongLanguage(known.language)) {
    return { ...song, language: known.language };
  }

  return song;
}
