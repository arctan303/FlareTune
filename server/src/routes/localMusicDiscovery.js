import { readBoundedJson, RequestBodyError } from '../instance/httpSecurity.js';
import { buildSongLanguageFilter } from '../utils/songLanguage.js';
import { runtimeSongColumns } from '../utils/songProjection.js';
import { createRoamSampler } from '../services/roamSampler.js';

const roamSampler = createRoamSampler();

const SONG_COLUMNS = runtimeSongColumns('s');
const MAX_ID_LENGTH = 80;
const MAX_RESOLVE_IDS = 500;
const MAX_SEEN_IDS = 5000;
const MAX_BATCH = 50;

const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
});
const success = (data, headers) => json({ code: 200, data }, 200, headers);
const invalid = (message, headers) => json({ code: 400, message }, 400, headers);
const rows = (result) => result?.results || [];

function parseBatch(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/u.test(String(value))) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_BATCH ? limit : null;
}

function normalizeIds(values, max) {
  if (!Array.isArray(values) || values.length > max) return null;
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) return null;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function parseCommaList(raw, maxItems, maxLength, maxQueryLength) {
  if (raw === null || raw === '') return [];
  if (raw.length > maxQueryLength) return null;
  const values = raw.split(',');
  if (values.length > maxItems) return null;
  const unique = new Map();
  for (const value of values) {
    const item = value.trim();
    if (!item || item.length > maxLength || /[\u0000-\u001f\u007f]/u.test(item)) return null;
    unique.set(item.toLocaleLowerCase(), item);
  }
  return [...unique.values()];
}

async function bodyJson(request, headers, maxBytes) {
  try {
    return { body: await readBoundedJson(request, maxBytes) };
  } catch (error) {
    if (error instanceof RequestBodyError) return { response: invalid(error.code, headers) };
    throw error;
  }
}

async function randomSongs(url, db, headers) {
  const limit = parseBatch(url.searchParams.get('limit'), 20);
  const exclude = parseCommaList(url.searchParams.get('exclude'), 20, MAX_ID_LENGTH, 1000);
  if (limit === null || exclude === null) return invalid('Invalid random parameters', headers);
  const diversity = exclude.length
    ? `CASE WHEN s.id IN (${exclude.map(() => '?').join(',')}) THEN 1 ELSE 0 END, `
    : '';
  const songs = rows(await db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs s
    WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
    ORDER BY ${diversity}RANDOM() LIMIT ?`).bind(...exclude, limit).all());
  return success({ songs }, headers);
}

async function resolveSongs(request, db, headers) {
  const parsed = await bodyJson(request, headers, 64 * 1024);
  if (parsed.response) return parsed.response;
  const ids = normalizeIds(parsed.body.song_ids, MAX_RESOLVE_IDS);
  if (!ids || ids.length === 0) return invalid(`song_ids must contain 1-${MAX_RESOLVE_IDS} valid IDs`, headers);
  const found = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const songs = rows(await db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs s
      WHERE s.id IN (${chunk.map(() => '?').join(',')})
        AND s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''`).bind(...chunk).all());
    for (const song of songs) found.set(song.id, song);
  }
  return success({
    songs: ids.map((id) => found.get(id)).filter(Boolean),
    missing_ids: ids.filter((id) => !found.has(id)),
  }, headers);
}

async function roamSongs(request, db, headers) {
  const parsed = await bodyJson(request, headers, 1024 * 1024);
  if (parsed.response) return parsed.response;
  if (parsed.body.strategy === 'recent') {
    const recent = normalizeIds(parsed.body.recentSongIds, MAX_SEEN_IDS);
    const queued = normalizeIds(parsed.body.queuedSongIds, MAX_SEEN_IDS);
    const limit = parseBatch(parsed.body.limit, 10);
    const language = parsed.body.language ?? 'all';
    if (!recent || !queued || limit === null || typeof language !== 'string'
      || !buildSongLanguageFilter(language === 'all' ? null : language)) return invalid('Invalid roam parameters', headers);
    const result = await roamSampler.sample(db, { recent, queued, limit, language });
    return success({ songs: result.songs, strategy: 'recent', language, limit,
      totalPlayable: result.rangeSize, remainingPlayable: Math.max(0, result.eligible - result.songs.length),
      recentWindow: result.windowSize, relaxed: result.relaxed,
      // A full queue is temporary; playing it makes older songs eligible again.
      exhausted: result.rangeSize === 0 || (result.songs.length === 0 && queued.length <= 1 && !result.stale),
    }, headers);
  }
  const seenIds = normalizeIds(parsed.body.seenSongIds, MAX_SEEN_IDS);
  const limit = parseBatch(parsed.body.limit ?? parsed.body.batchSize, 10);
  const language = parsed.body.language === undefined || parsed.body.language === 'all'
    ? null : parsed.body.language;
  if (!seenIds || limit === null || (language !== null && (typeof language !== 'string' || !language.trim()))) {
    return invalid('Invalid roam parameters', headers);
  }
  const filter = language ? buildSongLanguageFilter(language) : { sql: '', bindings: [] };
  if (!filter) return invalid('invalid_language', headers);
  const clause = filter.sql ? `AND ${filter.sql}` : '';
  const playable = rows(await db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs s
    WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> '' ${clause}
    ORDER BY RANDOM()`).bind(...filter.bindings).all());
  const seen = new Set(seenIds);
  const unseen = playable.filter((song) => !seen.has(String(song.id)));
  const songs = unseen.slice(0, limit);
  const remainingPlayable = unseen.length - songs.length;
  return success({
    songs, language: language || 'all', limit,
    totalPlayable: playable.length,
    seenPlayable: playable.length - unseen.length,
    remainingPlayable,
    exhausted: remainingPlayable === 0,
  }, headers);
}

async function spotlightArtist(url, db, headers) {
  const exclude = parseCommaList(url.searchParams.get('exclude'), 20, 100, 1000);
  if (exclude === null) return invalid('Invalid artist exclusions', headers);
  const candidateSql = (withExclude) => `SELECT s.artist, COUNT(*) AS song_count FROM Songs s
    WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
      AND s.artist IS NOT NULL AND TRIM(s.artist) <> ''
      AND s.artist NOT IN ('纯音乐', '未知歌手', '群星')
      AND s.artist NOT LIKE '%纯音乐%' AND s.artist NOT LIKE '%未知%'
      ${withExclude ? `AND s.artist NOT IN (${exclude.map(() => '?').join(',')})` : ''}
    GROUP BY s.artist ORDER BY CASE WHEN COUNT(*) >= 2 THEN 0 ELSE 1 END, RANDOM() LIMIT 1`;
  const candidate = exclude.length
    ? await db.prepare(candidateSql(true)).bind(...exclude).first() : null;
  const selected = candidate || await db.prepare(candidateSql(false)).first();
  if (!selected) return success(null, headers);
  const songs = rows(await db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs s
    WHERE s.artist = ? AND s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
    ORDER BY s.id ASC`).bind(selected.artist).all());
  const photo = await db.prepare('SELECT photo_url, photos FROM Artist_Photos WHERE artist_name = ?').bind(selected.artist).first();
  let photoUrl = typeof photo?.photo_url === 'string' ? photo.photo_url : '';
  if (!photoUrl && photo?.photos) {
    try {
      const parsed = JSON.parse(photo.photos);
      if (Array.isArray(parsed) && typeof parsed[0]?.url === 'string') photoUrl = parsed[0].url;
    } catch { /* malformed optional photo metadata is not song data */ }
  }
  return success({
    artist: selected.artist,
    songCount: Number(selected.song_count) || songs.length,
    songs,
    photoUrl,
    coverUrl: songs.find((song) => song.cover_url)?.cover_url || '',
  }, headers);
}

// The outer router must verify a normal local-account session before calling this.
// Requiring the account ID again keeps accidental direct invocation closed.
export async function handleLocalMusicDiscoveryRoute(request, url, db, headers = {}, accountId) {
  const { pathname } = url;
  const isRandom = pathname === '/api/songs/random' && request.method === 'GET';
  const isResolve = pathname === '/api/songs/resolve' && request.method === 'POST';
  const isRoam = pathname === '/api/songs/roam' && request.method === 'POST';
  const isSpotlight = pathname === '/api/songs/spotlight-artist' && request.method === 'GET';
  if (!isRandom && !isResolve && !isRoam && !isSpotlight) return null;
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return json({ code: 401, message: 'Authentication required' }, 401, headers);
  }
  if (!db?.prepare) return json({ code: 503, message: 'Database unavailable' }, 503, headers);
  if (isRandom) return randomSongs(url, db, headers);
  if (isResolve) return resolveSongs(request, db, headers);
  if (isRoam) return roamSongs(request, db, headers);
  return spotlightArtist(url, db, headers);
}
