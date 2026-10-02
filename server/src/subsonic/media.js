import { serveMediaObject, resolveMediaObjectKey } from '../routes/media.js';
import { lyricArtifactStoreForEnv } from '../services/lyricAssetWorkflow.js';
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

export async function media(method, p, request, env) {
  const db = env.DB;
  if (['getLyrics', 'getLyricsBySongId'].includes(method)) {
    const enhanced = method === 'getLyricsBySongId' && p.get('enhanced') === 'true';
    if (method === 'getLyricsBySongId' && p.has('enhanced') && !['true', 'false'].includes(p.get('enhanced'))) {
      reject(10, 'Invalid enhanced');
    }
    let row;
    if (method === 'getLyricsBySongId') row = await findSong(db, required(p, 'id'));
    else {
      const title = p.get('title') || ''; const artist = p.get('artist') || '';
      if (!title && !artist) reject(10, 'Missing artist or title');
      row = await db.prepare(`SELECT id, title, artist FROM Songs
        WHERE (? = '' OR title = ?) AND (? = '' OR artist = ?) ORDER BY id LIMIT 1`).bind(title, title, artist, artist).first();
      if (!row) return { lyrics: {} };
    }
    const saved = await lyricArtifactStoreForEnv(env).get(row.id);
    const artifact = saved.artifact;
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
