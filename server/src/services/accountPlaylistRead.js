import {
  SUMMARY_SQL,
  cleanId,
  fail,
  mapSong,
  mapSummary,
  readSummary,
  requireDb,
  subjectOf,
} from './accountPlaylistCore.js';

export async function ensureFavoriteInternal(db, userSub, now = Date.now()) {
  requireDb(db);
  const subject = subjectOf(userSub);
  await db.prepare(`INSERT OR IGNORE INTO Member_Playlists
    (id, user_sub, kind, name, description, revision, created_at, updated_at)
    VALUES (?, ?, 'favorite', ?, '', 0, ?, ?)`)
    .bind(`fav_${crypto.randomUUID()}`, subject, '我的收藏', now, now).run();
  return readSummary(db, subject, (await db.prepare(
    "SELECT id FROM Member_Playlists WHERE user_sub = ? AND kind = 'favorite'",
  ).bind(subject).first())?.id);
}

export async function listPlaylists(db, userSub) {
  requireDb(db);
  const subject = subjectOf(userSub);
  await ensureFavoriteInternal(db, subject);
  const result = await db.prepare(`${SUMMARY_SQL}
    WHERE p.user_sub = ? ORDER BY CASE p.kind WHEN 'favorite' THEN 0 ELSE 1 END, p.created_at, p.id`)
    .bind(subject).all();
  return { playlists: (result?.results || []).map(mapSummary) };
}

export async function getPlaylist(db, userSub, playlistId) {
  requireDb(db);
  const subject = subjectOf(userSub);
  const id = cleanId(playlistId);
  const summary = await readSummary(db, subject, id);
  if (!summary) fail('PLAYLIST_NOT_FOUND', '歌单不存在。');
  const result = await db.prepare(`SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language, ps.sort_order, ps.added_at
    FROM Member_Playlist_Songs ps JOIN Songs s ON s.id = ps.song_id
    WHERE ps.playlist_id = ? AND EXISTS (
      SELECT 1 FROM Member_Playlists p WHERE p.id = ps.playlist_id AND p.user_sub = ?
    ) ORDER BY ps.sort_order, ps.song_id`).bind(id, subject).all();
  return { ...summary, songs: (result?.results || []).map(mapSong) };
}
