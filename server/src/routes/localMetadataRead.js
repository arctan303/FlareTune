import { parseArtistNames } from '../utils/artistParser.js';
import { LyricArtifactStoreError } from '../services/lyricArtifactStore.js';
import { PlaybackLyricsError, readPlaybackLyrics } from '../services/playbackLyrics.js';
import { LyricSourceError } from '../services/lyricSourceLoader.js';
import { fetchArtistPhotosFromSources } from '../services/artistPhotoSources.js';
import { saveArtistPhotoToDb } from '../services/artistPhotoStore.js';

const MAX_ARTIST_NAMES = 8;
const MAX_PHOTOS = 12;
const MAX_FETCH_ARTISTS = 2;
const EMPTY_PHOTO_TTL_SECONDS = 3600;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function json(payload, status, headers) {
  const outputHeaders = new Headers(headers);
  outputHeaders.set('Content-Type', 'application/json; charset=utf-8');
  outputHeaders.set('Cache-Control', 'private, no-store');
  return new Response(JSON.stringify(payload), { status, headers: outputHeaders });
}

function invalid(message, headers) {
  return json({ code: 400, message }, 400, headers);
}

function onlyQuery(url, name) {
  const keys = [...url.searchParams.keys()];
  return keys.length === 1 && keys[0] === name;
}

function safeSongId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value === value.trim() && value !== '.' && value !== '..'
    && !/[\\/]/u.test(value) && !CONTROL_CHARACTERS.test(value);
}

function safeArtistName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && value === value.trim() && !CONTROL_CHARACTERS.test(value);
}

function safePhotoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (/^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/u.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname)
      && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

function safePhoto(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !safePhotoUrl(value.url)) return null;
  const photo = { url: value.url };
  for (const field of ['type', 'label', 'source', 'sourceName']) {
    if (typeof value[field] === 'string' && value[field].length <= 160 && !CONTROL_CHARACTERS.test(value[field])) {
      photo[field] = value[field];
    }
  }
  for (const field of ['width', 'height']) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= 100_000) photo[field] = value[field];
  }
  if (typeof value.isRealArtist === 'boolean') photo.isRealArtist = value.isRealArtist;
  if (typeof value.is169 === 'boolean') photo.is169 = value.is169;
  return photo;
}

function storedPhotos(row) {
  if (!row) return [];
  let parsed;
  try {
    parsed = JSON.parse(row.photos || '[]');
  } catch {
    parsed = [];
  }
  const photos = Array.isArray(parsed) ? parsed.map(safePhoto).filter(Boolean).slice(0, MAX_PHOTOS) : [];
  if (photos.length === 0 && safePhotoUrl(row.photo_url)) photos.push({ url: row.photo_url });
  return photos;
}

async function artistInCatalog(db, artist) {
  const result = await db.prepare('SELECT DISTINCT artist FROM Songs WHERE instr(artist, ?) > 0')
    .bind(artist).all();
  return (result?.results || []).some((row) => parseArtistNames(row.artist).includes(artist));
}

async function readLyrics(url, db, headers, env, accountId, deps = {}) {
  if (!onlyQuery(url, 'songId')) return invalid('Only songId is accepted', headers);
  const songId = url.searchParams.get('songId');
  if (!safeSongId(songId)) return invalid('Invalid song id', headers);

  let song;
  try {
    song = await db.prepare(`SELECT id, title, artist, album, duration, language
      FROM Songs WHERE id = ?`).bind(songId).first();
  } catch {
    return json({ code: 503, message: 'Database unavailable' }, 503, headers);
  }
  if (!song) return json({ code: 404, message: 'Song not found', reason: 'song_not_found' }, 404, headers);
  try {
    const read = await readPlaybackLyrics({ env, db, song, accountId,
      executionContext: deps.ctx, signal: deps.signal, deps });
    if (read.state === 'song_deleted') return json({ code: 404, message: 'Song not found', reason: 'song_not_found' }, 404, headers);
    if (!read.lyrics) return json({ code: 404, data: null, message: 'No lyrics found', reason: 'lyrics_not_found' }, 404, headers);
    return json({ code: 200, data: read.lyrics }, 200, headers);
  } catch (error) {
    if (error instanceof PlaybackLyricsError) return json({ code: 503, message: error.message }, 503, headers);
    if (error instanceof LyricSourceError) {
      return json({ code: 503, message: 'Lyric source temporarily unavailable' }, 503, headers);
    }
    if (error instanceof LyricArtifactStoreError) {
      const invalidAsset = error.code === 'invalid_stored_artifact';
      return json({
        code: invalidAsset ? 502 : 503,
        message: invalidAsset ? 'Stored lyric asset is invalid' : 'Lyric storage temporarily unavailable',
      }, invalidAsset ? 502 : 503, headers);
    }
    return json({ code: 500, message: 'Internal server error' }, 500, headers);
  }
}

async function readArtistPhotos(url, db, headers) {
  if (!onlyQuery(url, 'name')) return invalid('Only name is accepted', headers);
  const name = url.searchParams.get('name');
  if (!safeArtistName(name)) return invalid('Invalid artist name', headers);
  const artistNames = parseArtistNames(name);
  if (artistNames.length > MAX_ARTIST_NAMES || artistNames.some((artist) => !safeArtistName(artist))) {
    return invalid('Invalid artist name', headers);
  }
  const gallery = [];
  const seen = new Set();
  let fetchBudget = MAX_FETCH_ARTISTS;
  try {
    const photosByArtist = await Promise.all(artistNames.map(async (artist) => {
      const record = await db.prepare(`SELECT photo_url, photos, source, updated_at
        FROM Artist_Photos WHERE artist_name = ?`).bind(artist).first();
      const cached = storedPhotos(record);
      if (cached.length > 0) return cached;
      if (record?.source === 'none' && Number(record.updated_at) > Date.now() / 1000 - EMPTY_PHOTO_TTL_SECONDS) {
        return [];
      }
      if (!await artistInCatalog(db, artist)) return [];
      if (fetchBudget < 1) return [];
      fetchBudget -= 1;

      const fetched = await fetchArtistPhotosFromSources(artist, { includeCovers: false });
      const photos = Array.isArray(fetched.photos)
        ? fetched.photos.map(safePhoto).filter(Boolean).slice(0, MAX_PHOTOS) : [];
      if (photos.length === 0 && fetched.meta?.providerFailures > 0) return [];
      const saved = await saveArtistPhotoToDb(db, {
        ...fetched, photos, photo_url: photos[0]?.url || '', source: photos[0]?.source || 'none',
      });
      if (!saved) throw new Error('Artist photo cache write failed');
      return photos;
    }));
    const maxLength = Math.max(0, ...photosByArtist.map((photos) => photos.length));
    for (let index = 0; index < maxLength && gallery.length < MAX_PHOTOS; index += 1) {
      for (let artistIndex = 0; artistIndex < artistNames.length && gallery.length < MAX_PHOTOS; artistIndex += 1) {
        const photo = photosByArtist[artistIndex][index];
        if (!photo || seen.has(photo.url)) continue;
        seen.add(photo.url);
        gallery.push({ ...photo, artistName: artistNames[artistIndex] });
      }
    }
  } catch {
    return json({ code: 503, message: 'Database unavailable' }, 503, headers);
  }
  return json({ code: 0, data: {
    artist: name,
    artistNames,
    primary: gallery[0]?.url || '',
    photos: gallery,
    meta: { artistsCount: artistNames.length, totalPhotos: gallery.length },
  } }, 200, headers);
}

// The outer router must have already verified a normal local-account session.
// Keep an account-id guard here so accidental direct dispatch cannot expose metadata.
export async function handleLocalMetadataReadRoute(request, url, db, headers = {}, accountId, env = {}, deps = {}) {
  if (url.pathname !== '/api/lyrics' && url.pathname !== '/api/artist-photo') return null;
  if (request.method !== 'GET') return json({ code: 405, message: 'Method not allowed' }, 405, headers);
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return json({ code: 401, message: 'Authentication required' }, 401, headers);
  }
  if (!db?.prepare) return json({ code: 503, message: 'Database unavailable' }, 503, headers);
  return url.pathname === '/api/lyrics'
    ? readLyrics(url, db, headers, env, accountId, { ...deps, signal: request.signal })
    : readArtistPhotos(url, db, headers);
}
