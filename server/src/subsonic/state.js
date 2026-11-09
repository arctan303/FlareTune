import { accountMusic as music } from '../routes/localAccountMusic.js';
import { song } from './library.js';
import { required, reject } from './response.js';
import { externalMusicSchemaReady } from '../services/externalMusicReferences.js';

const iso = (value) => new Date(value || 0).toISOString();
function playlist(row, username, includeSongs = false) {
  const songs = row.songs || [];
  return { id: row.id, name: row.name, comment: row.description || '', owner: username,
    public: false, songCount: includeSongs ? songs.length : row.songCount, duration: Math.round(row.duration ?? songs.reduce((n, s) => n + (Number(s.duration) || 0), 0)),
    created: iso(row.createdAt), changed: iso(row.updatedAt),
    coverArt: row.coverSongId ? `cover_${row.coverSongId}`
      : songs.find((s) => s.cover_url) ? `cover_${songs.find((s) => s.cover_url).id}` : undefined,
    ...(includeSongs ? { entry: songs.map(song) } : {}) };
}
const unique = (values) => [...new Set(values)];
const externalId = value => typeof value === 'string' && value.startsWith('yt:');
const localIds = values => {
  if (values.some(externalId)) reject(70, 'External-source playback is not supported by this protocol');
  return values;
};

// The protocol sees only local tracks. Replacing that visible projection must
// not silently delete external references saved through the web application.
async function replaceLocalSongs(db, accountId, playlistId, input, now) {
  if (!await externalMusicSchemaReady(db)) return music.replaceSongs(db, accountId, playlistId, input, now);
  const result = await db.prepare(`SELECT song_id, source FROM Member_All_Playlist_Songs
    WHERE playlist_id = ? AND account_id = ? ORDER BY sort_order, song_id`).bind(playlistId, accountId).all();
  const membership = result.results || [];
  if (!membership.some(row => row.source === 'youtube')) return music.replaceSongs(db, accountId, playlistId, input, now);
  const desired = [...input.songIds];
  const merged = [];
  for (const current of membership) {
    if (current.source === 'youtube') merged.push(current.song_id);
    else if (desired.length) merged.push(desired.shift());
  }
  merged.push(...desired);
  return music.replaceSongs(db, accountId, playlistId, { ...input, songIds: merged }, now, { externalReferences: true });
}

export async function state(method, p, db, account) {
  const id = account.accountId; const now = Date.now();
  if (p.has('username') && p.get('username') !== account.username) reject(50, 'Cross-user access is not allowed');
  if (p.has('public') && p.get('public') !== 'false') reject(50, 'Only private playlists are supported');
  if (method === 'getPlaylists') {
    // Summarize every owned playlist in one query, including empty playlists.
    // Loading each playlist separately exceeds the D1 Free query budget at 25 lists.
    const result = await db.prepare(`SELECT p.id, p.name, p.description,
      p.created_at AS createdAt, p.updated_at AS updatedAt, COUNT(ps.song_id) AS songCount,
      COALESCE(SUM(s.duration), 0) AS duration,
      MIN(CASE WHEN s.cover_url IS NOT NULL AND TRIM(s.cover_url) <> '' THEN s.id END) AS coverSongId
      FROM Member_Playlists p LEFT JOIN Member_Playlist_Songs ps ON ps.playlist_id = p.id
      LEFT JOIN Songs s ON s.id = ps.song_id
      WHERE p.account_id = ? AND p.kind = 'regular'
      GROUP BY p.id ORDER BY p.created_at, p.id`).bind(id).all();
    return { playlists: { playlist: (result.results || []).map((row) => playlist(row, account.username)) } };
  }
  if (['getPlaylist', 'getPlaylist2'].includes(method)) {
    return { playlist: playlist(await music.getPlaylist(db, id, required(p, 'id')), account.username, true) };
  }
  if (method === 'createPlaylist') {
    const songIds = localIds(unique(p.getAll('songId')));
    if (p.has('playlistId')) {
      const row = await music.getPlaylist(db, id, required(p, 'playlistId'));
      if (row.kind !== 'regular') reject(50, 'Use star and unstar to change favorites');
      await replaceLocalSongs(db, id, row.id, { songIds, expectedRevision: row.revision,
        ...(p.has('name') ? { name: p.get('name') } : {}) }, now);
      return { playlist: playlist(await music.getPlaylist(db, id, row.id), account.username, true) };
    }
    const created = await music.createPlaylist(db, id, { name: required(p, 'name'), songIds }, now);
    return { playlist: playlist(await music.getPlaylist(db, id, created.playlist.id), account.username, true) };
  }
  if (method === 'updatePlaylist' || method === 'deletePlaylist') {
    const row = await music.getPlaylist(db, id, required(p, method === 'deletePlaylist' ? 'id' : 'playlistId'));
    if (row.kind !== 'regular') reject(50, 'Use star and unstar to change favorites');
    if (method === 'deletePlaylist') { await music.deletePlaylist(db, id, row.id, { expectedRevision: row.revision }, now); return {}; }
    const remove = p.getAll('songIndexToRemove');
    if (remove.some((v) => !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) >= row.songs.length)) reject(10, 'Invalid song index');
    const indices = new Set(remove.map(Number));
    const songIds = localIds(unique([...row.songs.filter((_, index) => !indices.has(index)).map((s) => s.id), ...p.getAll('songIdToAdd')]));
    await replaceLocalSongs(db, id, row.id, { songIds, expectedRevision: row.revision,
      ...(p.has('name') ? { name: p.get('name') } : {}),
      ...(p.has('comment') ? { description: p.get('comment') } : {}) }, now);
    return {};
  }
  if (['getStarred', 'getStarred2', 'star', 'unstar'].includes(method)) {
    if (p.has('albumId') || p.has('artistId')) reject(0, 'Only song favorites are supported');
    const row = await music.getFavorite(db, id, now);
    if (method.startsWith('get')) return { [method === 'getStarred' ? 'starred' : 'starred2']: {
      artist: [], album: [], song: row.songs.map((s) => song({ ...s, starred: s.addedAt })) } };
    const ids = localIds(p.getAll('id'));
    if (!ids.length || ids.some((v) => !v)) reject(10, 'Missing id');
    const current = row.songs.map((s) => s.id);
    const next = method === 'star' ? unique([...current, ...ids]) : current.filter((value) => !ids.includes(value));
    await replaceLocalSongs(db, id, row.id, { songIds: next, expectedRevision: row.revision }, now);
    return {};
  }
  reject(70, 'Endpoint was not found');
}
