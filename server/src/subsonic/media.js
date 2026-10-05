import { serveMediaObject, resolveMediaObjectKey } from '../routes/media.js';
import { lyricArtifactStoreForEnv } from '../services/lyricAssetWorkflow.js';
import { readPlaybackLyrics } from '../services/playbackLyrics.js';
import { findSong, catalog } from './library.js';
import { required, reject } from './response.js';
import { structuredLyrics } from './lyrics.js';

async function coverSong(db, id) {
  if (id.startsWith('cover_')) return findSong(db, id.slice(6));
  const key = id.replace(/^(al-|ar-)/, '');
  const c = await catalog(db); const item = c.albums.get(key) || c.artists.get(key);
  if (!item?.coverArt) reject(70, 'Cover was not found');
  return findSong(db, item.coverArt.slice(6));
}

const MAX_LEGACY_LYRIC_MATCHES = 8;

async function findLyricSong(p, db, env) {
  if (p.has('id')) return findSong(db, required(p, 'id'));
  const title = (p.get('title') || '').trim(); const artist = (p.get('artist') || '').trim();
  if (!title && !artist) return null;
  if ([title, artist].some(value => value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value))) reject(10, 'Invalid lyrics query');
  const predicates = ["audio_url IS NOT NULL AND TRIM(audio_url) <> ''"]; const bindings = [];
  if (title) { predicates.push('title = ?'); bindings.push(title); }
  if (artist) { predicates.push("COALESCE(NULLIF(TRIM(artist), ''), 'Unknown artist') = ? COLLATE NOCASE"); bindings.push(artist); }
  const query = async conditions => (await db.prepare(`SELECT id, title, artist, album, duration, language FROM Songs
    WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ${MAX_LEGACY_LYRIC_MATCHES + 1}`).bind(...bindings).all()).results || [];
  let rows = await query(predicates);
  // Keep the indexed exact-title path for ordinary clients; imported padded
  // titles use a bounded fallback only after that lookup misses.
  if (!rows.length && title) rows = await query(predicates.map(value => value === 'title = ?' ? 'TRIM(title) = ? COLLATE NOCASE' : value));
  // Name-only requests cannot identify one recording in an unbounded collection.
  if (!rows.length || rows.length > MAX_LEGACY_LYRIC_MATCHES) return null;
  if (rows.length === 1) return rows[0];
  const store = lyricArtifactStoreForEnv(env);
  let readError;
  for (const row of rows) {
    if (row.language === 'instrumental') continue;
    try {
      const saved = await store.get(row.id);
      if (saved.artifact?.status === 'ready') return row;
    } catch (error) { readError ||= error; }
  }
  if (readError) throw readError;
  // Never start source searches for several ambiguous recordings on one request.
  return null;
}

export async function media(method, p, request, env, executionContext, accountId) {
  const db = env.DB;
  if (['getLyrics', 'getLyricsBySongId'].includes(method)) {
    const enhanced = method === 'getLyricsBySongId' && p.get('enhanced') === 'true';
    if (method === 'getLyricsBySongId' && p.has('enhanced') && !['true', 'false'].includes(p.get('enhanced'))) {
      reject(10, 'Invalid enhanced');
    }
    const row = method === 'getLyricsBySongId' ? await findSong(db, required(p, 'id'))
      : await findLyricSong(p, db, env);
    if (!row) return { lyrics: {} };
    const read = await readPlaybackLyrics({ env, db, song: row, accountId, executionContext, signal: request.signal });
    if (read.state === 'song_deleted') reject(70, 'Song was not found');
    const artifact = read.artifact;
    const lines = artifact?.status === 'ready' ? artifact.original?.lines || [] : [];
    if (method === 'getLyrics') return { lyrics: { artist: row.artist || '', title: row.title,
      value: lines.map((line) => line.text).join('\n') } };
    return structuredLyrics(artifact, row, enhanced);
  }
  const isCover = method === 'getCoverArt' || method === 'getCoverArt2';
  const row = isCover ? await coverSong(db, required(p, 'id')) : await findSong(db, required(p, 'id'));
  const storedPath = isCover ? row.cover_url : row.audio_url;
  // Imported catalog rows use audio/... and cover/...; newer writes use /media/.
  // Both refer to the same private prefix. Normalize only known catalog forms,
  // never external URLs or an object key supplied by the protocol caller.
  const path = typeof storedPath === 'string' && /^(audio|cover)\//.test(storedPath)
    ? `/media/${storedPath}` : storedPath;
  if (!path || !path.startsWith('/media/') || path.includes('?') || path.includes('#')
    || !resolveMediaObjectKey(path, env)) reject(70, 'Media was not found');
  if (!isCover) {
    const suffix = path.split('.').at(-1).toLowerCase();
    if (p.has('format') && !['raw', suffix].includes(p.get('format').toLowerCase())) reject(0, 'Transcoding is not supported');
    if (p.has('maxBitRate') && p.get('maxBitRate') !== '0') reject(0, 'Bitrate limiting is not supported');
    if (p.has('timeOffset') && p.get('timeOffset') !== '0') reject(0, 'Use HTTP Range to seek');
  }
  const response = await serveMediaObject(request, path, env);
  if (response.status === 404) reject(70, 'Media was not found');
  return response;
}
