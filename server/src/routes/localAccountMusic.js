// Account-owned music routes. The caller must supply a verified normal session
// after instance-state, authentication and CSRF checks. Request data never
// determines the account used in a query.
import { readBoundedJson, RequestBodyError } from '../instance/httpSecurity.js';

const MAX_REGULAR_PLAYLISTS = 50;
const MAX_PLAYLIST_SONGS = 500;
const MAX_PLAY_EVENT_BATCH_SIZE = 25;
const MAX_PLAY_EVENT_RECEIPTS = 10_000;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

class MusicError extends Error {
  constructor(code, message, status = 400, data) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

const fail = (code, message, status = 400, data) => { throw new MusicError(code, message, status, data); };
const changed = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const rows = (result) => result?.results || [];
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
});
const success = (data, status, headers) => response({ ok: true, data }, status, headers);
const failure = (error, status, message, headers, data) => response({
  ok: false, error, message, ...(data === undefined ? {} : { data }),
}, status, headers);

const accountOf = (session) => {
  const id = session?.account?.accountId ?? session?.accountId ?? session?.account_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
};
const cleanId = (value) => typeof value === 'string' && value.trim() && value.trim().length <= 240
  ? value.trim() : fail('INVALID_BODY', 'ID 格式无效。');
const revisionOf = (value) => Number.isInteger(value) && value >= 0
  ? value : fail('INVALID_BODY', 'expectedRevision 必须是非负整数。');
const cleanName = (value) => {
  if (typeof value !== 'string' || Array.from(value.trim()).length < 1 || Array.from(value.trim()).length > 40) {
    fail('INVALID_NAME', '歌单名称需为 1 到 40 个字符。');
  }
  return value.trim();
};
const cleanDescription = (value = '') => {
  if (typeof value !== 'string' || Array.from(value.trim()).length > 300) {
    fail('INVALID_DESCRIPTION', '歌单简介不能超过 300 个字符。');
  }
  return value.trim();
};
const uniqueIds = (value, min = 0, max = MAX_PLAYLIST_SONGS) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('INVALID_BODY', 'songIds 数量无效。');
  const ids = value.map(cleanId);
  if (new Set(ids).size !== ids.length) fail('INVALID_BODY', 'songIds 不能包含重复 ID。');
  return ids;
};
const bodyOf = async (request) => {
  try {
    return await readBoundedJson(request, 64 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyError) fail('INVALID_BODY', '请求体必须是有效且不超过 64 KiB 的 JSON 对象。');
    throw error;
  }
};
const decodePart = (part) => {
  try { return cleanId(decodeURIComponent(part)); } catch (error) {
    if (error instanceof MusicError) throw error;
    fail('INVALID_BODY', '路径 ID 格式无效。');
  }
};
const parsedArray = (value) => {
  try { const data = JSON.parse(value || '[]'); return Array.isArray(data) ? data : []; } catch { return []; }
};

const SUMMARY = `SELECT p.id, p.kind, p.name, p.description, p.revision,
  p.created_at, p.updated_at, p.cached_song_count AS song_count,
  COALESCE((SELECT json_group_array(cover_url) FROM (
    SELECT s.cover_url FROM Member_Playlist_Songs ps JOIN Songs s ON s.id = ps.song_id
    WHERE ps.playlist_id = p.id AND s.cover_url IS NOT NULL AND trim(s.cover_url) <> ''
    ORDER BY ps.added_at DESC, ps.sort_order DESC, ps.song_id LIMIT 4
  )), '[]') AS preview_covers FROM Member_Playlists p`;
const mapSummary = (row) => ({
  id: row.id, source: 'member', kind: row.kind,
  name: row.kind === 'favorite' ? '我的收藏' : row.name,
  description: row.kind === 'favorite' ? '' : (row.description || ''),
  songCount: Number(row.song_count || 0),
  previewCovers: parsedArray(row.preview_covers).filter((value) => typeof value === 'string'),
  revision: Number(row.revision || 0), createdAt: Number(row.created_at || 0),
  updatedAt: Number(row.updated_at || 0),
});
const summary = async (db, accountId, playlistId) => {
  const row = await db.prepare(`${SUMMARY} WHERE p.account_id = ? AND p.id = ?`).bind(accountId, playlistId).first();
  return row ? mapSummary(row) : null;
};
const playlistRow = (db, accountId, playlistId) => db.prepare(
  'SELECT * FROM Member_Playlists WHERE account_id = ? AND id = ?',
).bind(accountId, playlistId).first();
const conflict = async (db, accountId, playlistId) => {
  const current = await summary(db, accountId, playlistId);
  fail('REVISION_CONFLICT', '歌单已在其他页面更新。', 409, current ? { playlist: current } : undefined);
};
const guardedBatch = async (db, accountId, playlistId, revision, statements) => {
  // A stale version must abort the entire D1 batch before any song writes.
  // Selecting the already-existing playlist ID deliberately violates its
  // unique key only when another writer has advanced the revision.
  const guard = db.prepare(`INSERT INTO Member_Playlists
    (id, account_id, kind, name, created_at, updated_at)
    SELECT id, account_id, kind, name, created_at, updated_at FROM Member_Playlists
    WHERE id = ? AND account_id = ? AND revision != ?`).bind(playlistId, accountId, revision);
  try {
    const result = await db.batch([guard, ...statements]);
    return result.slice(1);
  } catch (error) {
    const current = await playlistRow(db, accountId, playlistId);
    if (!current || Number(current.revision) !== revision) await conflict(db, accountId, playlistId);
    throw error;
  }
};
const ensureFavorite = async (db, accountId, now) => {
  await db.prepare(`INSERT OR IGNORE INTO Member_Playlists
    (id, account_id, kind, name, description, revision, created_at, updated_at)
    VALUES (?, ?, 'favorite', '我的收藏', '', 0, ?, ?)`).bind(`fav_${crypto.randomUUID()}`, accountId, now, now).run();
};
const assertSongs = async (db, ids) => {
  const found = new Set();
  for (let start = 0; start < ids.length; start += 90) {
    const part = ids.slice(start, start + 90);
    const result = await db.prepare(`SELECT id FROM Songs WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const row of rows(result)) found.add(row.id);
  }
  const missingSongIds = ids.filter((id) => !found.has(id));
  if (missingSongIds.length) fail('SONG_NOT_FOUND', '部分歌曲不存在。', 404, { missingSongIds });
};
const getPlaylist = async (db, accountId, playlistId) => {
  const current = await summary(db, accountId, playlistId);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。', 404);
  const result = await db.prepare(`SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url,
    s.cover_url, s.language, ps.sort_order, ps.added_at
    FROM Member_Playlist_Songs ps JOIN Songs s ON s.id = ps.song_id
    JOIN Member_Playlists p ON p.id = ps.playlist_id
    WHERE p.id = ? AND p.account_id = ? ORDER BY ps.sort_order, ps.song_id`).bind(playlistId, accountId).all();
  return { ...current, songs: rows(result).map(({ sort_order, added_at, ...song }) => ({
    ...song, sortOrder: Number(sort_order), addedAt: Number(added_at),
  })) };
};
const listPlaylists = async (db, accountId, now) => {
  await ensureFavorite(db, accountId, now);
  const result = await db.prepare(`${SUMMARY} WHERE p.account_id = ?
    ORDER BY CASE p.kind WHEN 'favorite' THEN 0 ELSE 1 END, p.created_at, p.id`).bind(accountId).all();
  return { playlists: rows(result).map(mapSummary) };
};

const shelfSources = async (db, accountId) => {
  const personal = await db.prepare("SELECT id, kind FROM Member_Playlists WHERE account_id = ? AND kind IN ('favorite', 'regular') ORDER BY CASE kind WHEN 'favorite' THEN 0 ELSE 1 END, created_at, id").bind(accountId).all();
  const memberRows = rows(personal);
  return {
    personal: memberRows.map((item) => item.id),
    favoriteId: memberRows.find((item) => item.kind === 'favorite')?.id || null,
  };
};
const canonicalShelf = (items, sources) => {
  const personal = new Set(sources.personal);
  const seen = new Set();
  const canonical = [];
  for (const item of items) {
    const kind = item?.kind;
    const id = item?.id;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    if (kind === 'member' && personal.has(id)) canonical.push({ kind, id });
    else continue;
    seen.add(key);
  }
  if (sources.favoriteId && !seen.has(`member:${sources.favoriteId}`)) {
    canonical.unshift({ kind: 'member', id: sources.favoriteId });
    seen.add(`member:${sources.favoriteId}`);
  }
  for (const id of sources.personal) if (!seen.has(`member:${id}`)) canonical.push({ kind: 'member', id });
  return canonical;
};
const mapShelf = (row, items) => ({ revision: Number(row?.revision || 0), updatedAt: Number(row?.updated_at || 0), items });
const getShelf = async (db, accountId, now) => {
  await ensureFavorite(db, accountId, now);
  const sources = await shelfSources(db, accountId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let row = await db.prepare('SELECT * FROM Member_Playlist_Shelf WHERE account_id = ?').bind(accountId).first();
    if (!row) {
      await db.prepare(`INSERT OR IGNORE INTO Member_Playlist_Shelf
        (account_id, items_json, revision, updated_at) VALUES (?, ?, 0, ?)`)
        .bind(accountId, JSON.stringify(canonicalShelf([], sources)), now).run();
      row = await db.prepare('SELECT * FROM Member_Playlist_Shelf WHERE account_id = ?').bind(accountId).first();
    }
    const parsed = parsedArray(row.items_json);
    const items = canonicalShelf(parsed, sources);
    if (JSON.stringify(parsed) === JSON.stringify(items)) return mapShelf(row, items);
    const result = await db.prepare(`UPDATE Member_Playlist_Shelf SET items_json = ?, revision = revision + 1,
      updated_at = ? WHERE account_id = ? AND revision = ?`)
      .bind(JSON.stringify(items), now, accountId, Number(row.revision)).run();
    if (changed(result) === 1) return mapShelf({ revision: Number(row.revision) + 1, updated_at: now }, items);
  }
  fail('REVISION_CONFLICT', '唱片架已在其他页面更新。', 409);
};
const updateShelf = async (db, accountId, input, now) => {
  const current = await getShelf(db, accountId, now);
  const revision = revisionOf(input.expectedRevision);
  if (current.revision !== revision) fail('REVISION_CONFLICT', '唱片架已在其他页面更新。', 409, { shelf: current });
  if (!Array.isArray(input.items) || input.items.length !== current.items.length) {
    fail('INVALID_BODY', 'items 必须包含完整唱片架。');
  }
  const items = input.items.map((item) => {
    if (!item || item.kind !== 'member' || item.hidden !== undefined) {
      fail('INVALID_BODY', '唱片架项目格式无效。');
    }
    return { kind: item.kind, id: cleanId(item.id) };
  });
  const expected = new Set(current.items.map((item) => `${item.kind}:${item.id}`));
  const actual = items.map((item) => `${item.kind}:${item.id}`);
  if (new Set(actual).size !== actual.length || actual.some((key) => !expected.has(key))) {
    fail('INVALID_BODY', 'items 必须与当前唱片架项目一致。');
  }
  if (JSON.stringify(items) === JSON.stringify(current.items)) return { outcome: 'noop', shelf: current };
  const result = await db.prepare(`UPDATE Member_Playlist_Shelf SET items_json = ?, revision = revision + 1,
    updated_at = ? WHERE account_id = ? AND revision = ?`)
    .bind(JSON.stringify(items), now, accountId, revision).run();
  if (changed(result) !== 1) fail('REVISION_CONFLICT', '唱片架已在其他页面更新。', 409, { shelf: await getShelf(db, accountId, now) });
  return { outcome: 'applied', shelf: mapShelf({ revision: revision + 1, updated_at: now }, items) };
};

const createPlaylist = async (db, accountId, input, now) => {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description ?? '');
  const initialSongs = uniqueIds(input.songIds ?? []);
  await assertSongs(db, initialSongs);
  await ensureFavorite(db, accountId, now);
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '';
  let id = `pl_${crypto.randomUUID()}`;
  if (idempotencyKey) {
    const bytes = new TextEncoder().encode(`${accountId}\0${idempotencyKey}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    id = `pl_ai_${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 40)}`;
    const previous = await summary(db, accountId, id);
    if (previous) return { outcome: 'noop', playlist: previous, shelf: await getShelf(db, accountId, now) };
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO Member_Playlists
    (id, account_id, kind, name, description, revision, created_at, updated_at)
    SELECT ?, ?, 'regular', ?, ?, 0, ?, ? WHERE
      (SELECT COUNT(*) FROM Member_Playlists WHERE account_id = ? AND kind = 'regular') < ?`)
    .bind(id, accountId, name, description, now, now, accountId, MAX_REGULAR_PLAYLISTS);
  const statements = [insert, db.prepare(`INSERT INTO Member_Playlist_Songs
    (playlist_id, song_id, sort_order, added_at) SELECT ?, value, CAST(key AS INTEGER), ? FROM json_each(?) WHERE EXISTS (
      SELECT 1 FROM Member_Playlists WHERE id = ? AND account_id = ? AND revision = 0)`)
    .bind(id, now, JSON.stringify(initialSongs), id, accountId)];
  const result = initialSongs.length ? (await db.batch(statements))[0] : await insert.run();
  if (changed(result) !== 1) {
    if (idempotencyKey) {
      const previous = await summary(db, accountId, id);
      if (previous) return { outcome: 'noop', playlist: previous, shelf: await getShelf(db, accountId, now) };
    }
    fail('PLAYLIST_LIMIT_REACHED', '每个账号最多创建 50 个普通歌单。', 409);
  }
  return { outcome: 'applied', playlist: await summary(db, accountId, id), shelf: await getShelf(db, accountId, now) };
};
const updatePlaylist = async (db, accountId, id, input, now) => {
  const current = await playlistRow(db, accountId, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。', 404);
  if (current.kind === 'favorite') fail('FAVORITE_METADATA_FORBIDDEN', '“我的收藏”名称和简介不可修改。', 409);
  const revision = revisionOf(input.expectedRevision);
  if (Number(current.revision) !== revision) await conflict(db, accountId, id);
  if (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'description')) fail('INVALID_BODY', '至少提供 name 或 description。');
  const name = Object.hasOwn(input, 'name') ? cleanName(input.name) : current.name;
  const description = Object.hasOwn(input, 'description') ? cleanDescription(input.description) : current.description;
  if (name === current.name && description === current.description) {
    return { outcome: 'noop', playlist: await summary(db, accountId, id) };
  }
  const result = await db.prepare(`UPDATE Member_Playlists SET name = ?, description = ?, revision = revision + 1,
    updated_at = ? WHERE id = ? AND account_id = ? AND revision = ?`)
    .bind(name, description, now, id, accountId, revision).run();
  if (changed(result) !== 1) await conflict(db, accountId, id);
  return { outcome: 'applied', playlist: await summary(db, accountId, id) };
};
const deletePlaylist = async (db, accountId, id, input, now) => {
  const current = await playlistRow(db, accountId, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。', 404);
  if (current.kind === 'favorite') fail('FAVORITE_DELETE_FORBIDDEN', '“我的收藏”歌单不可删除。', 409);
  const revision = revisionOf(input.expectedRevision);
  if (Number(current.revision) !== revision) await conflict(db, accountId, id);
  const result = await db.prepare(`DELETE FROM Member_Playlists WHERE id = ? AND account_id = ?
    AND kind = 'regular' AND revision = ?`).bind(id, accountId, revision).run();
  // D1 may include cascaded playlist-song deletes in meta.changes. The guarded
  // DELETE can remove at most one playlist, so any positive count means it ran.
  if (changed(result) < 1) await conflict(db, accountId, id);
  return { outcome: 'applied', deletedPlaylistId: id, shelf: await getShelf(db, accountId, now) };
};
const replaceSongs = async (db, accountId, id, input, now) => {
  const current = await playlistRow(db, accountId, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。', 404);
  const hasMetadata = Object.hasOwn(input, 'name') || Object.hasOwn(input, 'description');
  if (hasMetadata && current.kind === 'favorite') fail('FAVORITE_METADATA_FORBIDDEN', '收藏歌单不可改名。', 409);
  const name = Object.hasOwn(input, 'name') ? cleanName(input.name) : current.name;
  const description = Object.hasOwn(input, 'description') ? cleanDescription(input.description) : current.description;
  if (Array.isArray(input.songIds) && input.songIds.length > MAX_PLAYLIST_SONGS) {
    fail('PLAYLIST_SONG_LIMIT_REACHED', '每个歌单最多保存 500 首歌曲。', 409);
  }
  const ids = uniqueIds(input.songIds);
  const revision = revisionOf(input.expectedRevision);
  if (Number(current.revision) !== revision) await conflict(db, accountId, id);
  await assertSongs(db, ids);
  const existing = await db.prepare(`SELECT ps.song_id FROM Member_Playlist_Songs ps
    JOIN Member_Playlists p ON p.id = ps.playlist_id
    WHERE p.id = ? AND p.account_id = ? ORDER BY ps.sort_order, ps.song_id`).bind(id, accountId).all();
  const before = rows(existing).map((row) => row.song_id);
  if (before.length === ids.length && before.every((songId, index) => songId === ids[index])
    && name === current.name && description === current.description) {
    return { outcome: 'noop', playlist: await getPlaylist(db, accountId, id) };
  }
  // D1 batch is transactional. A failed compare-and-swap leaves every later
  // statement inert because all writes require the incremented revision.
  const statements = [db.prepare(`UPDATE Member_Playlists SET revision = revision + 1, updated_at = ?, name = ?, description = ?
    WHERE id = ? AND account_id = ? AND revision = ?`).bind(now, name, description, id, accountId, revision)];
  statements.push(db.prepare(`DELETE FROM Member_Playlist_Songs WHERE playlist_id = ? AND EXISTS (
    SELECT 1 FROM Member_Playlists WHERE id = ? AND account_id = ? AND revision = ?
  )`).bind(id, id, accountId, revision + 1));
  if (ids.length) statements.push(db.prepare(`INSERT INTO Member_Playlist_Songs
    (playlist_id, song_id, sort_order, added_at) SELECT ?, value, CAST(key AS INTEGER), ? FROM json_each(?) WHERE EXISTS (
      SELECT 1 FROM Member_Playlists WHERE id = ? AND account_id = ? AND revision = ?
    )`).bind(id, now, JSON.stringify(ids), id, accountId, revision + 1));
  const result = await guardedBatch(db, accountId, id, revision, statements);
  if (changed(result[0]) !== 1) await conflict(db, accountId, id);
  return { outcome: 'applied', playlist: await getPlaylist(db, accountId, id) };
};
const removeSong = async (db, accountId, id, songId, input, now) => {
  const current = await playlistRow(db, accountId, id);
  if (!current) fail('PLAYLIST_NOT_FOUND', '歌单不存在。', 404);
  const revision = revisionOf(input.expectedRevision);
  if (Number(current.revision) !== revision) await conflict(db, accountId, id);
  const target = await db.prepare('SELECT sort_order FROM Member_Playlist_Songs WHERE playlist_id = ? AND song_id = ?')
    .bind(id, songId).first();
  if (!target) return { outcome: 'noop', playlist: await getPlaylist(db, accountId, id) };
  const result = await guardedBatch(db, accountId, id, revision, [
    db.prepare(`UPDATE Member_Playlists SET revision = revision + 1, updated_at = ?
      WHERE id = ? AND account_id = ? AND revision = ?`).bind(now, id, accountId, revision),
    db.prepare(`DELETE FROM Member_Playlist_Songs WHERE playlist_id = ? AND song_id = ? AND EXISTS (
      SELECT 1 FROM Member_Playlists WHERE id = ? AND account_id = ? AND revision = ?
    )`).bind(id, songId, id, accountId, revision + 1),
    db.prepare(`UPDATE Member_Playlist_Songs SET sort_order = sort_order - 1 WHERE playlist_id = ?
      AND sort_order > ? AND EXISTS (
        SELECT 1 FROM Member_Playlists WHERE id = ? AND account_id = ? AND revision = ?
      )`).bind(id, Number(target.sort_order), id, accountId, revision + 1),
  ]);
  if (changed(result[0]) !== 1) await conflict(db, accountId, id);
  return { outcome: 'applied', playlist: await getPlaylist(db, accountId, id) };
};
const addSongs = async (db, accountId, input, now) => {
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 50) {
    fail('INVALID_BODY', 'targets 数量需为 1 到 50。');
  }
  const targets = input.targets.map((target) => ({
    playlistId: cleanId(target?.playlistId), expectedRevision: revisionOf(target?.expectedRevision),
  }));
  if (new Set(targets.map((target) => target.playlistId)).size !== targets.length) {
    fail('INVALID_BODY', 'targets 不能包含重复歌单。');
  }
  const songIds = uniqueIds(input.songIds, 1, 100);
  if (targets.length * songIds.length > 500) fail('INVALID_BODY', '一次请求的歌单与歌曲组合不能超过 500。');
  await assertSongs(db, songIds);
  const results = [];
  for (const target of targets) {
    const current = await playlistRow(db, accountId, target.playlistId);
    if (!current) {
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds: [], error: 'PLAYLIST_NOT_FOUND' });
      continue;
    }
    if (Number(current.revision) !== target.expectedRevision) {
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds: [], revision: Number(current.revision), error: 'REVISION_CONFLICT' });
      continue;
    }
    const existing = new Set(rows(await db.prepare(`SELECT song_id FROM Member_Playlist_Songs WHERE playlist_id = ?`)
      .bind(target.playlistId).all()).map((row) => row.song_id));
    const addedSongIds = songIds.filter((id) => !existing.has(id));
    const noopSongIds = songIds.filter((id) => existing.has(id));
    if (!addedSongIds.length) {
      results.push({ playlistId: target.playlistId, outcome: 'noop', addedSongIds, noopSongIds, revision: Number(current.revision) });
      continue;
    }
    const count = Number((await db.prepare('SELECT COUNT(*) AS count FROM Member_Playlist_Songs WHERE playlist_id = ?')
      .bind(target.playlistId).first())?.count || 0);
    if (count + addedSongIds.length > MAX_PLAYLIST_SONGS) {
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds, revision: Number(current.revision), error: 'PLAYLIST_SONG_LIMIT_REACHED' });
      continue;
    }
    const statements = [db.prepare(`UPDATE Member_Playlists SET revision = revision + 1, updated_at = ?
      WHERE id = ? AND account_id = ? AND revision = ? AND
      (SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = ?) + ? <= ?`)
      .bind(now, target.playlistId, accountId, target.expectedRevision, target.playlistId, addedSongIds.length, MAX_PLAYLIST_SONGS)];
    addedSongIds.forEach((songId, index) => statements.push(db.prepare(`INSERT OR IGNORE INTO Member_Playlist_Songs
      (playlist_id, song_id, sort_order, added_at) SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM Member_Playlists WHERE id = ? AND account_id = ? AND revision = ?
      )`).bind(target.playlistId, songId, count + index, now,
      target.playlistId, accountId, target.expectedRevision + 1)));
    let batch;
    try {
      batch = await guardedBatch(db, accountId, target.playlistId, target.expectedRevision, statements);
    } catch (error) {
      if (!(error instanceof MusicError) || error.code !== 'REVISION_CONFLICT') throw error;
      const latest = await playlistRow(db, accountId, target.playlistId);
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds,
        revision: Number(latest?.revision ?? target.expectedRevision), error: 'REVISION_CONFLICT' });
      continue;
    }
    if (changed(batch[0]) !== 1) {
      const latest = await playlistRow(db, accountId, target.playlistId);
      results.push({ playlistId: target.playlistId, outcome: 'failed', addedSongIds: [], noopSongIds,
        revision: Number(latest?.revision ?? target.expectedRevision), error: 'REVISION_CONFLICT' });
      continue;
    }
    results.push({ playlistId: target.playlistId, outcome: 'applied', addedSongIds, noopSongIds,
      revision: target.expectedRevision + 1 });
  }
  const affectedPlaylistIds = results.filter((item) => item.outcome === 'applied').map((item) => item.playlistId);
  const outcome = results.some((item) => item.outcome === 'failed')
    ? (affectedPlaylistIds.length ? 'partial' : 'failed')
    : (affectedPlaylistIds.length ? 'applied' : 'noop');
  return { outcome, results, affectedPlaylistIds };
};

const cleanEvents = (events) => {
  if (!Array.isArray(events)) fail('INVALID_BODY', 'events 必须是数组。');
  if (events.length > MAX_PLAY_EVENT_BATCH_SIZE) fail('PAYLOAD_TOO_LARGE', '单次最多批量上报 25 条播放事件。');
  const unique = new Map();
  for (const item of events) {
    const eventId = typeof item?.event_id === 'string' ? item.event_id.trim() : '';
    const songId = typeof item?.song_id === 'string' ? item.song_id.trim() : '';
    const playedAt = Number(item?.played_at);
    if (!eventId || eventId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(eventId)
      || !songId || songId.length > 256 || !Number.isSafeInteger(playedAt) || playedAt <= 0) {
      fail('INVALID_BODY', '播放事件格式无效。');
    }
    if (!unique.has(eventId)) unique.set(eventId, { eventId, songId, playedAt });
  }
  return [...unique.values()];
};
const recordPlays = async (db, accountId, input, now) => {
  const events = cleanEvents(input.events);
  if (!events.length) return { recorded: 0, acceptedEventIds: [] };
  await db.prepare('DELETE FROM Member_Play_Events WHERE account_id = ? AND received_at < ?')
    .bind(accountId, now - RECEIPT_RETENTION_MS).run();
  const inventory = await db.prepare(`WITH incoming(event_id, song_id) AS
    (VALUES ${events.map(() => '(?, ?)').join(',')})
    SELECT incoming.event_id,
      EXISTS(SELECT 1 FROM Songs WHERE id = incoming.song_id) AS song_exists,
      EXISTS(SELECT 1 FROM Member_Play_Events WHERE account_id = ? AND event_id = incoming.event_id) AS already_received
    FROM incoming`).bind(...events.flatMap((event) => [event.eventId, event.songId]), accountId).all();
  const available = new Map(rows(inventory).map((row) => [row.event_id, row]));
  const fresh = events.filter((event) => {
    const item = available.get(event.eventId);
    return Boolean(item?.song_exists) && !item?.already_received;
  });
  const current = Number((await db.prepare(`SELECT COUNT(*) AS count FROM Member_Play_Events
    WHERE account_id = ? AND received_at >= ?`).bind(accountId, now - RECEIPT_RETENTION_MS).first())?.count || 0);
  if (current + fresh.length > MAX_PLAY_EVENT_RECEIPTS) {
    fail('PLAY_EVENT_BUDGET_EXCEEDED', '近期播放事件过多，请稍后重试。', 429);
  }
  // D1 batch is transactional. Recheck quota as its first write so another
  // request cannot take the remaining slots between the preflight and inserts.
  // This deliberately conflicts with an existing receipt when the quota is
  // exhausted, rolling back the whole batch (the same guard pattern used for
  // playlist revisions above).
  const statements = [db.prepare(`INSERT INTO Member_Play_Events
    (account_id, event_id, song_id, played_at, received_at)
    SELECT e.account_id, e.event_id, e.song_id, e.played_at, e.received_at
    FROM Member_Play_Events e WHERE e.account_id = ?
      AND (SELECT COUNT(*) FROM Member_Play_Events WHERE account_id = ?) + ? > ?
    LIMIT 1`).bind(accountId, accountId, fresh.length, MAX_PLAY_EVENT_RECEIPTS)];
  fresh.forEach((event) => statements.push(db.prepare(`INSERT INTO Member_Play_Events
    (account_id, event_id, song_id, played_at, received_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM Songs WHERE id = ?)
    ON CONFLICT(account_id, event_id) DO NOTHING`).bind(accountId, event.eventId, event.songId,
    event.playedAt, now, event.songId)));
  let results = [];
  if (fresh.length) {
    try {
      results = (await db.batch(statements)).slice(1);
    } catch (error) {
      const latest = Number((await db.prepare(`SELECT COUNT(*) AS count FROM Member_Play_Events
        WHERE account_id = ?`).bind(accountId).first())?.count || 0);
      if (latest + fresh.length > MAX_PLAY_EVENT_RECEIPTS) {
        fail('PLAY_EVENT_BUDGET_EXCEEDED', '近期播放事件过多，请稍后重试。', 429);
      }
      throw error;
    }
  }
  // D1 meta.changes includes the summary trigger's write. Each statement can
  // insert at most one event, so count successful statements instead.
  const recorded = results.filter((result) => changed(result) > 0).length;
  // A song can disappear or another request can insert the same event after
  // preflight. Only acknowledge an event if its receipt exists, or its song
  // is now definitely absent.
  const unresolved = await db.prepare(`WITH incoming(event_id, song_id) AS
    (VALUES ${events.map(() => '(?, ?)').join(',')})
    SELECT 1 AS pending FROM incoming i JOIN Songs s ON s.id = i.song_id
    WHERE NOT EXISTS (SELECT 1 FROM Member_Play_Events r
      WHERE r.account_id = ? AND r.event_id = i.event_id) LIMIT 1`)
    .bind(...events.flatMap((event) => [event.eventId, event.songId]), accountId).first();
  if (unresolved) fail('PLAY_EVENT_BUDGET_EXCEEDED', '近期播放事件过多，请稍后重试。', 429);
  return { recorded, acceptedEventIds: events.map((event) => event.eventId) };
};
const topPlays = async (db, accountId, input, summaryOnly = false) => {
  const parsed = Number(input);
  const limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 20;
  const songsRequest = db.prepare(`SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url,
      s.cover_url, s.language, p.play_count, p.last_played_at
      FROM Member_Song_Plays p JOIN Songs s ON s.id = p.song_id
      WHERE p.account_id = ? ORDER BY p.play_count DESC, p.last_played_at DESC LIMIT ?`)
      .bind(accountId, limit).all();
  // Home needs only the indexed top list, never the account's complete counts.
  if (summaryOnly) return { songs: rows(await songsRequest), topAlbums: [], view: 'summary' };
  const [songs, playRows] = await Promise.all([
    songsRequest,
    db.prepare(`SELECT song_id, play_count FROM Member_Song_Plays WHERE account_id = ?`)
      .bind(accountId).all(),
  ]);
  const allCounts = rows(playRows);
  const playCounts = Object.fromEntries(allCounts.map((row) => [row.song_id, Number(row.play_count || 0)]));
  return { songs: rows(songs), playCounts,
    totalPlays: allCounts.reduce((total, row) => total + Number(row.play_count || 0), 0),
    totalUniqueSongs: allCounts.length,
    topAlbums: [] };
};

const ACCOUNT_PATHS = /^\/api\/account\/(?:playlists(?:\/|$)|playlist-songs$|playlist-shelf(?:\/|$)|play-stats$)/;

// Internal adapters must provide a verified account id; never export an HTTP
// bypass. All writes retain the same quotas, ownership and revision guards.
export const accountMusic = Object.freeze({ listPlaylists, getPlaylist, createPlaylist,
  replaceSongs, deletePlaylist });

// Assistant tools call the same account-scoped operations after the outer
// router has verified the local session and CSRF token.
export const localAccountPlaylistActions = Object.freeze({
  listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist,
  replaceSongs, addSongs,
});

export async function handleLocalAccountMusicRoute(request, url, db, headers = {}, session) {
  const path = url.pathname;
  if (!ACCOUNT_PATHS.test(path)) return null;
  const accountId = accountOf(session);
  if (!accountId || session?.mode !== 'normal') {
    return failure('AUTH_REQUIRED', 401, '需要登录账号才能访问个人音乐数据。', headers);
  }
  const expectedAccount = request.headers.get('X-FlareTune-Expected-Account');
  if (expectedAccount && expectedAccount !== accountId) {
    return failure('ACCOUNT_CONTEXT_CHANGED', 409, '账号已切换，请重试。', headers);
  }
  if (!db?.prepare || !db?.batch) {
    return failure('MUSIC_STORAGE_UNAVAILABLE', 503, '个人音乐数据暂时不可用。', headers);
  }
  const now = Date.now();
  try {
    if (path === '/api/account/playlists') {
      if (request.method === 'GET') return success(await listPlaylists(db, accountId, now), 200, headers);
      if (request.method === 'POST') return success(await createPlaylist(db, accountId, await bodyOf(request), now), 201, headers);
    }
    if (path === '/api/account/playlist-songs' && request.method === 'POST') {
      return success(await addSongs(db, accountId, await bodyOf(request), now), 200, headers);
    }
    if (path === '/api/account/playlist-shelf') {
      if (request.method === 'GET') return success({ shelf: await getShelf(db, accountId, now) }, 200, headers);
      if (request.method === 'PUT') return success(await updateShelf(db, accountId, await bodyOf(request), now), 200, headers);
    }
    if (path === '/api/account/play-stats') {
      if (request.method === 'GET') return success(await topPlays(db, accountId,
        url.searchParams.get('limit') || 20, url.searchParams.get('view') === 'summary'), 200, headers);
      if (request.method === 'POST') return success(await recordPlays(db, accountId, await bodyOf(request), now), 200, headers);
      return failure('METHOD_NOT_ALLOWED', 405, '不支持的请求方法。', headers);
    }
    const songMatch = /^\/api\/account\/playlists\/([^/]+)\/songs\/([^/]+)$/.exec(path);
    if (songMatch && request.method === 'DELETE') {
      return success(await removeSong(db, accountId, decodePart(songMatch[1]), decodePart(songMatch[2]), await bodyOf(request), now), 200, headers);
    }
    const songsMatch = /^\/api\/account\/playlists\/([^/]+)\/songs$/.exec(path);
    if (songsMatch && request.method === 'PUT') {
      return success(await replaceSongs(db, accountId, decodePart(songsMatch[1]), await bodyOf(request), now), 200, headers);
    }
    const playlistMatch = /^\/api\/account\/playlists\/([^/]+)$/.exec(path);
    if (playlistMatch) {
      const id = decodePart(playlistMatch[1]);
      if (request.method === 'GET') return success({ playlist: await getPlaylist(db, accountId, id) }, 200, headers);
      if (request.method === 'PUT') return success(await updatePlaylist(db, accountId, id, await bodyOf(request), now), 200, headers);
      if (request.method === 'DELETE') return success(await deletePlaylist(db, accountId, id, await bodyOf(request), now), 200, headers);
    }
    return failure('PLAYLIST_NOT_FOUND', 404, '接口不存在。', headers);
  } catch (error) {
    if (error instanceof MusicError) return failure(error.code, error.status, error.message, headers, error.data);
    return failure('MUSIC_STORAGE_UNAVAILABLE', 503, '个人音乐数据暂时不可用。', headers);
  }
}
