import { encodeAlbumId } from '../routes/localAlbumRead.js';
import { integer, required, reject } from './response.js';

const caches = new WeakMap();
const playable = (s) => typeof s.audio_url === 'string' && s.audio_url.trim();
const artistName = (s) => s.artist?.trim() || 'Unknown artist';
const albumName = (s) => s.album?.trim() || 'Unknown album';
const artistId = (s) => `art_${encodeAlbumId(artistName(s), '')}`;
const albumId = (s) => `alb_${encodeAlbumId(artistName(s), albumName(s))}`;
const mimeTypes = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', wma: 'audio/x-ms-wma' };
const iso = (time) => Number.isFinite(Number(time)) && Number(time) > 0 ? new Date(Number(time)).toISOString() : undefined;

export function song(s) {
  const suffix = String(s.audio_url || '').split(/[?#]/)[0].split('.').at(-1).toLowerCase();
  return { id: s.id, parent: albumId(s), isDir: false, title: s.title, artist: artistName(s),
    album: albumName(s), artistId: artistId(s), albumId: albumId(s),
    duration: Math.max(0, Math.round(Number(s.duration) || 0)), type: 'music',
    contentType: mimeTypes[suffix] || 'application/octet-stream', suffix,
    coverArt: s.cover_url ? `cover_${s.id}` : undefined, created: iso(s.created_at),
    starred: s.starred ? iso(s.starred) : undefined };
}

export async function catalog(db) {
  const old = caches.get(db); const now = Date.now();
  if (old && now < old.expires) return old.promise;
  const entry = { expires: now + 60_000 };
  entry.promise = (async () => {
    const rows = (await db.prepare(`SELECT id, title, artist, album, duration, audio_url, cover_url, created_at
      FROM Songs WHERE audio_url IS NOT NULL AND TRIM(audio_url) <> '' ORDER BY id LIMIT 10001`).all()).results || [];
    if (rows.length > 10000) reject(0, 'Compatibility catalog exceeds 10000 songs');
    const songs = new Map(); const artists = new Map(); const albums = new Map();
    for (const row of rows) {
      songs.set(row.id, row);
      const aid = artistId(row); const bid = albumId(row);
      if (!artists.has(aid)) artists.set(aid, { id: aid, name: artistName(row), albums: new Set() });
      if (!albums.has(bid)) albums.set(bid, { id: bid, name: albumName(row), artist: artistName(row),
        artistId: aid, songs: [], duration: 0, newest: 0 });
      const artist = artists.get(aid); const album = albums.get(bid);
      artist.albums.add(bid); album.songs.push(row); album.duration += Math.max(0, Number(row.duration) || 0);
      album.newest = Math.max(album.newest, Number(row.created_at) || 0);
      if (row.cover_url) { album.coverArt ||= `cover_${row.id}`; artist.coverArt ||= `cover_${row.id}`; }
    }
    return { songs, artists, albums, lastModified: now };
  })();
  caches.set(db, entry);
  try { return await entry.promise; } catch (error) { if (caches.get(db) === entry) caches.delete(db); throw error; }
}
export const album = (row) => ({ id: row.id, name: row.name, title: row.name, artist: row.artist,
  artistId: row.artistId, isDir: true, coverArt: row.coverArt, songCount: row.songs.length,
  duration: Math.round(row.duration), created: iso(row.newest) });
export const artist = (row) => ({ id: row.id, name: row.name, albumCount: row.albums.size, coverArt: row.coverArt });
const found = (row) => row || reject(70, 'Requested item was not found');
export async function findSong(db, id) {
  const row = await db.prepare('SELECT id, title, artist, album, duration, language, audio_url, cover_url, created_at FROM Songs WHERE id = ?').bind(id).first();
  if (!row || !playable(row)) reject(70, 'Song was not found');
  return row;
}
export async function library(method, p, db, accountId) {
  if (p.has('musicFolderId') && p.get('musicFolderId') !== '1') reject(70, 'Music folder was not found');
  if (method === 'getMusicFolders') return { musicFolders: { musicFolder: [{ id: '1', name: 'Music' }] } };
  if (method === 'getGenres') return { genres: { genre: [] } };
  if (method === 'getSong') return { song: song(await findSong(db, required(p, 'id'))) };
  const c = await catalog(db);
  if (method === 'getScanStatus') return { scanStatus: { scanning: false, count: c.songs.size } };
  if (method === 'getArtists' || method === 'getIndexes') {
    const list = [...c.artists.values()].sort((a, b) => a.name.localeCompare(b.name)).map(artist);
    return { [method === 'getArtists' ? 'artists' : 'indexes']: {
      ...(method === 'getIndexes' ? { lastModified: c.lastModified } : {}),
      ignoredArticles: '', index: [{ name: '#', artist: list }] } };
  }
  if (method === 'getArtist') {
    const row = found(c.artists.get(required(p, 'id')));
    return { artist: { ...artist(row), album: [...row.albums].map((id) => album(c.albums.get(id))) } };
  }
  if (method === 'getAlbum') {
    const row = found(c.albums.get(required(p, 'id')));
    return { album: { ...album(row), song: row.songs.map(song) } };
  }
  if (method === 'getMusicDirectory') {
    const id = required(p, 'id'); const row = c.artists.get(id) || c.albums.get(id);
    found(row);
    return { directory: { id, name: row.name, child: row.albums
      ? [...row.albums].map((bid) => album(c.albums.get(bid))) : row.songs.map(song) } };
  }
  if (method === 'search3' || method === 'search2') {
    if (!p.has('query')) reject(10, 'Missing query');
    const q = p.get('query').trim().toLocaleLowerCase();
    if (q.length > 200) reject(10, 'Query too long');
    const matches = (value) => !q || value.toLocaleLowerCase().includes(q);
    const page = (list, type) => { const offset = integer(p, `${type}Offset`, 0, 1_000_000);
      return list.slice(offset, offset + integer(p, `${type}Count`, 20)); };
    return { [method === 'search3' ? 'searchResult3' : 'searchResult2']: {
      artist: page([...c.artists.values()].filter((r) => matches(r.name)), 'artist').map(artist),
      album: page([...c.albums.values()].filter((r) => matches(`${r.name} ${r.artist}`)), 'album').map(album),
      song: page([...c.songs.values()].filter((r) => matches(`${r.title} ${r.artist || ''} ${r.album || ''}`)), 'song').map(song),
    } };
  }
  if (method === 'getRandomSongs') {
    if (['genre', 'fromYear', 'toYear'].some((key) => p.has(key))) reject(0, 'Genre and year filtering are not supported');
    const entries = [...c.songs.values()];
    for (let i = entries.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [entries[i], entries[j]] = [entries[j], entries[i]]; }
    return { randomSongs: { song: entries.slice(0, integer(p, 'size', 10)).map(song) } };
  }
  if (method === 'getAlbumList2' || method === 'getAlbumList') {
    const type = required(p, 'type'); let entries = [...c.albums.values()];
    if (type === 'recent' || type === 'frequent') entries = []; // This profile does not collect listening events.
    else if (type === 'starred') entries = []; // Album starring is not supported.
    else if (type === 'newest') entries.sort((a, b) => b.newest - a.newest || a.id.localeCompare(b.id));
    else if (type === 'alphabeticalByName') entries.sort((a, b) => a.name.localeCompare(b.name));
    else if (type === 'alphabeticalByArtist') entries.sort((a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name));
    else if (type === 'random') {
      for (let i = entries.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [entries[i], entries[j]] = [entries[j], entries[i]]; }
    } else reject(0, 'Album list type is not supported');
    const offset = integer(p, 'offset', 0, 1_000_000);
    return { [method === 'getAlbumList2' ? 'albumList2' : 'albumList']: { album: entries.slice(offset, offset + integer(p, 'size', 10)).map(album) } };
  }
  reject(70, 'Endpoint was not found');
}
