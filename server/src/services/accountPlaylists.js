import {
  MAX_ADD_SONGS,
  MAX_ADD_TARGETS,
  MAX_PLAYLIST_SONGS,
  MAX_REGULAR_PLAYLISTS,
  AccountPlaylistError,
  assertSongsExist,
  changes,
  cleanDescription,
  cleanId,
  cleanName,
  conflict,
  fail,
  readPlaylistRow,
  readSummary,
  requireDb,
  revisionOf,
  stablePlaylistId,
  subjectOf,
  uniqueIds,
} from './accountPlaylistCore.js';
import { ensureFavoriteInternal, getPlaylist, listPlaylists } from './accountPlaylistRead.js';
import {
  getPlaylistShelf,
  updatePlaylistShelf,
} from './accountPlaylistShelf.js';

export {
  AccountPlaylistError,
  getPlaylist,
  getPlaylistShelf,
  listPlaylists,
  updatePlaylistShelf,
};

export async function createPlaylist(db, userSub, input = {}, now = Date.now(), options = {}) {
  requireDb(db);
  const subject = subjectOf(userSub);
  const name = cleanName(input?.name);
  const description = cleanDescription(input?.description ?? '');
  await ensureFavoriteInternal(db, subject, now);
  const idempotencyKey = options?.idempotencyKey;
  const id = idempotencyKey ? await stablePlaylistId(subject, idempotencyKey) : `pl_${crypto.randomUUID()}`;
  if (idempotencyKey) {
    const existing = await readSummary(db, subject, id);
    if (existing) return { outcome: 'noop', playlist: existing, shelf: await getPlaylistShelf(db, subject, now) };
  }
  const result = await db.prepare(`INSERT OR IGNORE INTO Member_Playlists
    (id, user_sub, kind, name, description, revision, created_at, updated_at)
    SELECT ?, ?, 'regular', ?, ?, 0, ?, ?
    WHERE (SELECT COUNT(*) FROM Member_Playlists WHERE user_sub = ? AND kind = 'regular') < ?`)
    .bind(id, subject, name, description, now, now, subject, MAX_REGULAR_PLAYLISTS).run();
  if (changes(result) !== 1) {
    const existing = idempotencyKey ? await readSummary(db, subject, id) : null;
    if (existing) return { outcome: 'noop', playlist: existing, shelf: await getPlaylistShelf(db, subject, now) };
    fail('PLAYLIST_LIMIT_REACHED', '每个账号最多创建 50 个普通歌单。');
  }
  return { outcome: 'applied', playlist: await readSummary(db, subject, id), shelf: await getPlaylistShelf(db, subject, now) };
}

export async function updatePlaylist(db, userSub, playlistId, input = {}, now = Date.now()) {
  requireDb(db);
  const subject = subjectOf(userSub);
  const id = cleanId(playlistId);
  const hasName = Object.hasOwn(input || {}, 'name');
  const hasDescription = Object.hasOwn(input || {}, 'description');
  if (!hasName && !hasDescription) fail('INVALID_BODY', '至少提供 name 或 description。');
  const current = await readPlaylistRow(db, subject, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。');
  if (current.kind === 'favorite') fail('FAVORITE_METADATA_FORBIDDEN', '“我的收藏”名称和简介不可修改。');
  const expectedRevision = revisionOf(input.expectedRevision);
  if (Number(current.revision) !== expectedRevision) await conflict(db, subject, id);
  const name = hasName ? cleanName(input.name) : current.name;
  const description = hasDescription ? cleanDescription(input.description) : current.description;
  if (name === current.name && description === current.description) {
    return { outcome: 'noop', playlist: await readSummary(db, subject, id) };
  }
  const result = await db.prepare(`UPDATE Member_Playlists
    SET name = ?, description = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND user_sub = ? AND revision = ?`)
    .bind(name, description, now, id, subject, expectedRevision).run();
  if (changes(result) !== 1) await conflict(db, subject, id);
  return { outcome: 'applied', playlist: await readSummary(db, subject, id) };
}

export async function deletePlaylist(db, userSub, playlistId, expectedRevision, now = Date.now()) {
  requireDb(db);
  const subject = subjectOf(userSub);
  const id = cleanId(playlistId);
  const current = await readPlaylistRow(db, subject, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。');
  if (current.kind === 'favorite') fail('FAVORITE_DELETE_FORBIDDEN', '“我的收藏”歌单不可删除。');
  const revision = revisionOf(expectedRevision);
  if (Number(current.revision) !== revision) await conflict(db, subject, id);
  const result = await db.prepare(
    'DELETE FROM Member_Playlists WHERE id = ? AND user_sub = ? AND kind = ? AND revision = ?',
  ).bind(id, subject, 'regular', revision).run();
  if (changes(result) !== 1) await conflict(db, subject, id);
  return { outcome: 'applied', deletedPlaylistId: id, shelf: await getPlaylistShelf(db, subject, now) };
}

export async function addSongsToPlaylists(db, userSub, input = {}, now = Date.now()) {
  requireDb(db, true);
  const subject = subjectOf(userSub);
  if (!Array.isArray(input?.targets) || input.targets.length < 1 || input.targets.length > MAX_ADD_TARGETS) {
    fail('INVALID_BODY', 'targets 数量需为 1 到 50。');
  }
  const targets = input.targets.map((target) => ({
    playlistId: cleanId(target?.playlistId),
    expectedRevision: revisionOf(target?.expectedRevision),
  }));
  if (new Set(targets.map((target) => target.playlistId)).size !== targets.length) {
    fail('INVALID_BODY', 'targets 不能包含重复歌单。');
  }
  const songIds = uniqueIds(input.songIds, { min: 1, max: MAX_ADD_SONGS });
  if (targets.length * songIds.length > 500) fail('INVALID_BODY', '一次请求的歌单与歌曲组合不能超过 500。');
  await assertSongsExist(db, songIds);

  const results = [];
  for (const target of targets) {
    const current = await readPlaylistRow(db, subject, target.playlistId);
    if (!current) {
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds: [], error: 'PLAYLIST_NOT_FOUND' });
      continue;
    }
    if (Number(current.revision) !== target.expectedRevision) {
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds: [], revision: Number(current.revision), error: 'REVISION_CONFLICT' });
      continue;
    }
    const existingResult = await db.prepare(`SELECT ps.song_id FROM Member_Playlist_Songs ps
      WHERE ps.playlist_id = ? AND EXISTS (
        SELECT 1 FROM Member_Playlists p WHERE p.id = ps.playlist_id AND p.user_sub = ?
      )`).bind(target.playlistId, subject).all();
    const existing = new Set((existingResult?.results || []).map((row) => row.song_id));
    const addedSongIds = songIds.filter((id) => !existing.has(id));
    const noopSongIds = songIds.filter((id) => existing.has(id));
    if (addedSongIds.length === 0) {
      results.push({ playlistId: target.playlistId, outcome: 'noop', addedSongIds, noopSongIds, revision: Number(current.revision) });
      continue;
    }
    const countRow = await db.prepare(`SELECT COUNT(*) AS count FROM Member_Playlist_Songs ps
      WHERE ps.playlist_id = ? AND EXISTS (
        SELECT 1 FROM Member_Playlists p WHERE p.id = ps.playlist_id AND p.user_sub = ?
      )`).bind(target.playlistId, subject).first();
    const currentCount = Number(countRow?.count || 0);
    if (currentCount + addedSongIds.length > MAX_PLAYLIST_SONGS) {
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds, revision: Number(current.revision), error: 'PLAYLIST_SONG_LIMIT_REACHED' });
      continue;
    }
    const statements = addedSongIds.map((songId, index) => db.prepare(`INSERT INTO Member_Playlist_Songs
      (playlist_id, song_id, sort_order, added_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM Member_Playlists WHERE id = ? AND user_sub = ? AND revision = ?
      ) AND (SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = ?) + ? <= ?`)
      .bind(
        target.playlistId,
        songId,
        currentCount + index,
        now,
        target.playlistId,
        subject,
        target.expectedRevision,
        target.playlistId,
        addedSongIds.length - index,
        MAX_PLAYLIST_SONGS,
      ));
    statements.push(db.prepare(`UPDATE Member_Playlists SET revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_sub = ? AND revision = ?`).bind(now, target.playlistId, subject, target.expectedRevision));
    const batchResults = await db.batch(statements);
    if (changes(batchResults[batchResults.length - 1]) !== 1) {
      const latest = await readPlaylistRow(db, subject, target.playlistId);
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds, revision: Number(latest?.revision ?? target.expectedRevision), error: 'REVISION_CONFLICT' });
      continue;
    }
    results.push({ playlistId: target.playlistId, outcome: 'applied', addedSongIds, noopSongIds, revision: target.expectedRevision + 1 });
  }

  const affectedPlaylistIds = results.filter((result) => result.outcome === 'applied').map((result) => result.playlistId);
  const hasFailure = results.some((result) => result.outcome === 'failed');
  const outcome = hasFailure
    ? (affectedPlaylistIds.length ? 'partial' : 'failed')
    : (affectedPlaylistIds.length ? 'applied' : 'noop');
  return { outcome, results, affectedPlaylistIds };
}

export async function replacePlaylistSongs(db, userSub, playlistId, songIdsInput, expectedRevision, now = Date.now()) {
  requireDb(db, true);
  const subject = subjectOf(userSub);
  const id = cleanId(playlistId);
  const current = await readPlaylistRow(db, subject, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。');
  if (Array.isArray(songIdsInput) && songIdsInput.length > MAX_PLAYLIST_SONGS) {
    fail('PLAYLIST_SONG_LIMIT_REACHED', '每个歌单最多保存 500 首歌曲。');
  }
  const songIds = uniqueIds(songIdsInput, { min: 0, max: MAX_PLAYLIST_SONGS });
  const revision = revisionOf(expectedRevision);
  if (Number(current.revision) !== revision) await conflict(db, subject, id);
  await assertSongsExist(db, songIds);
  const existingResult = await db.prepare(
    `SELECT song_id FROM Member_Playlist_Songs ps WHERE playlist_id = ? AND EXISTS (
      SELECT 1 FROM Member_Playlists p WHERE p.id = ps.playlist_id AND p.user_sub = ?
    ) ORDER BY sort_order, song_id`,
  ).bind(id, subject).all();
  const existingIds = (existingResult?.results || []).map((row) => row.song_id);
  if (existingIds.length === songIds.length && existingIds.every((value, index) => value === songIds[index])) {
    return { outcome: 'noop', playlist: await getPlaylist(db, subject, id) };
  }
  const statements = [db.prepare(`DELETE FROM Member_Playlist_Songs WHERE playlist_id = ? AND EXISTS (
    SELECT 1 FROM Member_Playlists WHERE id = ? AND user_sub = ? AND revision = ?
  )`).bind(id, id, subject, revision)];
  songIds.forEach((songId, index) => statements.push(db.prepare(`INSERT INTO Member_Playlist_Songs
    (playlist_id, song_id, sort_order, added_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM Member_Playlists WHERE id = ? AND user_sub = ? AND revision = ?
    )`).bind(id, songId, index, now, id, subject, revision)));
  statements.push(db.prepare(`UPDATE Member_Playlists SET revision = revision + 1, updated_at = ?
    WHERE id = ? AND user_sub = ? AND revision = ?`).bind(now, id, subject, revision));
  const results = await db.batch(statements);
  if (changes(results[results.length - 1]) !== 1) await conflict(db, subject, id);
  return { outcome: 'applied', playlist: await getPlaylist(db, subject, id) };
}

export async function removePlaylistSong(db, userSub, playlistId, songId, expectedRevision, now = Date.now()) {
  requireDb(db, true);
  const subject = subjectOf(userSub);
  const id = cleanId(playlistId);
  const targetSongId = cleanId(songId);
  const revision = revisionOf(expectedRevision);
  const current = await readPlaylistRow(db, subject, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。');
  if (Number(current.revision) !== revision) await conflict(db, subject, id);
  const existing = await db.prepare(
    `SELECT sort_order FROM Member_Playlist_Songs ps WHERE playlist_id = ? AND song_id = ? AND EXISTS (
      SELECT 1 FROM Member_Playlists p WHERE p.id = ps.playlist_id AND p.user_sub = ?
    )`,
  ).bind(id, targetSongId, subject).first();
  if (!existing) return { outcome: 'noop', playlist: await getPlaylist(db, subject, id) };
  const removedOrder = Number(existing.sort_order);
  const results = await db.batch([
    db.prepare(`DELETE FROM Member_Playlist_Songs WHERE playlist_id = ? AND song_id = ? AND EXISTS (
      SELECT 1 FROM Member_Playlists WHERE id = ? AND user_sub = ? AND revision = ?
    )`).bind(id, targetSongId, id, subject, revision),
    db.prepare(`UPDATE Member_Playlist_Songs SET sort_order = sort_order - 1
      WHERE playlist_id = ? AND sort_order > ? AND EXISTS (
        SELECT 1 FROM Member_Playlists WHERE id = ? AND user_sub = ? AND revision = ?
      )`).bind(id, removedOrder, id, subject, revision),
    db.prepare(`UPDATE Member_Playlists SET revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_sub = ? AND revision = ?`).bind(now, id, subject, revision),
  ]);
  if (changes(results[2]) !== 1) await conflict(db, subject, id);
  return { outcome: 'applied', playlist: await getPlaylist(db, subject, id) };
}

export const clearPlaylistSongs = (db, userSub, playlistId, expectedRevision, now) => (
  replacePlaylistSongs(db, userSub, playlistId, [], expectedRevision, now)
);
