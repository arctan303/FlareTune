import { serveMediaObject, resolveMediaObjectKey } from '../routes/media.js';
import { lyricArtifactStoreForEnv } from '../services/lyricAssetWorkflow.js';
import { findSong, catalog } from './library.js';
import { required, reject } from './response.js';

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
    const synced = artifact?.original?.syncMode !== 'none' && lines.every((line) => Number.isFinite(line.time));
    return { lyricsList: { structuredLyrics: lines.length ? [{ displayArtist: row.artist || '',
      displayTitle: row.title, lang: 'und', synced, offset: 0,
      line: lines.map((line) => ({ value: line.text,
        ...(synced ? { start: Math.max(0, Math.round(line.time * 1000 + (artifact.offsetMs || 0))) } : {}) })) }] : [] } };
  }
  const isCover = method === 'getCoverArt' || method === 'getCoverArt2';
  const row = isCover ? await coverSong(db, required(p, 'id')) : await findSong(db, required(p, 'id'));
  const path = isCover ? row.cover_url : row.audio_url;
  // Only catalog-referenced /media/ objects may be read. Never follow external
  // URLs or accept a raw object key supplied by the caller.
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
