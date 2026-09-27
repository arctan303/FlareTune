import { querySongs } from '../tools/searchSongs.js';
import { buildSongLanguageFilter } from '../utils/songLanguage.js';
import { runtimeSongColumns } from '../utils/songProjection.js';

const SONG_COLUMNS = runtimeSongColumns('s');
const FAVORITE_ALIAS = 'favorite';
const MAX_ID_LENGTH = 256;
const OTHER_SONG_ROUTE_NAMES = new Set(['random', 'resolve', 'roam', 'spotlight-artist']);

const json = (data, status, headers) => new Response(JSON.stringify(data), {
  status,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
});
const success = (data, headers) => json({ code: 200, data }, 200, headers);
const invalid = (message, headers) => json({ code: 400, message }, 400, headers);
const notFound = (message, headers) => json({ code: 404, message }, 404, headers);
const rows = (result) => result?.results || [];

function parseId(encoded) {
  if (!encoded || encoded.length > MAX_ID_LENGTH * 3) return null;
  try {
    const id = decodeURIComponent(encoded);
    if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) return null;
    return id;
  } catch {
    return null;
  }
}

function parseInteger(raw, fallback, maximum) {
  if (raw === null) return fallback;
  if (!/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function personalPlaylistIndex(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    author: '我',
    type: row.kind,
    has_cover: 0,
    cover_url: null,
    preview_covers: [],
    order: row.created_at,
    songCount: row.songCount,
  };
}

async function favoriteRow(db, accountId) {
  return db.prepare(`SELECT id, name, description, kind, created_at FROM Member_Playlists
    WHERE account_id = ? AND kind = 'favorite' LIMIT 1`).bind(accountId).first();
}

async function personalSongs(db, accountId, playlistId) {
  return rows(await db.prepare(`SELECT ${SONG_COLUMNS} FROM Member_Playlist_Songs ps
    JOIN Member_Playlists p ON p.id = ps.playlist_id
    JOIN Songs s ON s.id = ps.song_id
    WHERE p.id = ? AND p.account_id = ?
    ORDER BY ps.sort_order ASC, s.id ASC`).bind(playlistId, accountId).all());
}

async function readInit(db, accountId, headers) {
  const favorite = await favoriteRow(db, accountId);
  const favoriteSongs = favorite ? await personalSongs(db, accountId, favorite.id) : [];
  const personal = rows(await db.prepare(`SELECT p.id, p.name, p.description, p.kind, p.created_at,
      (SELECT COUNT(*) FROM Member_Playlist_Songs ps WHERE ps.playlist_id = p.id) AS songCount
    FROM Member_Playlists p WHERE p.account_id = ? AND p.kind = 'regular'
    ORDER BY p.created_at ASC, p.id ASC`).bind(accountId).all());
  return success({
    default_playlist: {
      id: favorite?.id || FAVORITE_ALIAS,
      name: '我的收藏',
      type: 'favorite',
      songs: favoriteSongs,
    },
    other_playlists: personal.map(personalPlaylistIndex),
  }, headers);
}

async function readPlaylist(db, accountId, id, headers) {
  const personal = id === FAVORITE_ALIAS
    ? await favoriteRow(db, accountId)
    : await db.prepare(`SELECT id, name, description, kind, created_at FROM Member_Playlists
      WHERE id = ? AND account_id = ?`).bind(id, accountId).first();
  if (personal) {
    return success({
      id: personal.id,
      name: personal.kind === 'favorite' ? '我的收藏' : personal.name,
      description: personal.kind === 'favorite' ? '' : personal.description,
      author: '我',
      type: personal.kind,
      has_cover: 0,
      cover_url: null,
      preview_covers: [],
      created_at: personal.created_at,
      songs: await personalSongs(db, accountId, personal.id),
    }, headers);
  }
  if (id === FAVORITE_ALIAS) {
    return success({
      id: FAVORITE_ALIAS, name: '我的收藏', description: '', author: '我', type: 'favorite',
      has_cover: 0, cover_url: null, preview_covers: [], created_at: null, songs: [],
    }, headers);
  }
  return notFound('Playlist not found', headers);
}

async function readSong(db, id, headers) {
  const song = await db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs s WHERE s.id = ?`).bind(id).first();
  return song ? success(song, headers) : notFound('Song not found', headers);
}

async function searchSongs(db, url, headers) {
  const query = (url.searchParams.get('q') || '').trim();
  const language = (url.searchParams.get('language') || '').trim();
  const limit = parseInteger(url.searchParams.get('limit'), 20, 50);
  const offset = parseInteger(url.searchParams.get('offset'), 0, 2000);
  if (query.length > 200 || limit === null || limit < 1 || offset === null) {
    return invalid('Invalid search parameters', headers);
  }
  if (!buildSongLanguageFilter(language)) return invalid('invalid_language', headers);
  const songs = query ? await querySongs(db, query, limit, offset, { language: language || null }) : [];
  return success({ songs, query }, headers);
}

async function readSongCollection(db, url, headers) {
  if (url.searchParams.get('counts') === 'language') {
    const counts = rows(await db.prepare(`SELECT language, COUNT(*) AS count FROM Songs
      WHERE audio_url IS NOT NULL AND TRIM(audio_url) <> '' GROUP BY language`).all());
    return success(Object.fromEntries(counts.filter((row) => row.language).map((row) => [row.language, row.count])), headers);
  }
  const language = (url.searchParams.get('language') || '').trim();
  const filter = buildSongLanguageFilter(language);
  if (!language || !filter) return invalid('invalid_language', headers);
  const page = parseInteger(url.searchParams.get('page'), 1, 100000);
  const limit = parseInteger(url.searchParams.get('limit'), 30, 50);
  const sort = (url.searchParams.get('sort') || 'desc').toLowerCase();
  if (!page || !limit || !['asc', 'desc'].includes(sort)) return invalid('Invalid collection parameters', headers);
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > 2000) return invalid('Invalid collection parameters', headers);
  const where = `s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> '' AND ${filter.sql}`;
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM Songs s WHERE ${where}`).bind(...filter.bindings).first();
  const songs = rows(await db.prepare(`SELECT ${SONG_COLUMNS}, s.created_at FROM Songs s WHERE ${where}
    ORDER BY CASE WHEN s.created_at IS NOT NULL THEN 0 ELSE 1 END,
      s.created_at ${sort.toUpperCase()}, s.id ${sort.toUpperCase()} LIMIT ? OFFSET ?`)
    .bind(...filter.bindings, limit, offset).all());
  const total = Number(count?.total || 0);
  return success({ language, songs, total, page, pageSize: limit, hasMore: offset + songs.length < total, sort }, headers);
}

// Called only after the outer router has verified a normal local-account session.
// The account id remains mandatory here to avoid an accidental cross-account read.
export async function handleLocalMusicReadRoute(request, url, db, headers = {}, accountId) {
  const path = url.pathname;
  if (request.method !== 'GET') return null;
  if (!(path === '/api/init' || path === '/api/songs' || path === '/api/songs/search'
    || /^\/api\/(songs|playlists)\/[^/]+$/u.test(path))) return null;
  if (!accountId || typeof accountId !== 'string') return json({ code: 401, message: 'Authentication required' }, 401, headers);
  if (!db?.prepare) return json({ code: 503, message: 'Database unavailable' }, 503, headers);
  if (path === '/api/init') return readInit(db, accountId, headers);
  if (path === '/api/songs') return readSongCollection(db, url, headers);
  if (path === '/api/songs/search') return searchSongs(db, url, headers);
  const match = path.match(/^\/api\/(songs|playlists)\/([^/]+)$/u);
  if (match[1] === 'songs' && OTHER_SONG_ROUTE_NAMES.has(match[2])) return null;
  const id = parseId(match[2]);
  if (!id) return invalid('Invalid ID', headers);
  return match[1] === 'songs' ? readSong(db, id, headers) : readPlaylist(db, accountId, id, headers);
}
