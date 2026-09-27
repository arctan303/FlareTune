import { parseArtistNames } from '../utils/artistParser.js';
import { buildSongLanguageFilter } from '../utils/songLanguage.js';
import { runtimeSongColumns } from '../utils/songProjection.js';

const MAX_NAME_LENGTH = 300;
const MAX_ALBUM_ID_LENGTH = 3200;
const MAX_GROUP_SCAN = 10000;
const MAX_ARTIST_CREDITS = 200;
const PLAYABLE = "s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''";
const HAS_ALBUM = "s.album IS NOT NULL AND TRIM(s.album) <> '' AND s.artist IS NOT NULL AND TRIM(s.artist) <> ''";
const SONG_COLUMNS = runtimeSongColumns('s');

const rows = (result) => result?.results || [];
const json = (body, status, headers) => new Response(JSON.stringify(body), {
  status,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
});
const success = (data, headers) => json({ code: 200, data }, 200, headers);
const invalid = (message, headers) => json({ code: 400, message }, 400, headers);
const tooLarge = (headers) => json({ code: 503, message: 'Catalog read view is too large' }, 503, headers);

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= MAX_NAME_LENGTH && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

function pageParams(url) {
  const parse = (value, fallback, min, max) => {
    if (value === null) return fallback;
    if (!/^\d+$/u.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
  };
  const limit = parse(url.searchParams.get('limit'), 20, 1, 50);
  const offset = parse(url.searchParams.get('offset'), 0, 0, 2000);
  return limit === null || offset === null ? null : { limit, offset };
}

function languageFilter(url) {
  const language = url.searchParams.get('language') || '';
  if (language.length > 100) return null;
  const filter = buildSongLanguageFilter(language);
  return filter ? { ...filter, language } : null;
}

export function encodeAlbumId(artist, album) {
  const bytes = new TextEncoder().encode(JSON.stringify([artist, album]));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function decodeAlbumId(id) {
  if (!id || id.length > MAX_ALBUM_ID_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(id)) return null;
  try {
    const bytes = Uint8Array.from(atob(id.replace(/-/gu, '+').replace(/_/gu, '/')), (char) => char.charCodeAt(0));
    const pair = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const artist = cleanName(pair[0]);
    const album = cleanName(pair[1]);
    return artist && album && encodeAlbumId(artist, album) === id ? { artist, album } : null;
  } catch {
    return null;
  }
}

function albumCard(row) {
  return {
    id: encodeAlbumId(row.artist, row.album),
    title: row.album,
    artist: row.artist,
    coverUrl: row.cover_url || '',
    trackCount: Number(row.track_count || 0),
    matchingTrackCount: Number(row.matching_track_count ?? row.track_count ?? 0),
  };
}

function creditsInclude(credit, requested) {
  return parseArtistNames(credit).some((name) => name.toLocaleLowerCase() === requested.toLocaleLowerCase());
}

function isAscii(value) {
  return /^[\x00-\x7f]*$/u.test(value);
}

async function artistCredits(db, name) {
  const prefilter = isAscii(name) ? 'AND INSTR(LOWER(s.artist), LOWER(?)) > 0' : '';
  const candidates = rows(await db.prepare(`SELECT DISTINCT TRIM(s.artist) AS credit FROM Songs s
    WHERE ${PLAYABLE} AND s.artist IS NOT NULL AND TRIM(s.artist) <> '' ${prefilter}
    LIMIT ?`).bind(...(prefilter ? [name] : []), MAX_GROUP_SCAN + 1).all());
  if (candidates.length > MAX_GROUP_SCAN) return null;
  const matched = candidates.map((row) => row.credit).filter((credit) => creditsInclude(credit, name));
  return matched.length <= MAX_ARTIST_CREDITS ? matched : null;
}

async function enrichAlbumPage(db, pageKeys) {
  if (!pageKeys.length) return [];
  const clause = pageKeys.map(() => '(TRIM(s.artist) = ? AND TRIM(s.album) = ?)').join(' OR ');
  const result = rows(await db.prepare(`SELECT TRIM(s.artist) AS artist, TRIM(s.album) AS album,
    COUNT(*) AS track_count,
    (SELECT t.cover_url FROM Songs t WHERE t.audio_url IS NOT NULL AND TRIM(t.audio_url) <> ''
      AND TRIM(t.artist) = TRIM(s.artist) AND TRIM(t.album) = TRIM(s.album)
      AND t.cover_url IS NOT NULL AND TRIM(t.cover_url) <> ''
      ORDER BY CASE WHEN t.created_at IS NULL THEN 1 ELSE 0 END, t.created_at, t.id LIMIT 1) AS cover_url
    FROM Songs s WHERE ${PLAYABLE} AND (${clause})
    GROUP BY TRIM(s.artist), TRIM(s.album)`)
    .bind(...pageKeys.flatMap((row) => [row.artist, row.album])).all());
  const full = new Map(result.map((row) => [JSON.stringify([row.artist, row.album]), row]));
  return pageKeys.flatMap((key) => {
    const row = full.get(JSON.stringify([key.artist, key.album]));
    return row ? [albumCard({ ...row, matching_track_count: key.matching_track_count })] : [];
  });
}

async function listAlbums(db, url, headers) {
  const page = pageParams(url);
  const filter = languageFilter(url);
  const rawArtist = url.searchParams.get('artist');
  const artist = rawArtist?.trim() ? cleanName(rawArtist) : null;
  const rawQuery = url.searchParams.get('q');
  const query = rawQuery?.trim() ? cleanName(rawQuery) : null;
  if (!page || !filter || (rawArtist?.trim() && !artist) || (rawQuery?.trim() && !query)) {
    return invalid('Invalid album parameters', headers);
  }
  const where = [PLAYABLE, HAS_ALBUM];
  const bindings = [];
  if (filter.sql) { where.push(filter.sql); bindings.push(...filter.bindings); }
  if (artist) {
    const credits = await artistCredits(db, artist);
    if (!credits) return tooLarge(headers);
    if (!credits.length) return success({ albums: [], total: 0, ...page, hasMore: false }, headers);
    where.push(`TRIM(s.artist) IN (${credits.map(() => '?').join(',')})`);
    bindings.push(...credits);
  }
  if (query && isAscii(query)) {
    where.push('(INSTR(LOWER(s.album), LOWER(?)) > 0 OR INSTR(LOWER(s.artist), LOWER(?)) > 0)');
    bindings.push(query, query);
  }
  const grouped = `FROM Songs s WHERE ${where.join(' AND ')} GROUP BY TRIM(s.artist), TRIM(s.album)`;
  const selectKeys = `SELECT TRIM(s.artist) AS artist, TRIM(s.album) AS album,
    COUNT(*) AS matching_track_count ${grouped}`;
  const order = 'ORDER BY matching_track_count DESC, album COLLATE NOCASE, artist COLLATE NOCASE';
  let pageKeys;
  let total;
  if (query && !isAscii(query)) {
    // SQLite's built-in LOWER only folds ASCII. Keep the Unicode fallback
    // bounded and enrich only the selected page after JavaScript case folding.
    const candidates = rows(await db.prepare(`${selectKeys} ${order} LIMIT ?`)
      .bind(...bindings, MAX_GROUP_SCAN + 1).all());
    if (candidates.length > MAX_GROUP_SCAN) return tooLarge(headers);
    const folded = query.toLocaleLowerCase();
    const matched = candidates.filter((row) => row.album.toLocaleLowerCase().includes(folded)
      || row.artist.toLocaleLowerCase().includes(folded));
    total = matched.length;
    pageKeys = matched.slice(page.offset, page.offset + page.limit);
  } else {
    const [count, result] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS total FROM (SELECT 1 ${grouped})`).bind(...bindings).first(),
      db.prepare(`${selectKeys} ${order} LIMIT ? OFFSET ?`)
        .bind(...bindings, page.limit, page.offset).all(),
    ]);
    total = Number(count?.total || 0);
    pageKeys = rows(result);
  }
  return success({ albums: await enrichAlbumPage(db, pageKeys), total, ...page,
    hasMore: page.offset + pageKeys.length < total }, headers);
}

async function albumDetail(db, id, headers) {
  const identity = decodeAlbumId(id);
  if (!identity) return invalid('Invalid album ID', headers);
  const songs = rows(await db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs s
    WHERE ${PLAYABLE} AND TRIM(s.artist) = ? AND TRIM(s.album) = ?
    ORDER BY CASE WHEN s.created_at IS NULL THEN 1 ELSE 0 END, s.created_at, s.id`)
    .bind(identity.artist, identity.album).all());
  if (!songs.length) return json({ code: 404, message: 'Album not found' }, 404, headers);
  const card = albumCard({ ...identity, track_count: songs.length,
    cover_url: songs.find((song) => song.cover_url)?.cover_url || '' });
  return success({ ...card, songs }, headers);
}

async function listArtists(db, url, headers) {
  const page = pageParams(url);
  const filter = languageFilter(url);
  const rawQuery = url.searchParams.get('q');
  const query = rawQuery?.trim() ? cleanName(rawQuery) : null;
  if (!page || !filter || (rawQuery?.trim() && !query)) return invalid('Invalid artist parameters', headers);
  const where = [PLAYABLE, "s.artist IS NOT NULL AND TRIM(s.artist) <> ''"];
  const bindings = [];
  if (filter.sql) { where.push(filter.sql); bindings.push(...filter.bindings); }
  const grouped = rows(await db.prepare(`SELECT TRIM(s.artist) AS credit,
    COALESCE(TRIM(s.album), '') AS album, COUNT(*) AS song_count,
    MAX(NULLIF(TRIM(s.cover_url), '')) AS cover_url
    FROM Songs s WHERE ${where.join(' AND ')} GROUP BY TRIM(s.artist), COALESCE(TRIM(s.album), '')
    LIMIT ?`).bind(...bindings, MAX_GROUP_SCAN + 1).all());
  if (grouped.length > MAX_GROUP_SCAN) return tooLarge(headers);
  const byName = new Map();
  for (const row of grouped) {
    for (const name of parseArtistNames(row.credit)) {
      const key = name.toLocaleLowerCase();
      let item = byName.get(key);
      if (!item) {
        item = { name, songCount: 0, albums: new Set(), coverUrl: '' };
        byName.set(key, item);
      }
      item.songCount += Number(row.song_count || 0);
      if (row.album) item.albums.add(JSON.stringify([row.credit, row.album]));
      if (!item.coverUrl && row.cover_url) item.coverUrl = row.cover_url;
    }
  }
  const matched = [...byName.values()].filter((item) => !query
    || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => b.songCount - a.songCount || a.name.localeCompare(b.name));
  const artists = matched.slice(page.offset, page.offset + page.limit);
  const photos = artists.length ? rows(await db.prepare(`SELECT artist_name, photo_url FROM Artist_Photos
    WHERE artist_name IN (${artists.map(() => '?').join(',')})`)
    .bind(...artists.map((row) => row.name)).all()) : [];
  const photoByName = new Map(photos.map((row) => [row.artist_name, row.photo_url || '']));
  const total = matched.length;
  return success({ artists: artists.map((row) => ({
    name: row.name, songCount: row.songCount, albumCount: row.albums.size,
    photoUrl: photoByName.get(row.name) || '', coverUrl: row.cover_url || '',
  })), total, ...page, hasMore: page.offset + artists.length < total }, headers);
}

async function artistDetail(db, url, encodedName, headers) {
  let name;
  try { name = cleanName(decodeURIComponent(encodedName)); } catch { name = null; }
  const page = pageParams(url);
  if (!name || !page) return invalid('Invalid artist parameters', headers);
  const credits = await artistCredits(db, name);
  if (!credits) return tooLarge(headers);
  if (!credits.length) return json({ code: 404, message: 'Artist not found' }, 404, headers);
  const where = `${PLAYABLE} AND TRIM(s.artist) IN (${credits.map(() => '?').join(',')})`;
  const [count, result, cover, photo] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM Songs s WHERE ${where}`).bind(...credits).first(),
    db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs s WHERE ${where}
      ORDER BY s.title COLLATE NOCASE, s.id LIMIT ? OFFSET ?`)
      .bind(...credits, page.limit, page.offset).all(),
    db.prepare(`SELECT s.cover_url FROM Songs s WHERE ${where}
      AND s.cover_url IS NOT NULL AND TRIM(s.cover_url) <> ''
      ORDER BY CASE WHEN s.created_at IS NULL THEN 1 ELSE 0 END, s.created_at, s.id LIMIT 1`)
      .bind(...credits).first(),
    db.prepare('SELECT photo_url FROM Artist_Photos WHERE artist_name = ?').bind(name).first(),
  ]);
  const songs = rows(result);
  const total = Number(count?.total || 0);
  return success({ name, photoUrl: photo?.photo_url || '',
    coverUrl: cover?.cover_url || '',
    songCount: total, songs, ...page,
    hasMore: page.offset + songs.length < total }, headers);
}

export async function handleLocalAlbumReadRoute(request, url, db, headers = {}, accountId) {
  const path = url.pathname;
  if (request.method !== 'GET' || !(path === '/api/albums' || path === '/api/artists'
    || /^\/api\/(albums|artists)\/[^/]+$/u.test(path))) return null;
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return json({ code: 401, message: 'Authentication required' }, 401, headers);
  }
  if (!db?.prepare) return json({ code: 503, message: 'Database unavailable' }, 503, headers);
  if (path === '/api/albums') return listAlbums(db, url, headers);
  if (path === '/api/artists') return listArtists(db, url, headers);
  const match = path.match(/^\/api\/(albums|artists)\/([^/]+)$/u);
  return match[1] === 'albums'
    ? albumDetail(db, match[2], headers)
    : artistDetail(db, url, match[2], headers);
}
