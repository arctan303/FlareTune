export const MAX_REGULAR_PLAYLISTS = 50;
export const MAX_PLAYLIST_SONGS = 500;
export const MAX_ADD_TARGETS = 50;
export const MAX_ADD_SONGS = 100;
const QUERY_ID_CHUNK_SIZE = 90;

export const SUMMARY_SQL = `
  SELECT p.*,
    (SELECT COUNT(*) FROM Member_Playlist_Songs ps WHERE ps.playlist_id = p.id) AS song_count,
    COALESCE((SELECT json_group_array(cover_url) FROM (
      SELECT s.cover_url AS cover_url
      FROM Member_Playlist_Songs ps
      JOIN Songs s ON s.id = ps.song_id
      WHERE ps.playlist_id = p.id AND s.cover_url IS NOT NULL AND trim(s.cover_url) <> ''
      ORDER BY ps.added_at DESC, ps.sort_order DESC, ps.song_id LIMIT 4
    )), '[]') AS preview_covers
  FROM Member_Playlists p`;

const ERROR_STATUS = {
  AUTH_REQUIRED: 401,
  INVALID_BODY: 400,
  INVALID_NAME: 400,
  INVALID_DESCRIPTION: 400,
  SONG_NOT_FOUND: 404,
  PLAYLIST_NOT_FOUND: 404,
  FAVORITE_DELETE_FORBIDDEN: 409,
  FAVORITE_METADATA_FORBIDDEN: 409,
  PLAYLIST_LIMIT_REACHED: 409,
  PLAYLIST_SONG_LIMIT_REACHED: 409,
  REVISION_CONFLICT: 409,
};

export class AccountPlaylistError extends Error {
  constructor(code, message, data) {
    super(message || code);
    this.name = 'AccountPlaylistError';
    this.code = code;
    this.status = ERROR_STATUS[code] || 500;
    this.data = data;
  }
}

export const fail = (code, message, data) => { throw new AccountPlaylistError(code, message, data); };
export const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export const requireDb = (db, needsBatch = false) => {
  if (!db?.prepare || (needsBatch && typeof db.batch !== 'function')) throw new Error('MUSIC_STORAGE_UNAVAILABLE');
  return db;
};

export const subjectOf = (userSub) => {
  const subject = typeof userSub === 'string' ? userSub.trim() : '';
  if (!subject) fail('AUTH_REQUIRED', '需要登录账号才能管理个人歌单。');
  return subject;
};

export const cleanId = (value) => typeof value === 'string' && value.trim() && value.trim().length <= 240
  ? value.trim()
  : fail('INVALID_BODY', 'ID 格式无效。');

export const cleanName = (value) => {
  if (typeof value !== 'string') fail('INVALID_NAME', '歌单名称必须是字符串。');
  const name = value.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 40) fail('INVALID_NAME', '歌单名称需为 1 到 40 个字符。');
  return name;
};

export const cleanDescription = (value = '') => {
  if (typeof value !== 'string') fail('INVALID_DESCRIPTION', '歌单简介必须是字符串。');
  const description = value.trim();
  if (Array.from(description).length > 300) fail('INVALID_DESCRIPTION', '歌单简介不能超过 300 个字符。');
  return description;
};

export const stablePlaylistId = async (subject, idempotencyKey) => {
  const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
  if (!key || key.length > 240) fail('INVALID_BODY', 'idempotencyKey 格式无效。');
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${subject}\u0000${key}`),
  ));
  return `pl_${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const revisionOf = (value) => {
  if (!Number.isInteger(value) || value < 0) fail('INVALID_BODY', 'expectedRevision 必须是非负整数。');
  return value;
};

export const uniqueIds = (values, { min = 0, max = MAX_PLAYLIST_SONGS, label = 'songIds' } = {}) => {
  if (!Array.isArray(values) || values.length < min || values.length > max) {
    fail('INVALID_BODY', `${label} 数量无效。`);
  }
  const ids = values.map(cleanId);
  if (new Set(ids).size !== ids.length) fail('INVALID_BODY', `${label} 不能包含重复 ID。`);
  return ids;
};

export const parseJsonArray = (value) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const mapSummary = (row) => ({
  id: row.id,
  source: 'member',
  kind: row.kind,
  name: row.kind === 'favorite' ? '我的收藏' : row.name,
  description: row.kind === 'favorite' ? '' : (row.description || ''),
  songCount: Number(row.song_count || 0),
  previewCovers: parseJsonArray(row.preview_covers).filter((value) => typeof value === 'string'),
  revision: Number(row.revision || 0),
  createdAt: Number(row.created_at || 0),
  updatedAt: Number(row.updated_at || 0),
});

export const mapSong = (row) => {
  const { sort_order: sortOrder, added_at: addedAt, ...song } = row;
  return { ...song, sortOrder: Number(sortOrder), addedAt: Number(addedAt) };
};

export const readSummary = async (db, subject, playlistId) => {
  const row = await db.prepare(`${SUMMARY_SQL} WHERE p.user_sub = ? AND p.id = ?`)
    .bind(subject, playlistId).first();
  return row ? mapSummary(row) : null;
};

export const readPlaylistRow = (db, subject, playlistId) => db.prepare(
  'SELECT * FROM Member_Playlists WHERE user_sub = ? AND id = ?',
).bind(subject, playlistId).first();

export const conflict = async (db, subject, playlistId) => {
  const playlist = await readSummary(db, subject, playlistId);
  fail('REVISION_CONFLICT', '歌单已在其他页面更新。', playlist ? { playlist } : undefined);
};

export const assertSongsExist = async (db, songIds) => {
  if (songIds.length === 0) return;
  const found = new Set();
  for (let offset = 0; offset < songIds.length; offset += QUERY_ID_CHUNK_SIZE) {
    const chunk = songIds.slice(offset, offset + QUERY_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db.prepare(`SELECT id FROM Songs WHERE id IN (${placeholders})`).bind(...chunk).all();
    for (const row of result?.results || []) found.add(row.id);
  }
  const missingSongIds = songIds.filter((id) => !found.has(id));
  if (missingSongIds.length) fail('SONG_NOT_FOUND', '部分歌曲不存在。', { missingSongIds });
};
