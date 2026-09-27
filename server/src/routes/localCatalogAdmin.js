import { readBoundedJson, RequestBodyError } from '../instance/httpSecurity.js';

// The caller performs instance-state, session and mutation-origin/CSRF checks.
// This route still enforces the role itself so it is not accidentally exposed
// when mounted from another Worker entrypoint.
const PREFIX = '/api/admin/catalog/';
const SONG_COLUMNS = 'id, title, artist, album, duration, audio_url, cover_url, language, created_at';
const SONG_FIELDS = new Set(['id', 'title', 'artist', 'album', 'duration', 'audio_url', 'cover_url', 'language']);
const LANGUAGES = new Set(['zh', 'ja', 'en', 'ko', 'instrumental', 'ru', 'es', 'fr', 'de', 'sv', 'vi', 'yue', 'it', 'th', 'pt', 'other']);

class CatalogError extends Error {
  constructor(code, message, status = 400, data) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}
const fail = (code, message, status = 400, data) => { throw new CatalogError(code, message, status, data); };
const rows = (result) => result?.results || [];
const changed = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const has = (object, key) => Object.hasOwn(object, key);
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
});
const ok = (data, status = 200, headers) => reply({ ok: true, data }, status, headers);
const error = (code, message, status, headers, data) => reply({
  ok: false, error: code, message, ...(data === undefined ? {} : { data }),
}, status, headers);

async function bodyOf(request) {
  try { return await readBoundedJson(request, 64 * 1024); }
  catch (cause) {
    if (cause instanceof RequestBodyError) fail('INVALID_BODY', '请求体必须是有效且不超过 64 KiB 的 JSON 对象。');
    throw cause;
  }
}
function onlyFields(body, fields, required = []) {
  const unexpected = Object.keys(body).filter((key) => !fields.has(key) && key !== 'expectedVersion' && key !== 'confirmDelete');
  if (unexpected.length || required.some((key) => !has(body, key))) fail('INVALID_BODY', '请求字段不符合曲库管理契约。');
}
function idOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    fail('INVALID_ID', 'ID 必须是 1 到 128 位字母、数字、下划线或连字符。');
  }
  return value;
}
function pathId(value) {
  try { return idOf(decodeURIComponent(value)); }
  catch (cause) {
    if (cause instanceof CatalogError) throw cause;
    fail('INVALID_ID', '路径 ID 格式无效。');
  }
}
function text(value, name, max, required = false) {
  if (value === null && !required) return null;
  if (typeof value !== 'string') fail('INVALID_BODY', `${name} 必须是文本。`);
  const result = value.trim();
  if ((required && !result) || Array.from(result).length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    fail('INVALID_BODY', `${name} 的长度或内容无效。`);
  }
  return result || (required ? fail('INVALID_BODY', `${name} 不能为空。`) : null);
}
function assetUrl(value, name) {
  const result = text(value, name, 2048);
  if (result === null) return null;
  try {
    const parsed = new URL(result);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash) return result;
  } catch { /* reject below */ }
  const path = result.startsWith('/media/') ? result.slice('/media/'.length) : result;
  if (result.startsWith('/') && !result.startsWith('/media/')) {
    fail('INVALID_BODY', `${name} 必须是受支持的媒体地址。`);
  }
  if (/[?#]/.test(path) || path.split('/').some((raw, index) => {
    let segment;
    try { segment = decodeURIComponent(raw); } catch { return true; }
    return !segment || segment === '.' || segment === '..' || segment.includes('/')
      || segment.includes('\\') || /[\u0000-\u001f\u007f]/.test(segment)
      || (index === 0 && segment.includes(':'));
  })) fail('INVALID_BODY', `${name} 必须是 HTTPS 地址或有效的媒体对象路径。`);
  return result;
}
function finiteNumber(value, name, max, integer = false) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) {
    fail('INVALID_BODY', `${name} 超出允许范围。`);
  }
  return value;
}
function songInput(body, previous = null) {
  onlyFields(body, SONG_FIELDS, previous ? [] : ['id', 'title', 'audio_url']);
  const get = (field, fallback) => has(body, field) ? body[field] : fallback;
  const language = get('language', previous?.language ?? null);
  if (language !== null && !LANGUAGES.has(language)) fail('INVALID_LANGUAGE', '歌曲语言不在允许范围内。');
  return {
    id: previous?.id ?? idOf(body.id),
    title: text(get('title', previous?.title), 'title', 300, true),
    artist: has(body, 'artist') ? text(body.artist, 'artist', 300) : previous?.artist ?? null,
    album: has(body, 'album') ? text(body.album, 'album', 300) : previous?.album ?? null,
    duration: finiteNumber(get('duration', previous?.duration ?? null), 'duration', 24 * 60 * 60),
    audio_url: has(body, 'audio_url') ? assetUrl(body.audio_url, 'audio_url') : previous?.audio_url ?? null,
    cover_url: has(body, 'cover_url') ? assetUrl(body.cover_url, 'cover_url') : previous?.cover_url ?? null,
    language,
    created_at: previous?.created_at ?? Date.now(),
  };
}
function expectedVersion(body) {
  if (typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) {
    fail('VERSION_REQUIRED', '修改需要当前版本号。');
  }
  return body.expectedVersion;
}
async function digest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const songVersion = (row) => digest(SONG_COLUMNS.split(', ').map((name) => row[name]));
const song = (db, id) => db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs WHERE id = ?`).bind(id).first();
const songOutput = async (row) => ({ ...row, version: await songVersion(row) });
const songSame = SONG_COLUMNS.split(', ').map((field) => `${field} IS ?`).join(' AND ');
const songValues = (row) => SONG_COLUMNS.split(', ').map((field) => row[field]);
function songGuard(db, row) {
  return db.prepare(`INSERT INTO Songs (id, title) SELECT id, title FROM Songs
    WHERE id = ? AND NOT (${songSame})`).bind(row.id, ...songValues(row));
}
async function checkSongVersion(row, candidate) {
  if (!row) fail('SONG_NOT_FOUND', '歌曲不存在。', 404);
  if (await songVersion(row) !== expectedVersion(candidate)) fail('VERSION_CONFLICT', '歌曲已被其他操作修改。', 409);
}
async function guarded(db, guard, statements, lookup, expected) {
  try { return (await db.batch([guard, ...statements])).slice(1); }
  catch (cause) {
    const latest = await lookup();
    if (!latest || await latest.version !== expected) fail('VERSION_CONFLICT', '曲库数据已被其他操作修改。', 409);
    throw cause;
  }
}
function queryNumber(raw, name, defaultValue, max) {
  if (raw === null) return defaultValue;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) fail('INVALID_QUERY', `${name} 超出允许范围。`);
  return Number(raw);
}
async function listSongs(db, url) {
  const page = queryNumber(url.searchParams.get('page'), 'page', 1, 100000);
  const limit = queryNumber(url.searchParams.get('limit'), 'limit', 50, 100);
  const q = url.searchParams.get('q')?.trim() || '';
  if (Array.from(q).length > 120) fail('INVALID_QUERY', '搜索词过长。');
  const where = q ? "WHERE title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\'" : '';
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const bindings = q ? [pattern, pattern, pattern] : [];
  const total = await db.prepare(`SELECT COUNT(*) AS total FROM Songs ${where}`).bind(...bindings).first();
  const list = rows(await db.prepare(`SELECT ${SONG_COLUMNS} FROM Songs ${where}
    ORDER BY COALESCE(created_at, 0) DESC, id LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, (page - 1) * limit).all());
  return { total: Number(total?.total || 0), page, limit, songs: await Promise.all(list.map(songOutput)) };
}
async function createSong(db, body) {
  const value = songInput(body);
  try {
    await db.prepare(`INSERT INTO Songs (${SONG_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(...songValues(value)).run();
  } catch (cause) {
    if (await song(db, value.id)) fail('SONG_EXISTS', '歌曲 ID 已存在。', 409);
    throw cause;
  }
  return songOutput(await song(db, value.id));
}
async function updateSong(db, id, body) {
  const before = await song(db, id);
  await checkSongVersion(before, body);
  if (has(body, 'id')) fail('INVALID_BODY', '歌曲 ID 不可修改。');
  const value = songInput(body, before);
  const update = db.prepare(`UPDATE Songs SET title = ?, artist = ?, album = ?, duration = ?, audio_url = ?,
    cover_url = ?, language = ? WHERE id = ?`).bind(value.title, value.artist, value.album,
    value.duration, value.audio_url, value.cover_url, value.language, id);
  const results = await guarded(db, songGuard(db, before), [update],
    async () => { const latest = await song(db, id); return latest && songOutput(latest); }, body.expectedVersion);
  if (changed(results[0]) !== 1) fail('VERSION_CONFLICT', '歌曲已被其他操作修改。', 409);
  return songOutput(await song(db, id));
}
async function deleteSong(db, id, body) {
  if (body.confirmDelete !== true) fail('DELETE_CONFIRMATION_REQUIRED', '必须明确确认删除。');
  onlyFields(body, SONG_FIELDS);
  const before = await song(db, id);
  await checkSongVersion(before, body);
  const counts = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM Member_Playlist_Songs WHERE song_id = ?) AS member_playlists,
    (SELECT COUNT(*) FROM Member_Song_Plays WHERE song_id = ?) AS play_stats,
    (SELECT COUNT(*) FROM Member_Play_Events WHERE song_id = ?) AS play_events,
    (SELECT COUNT(*) FROM Lyric_Translations WHERE song_id = ?) AS lyric_translations`)
    .bind(id, id, id, id).first();
  if (Object.values(counts).some(Number)) fail('SONG_IN_USE', '歌曲仍被歌单、播放记录或歌词数据引用。', 409, counts);
  const result = await db.prepare(`DELETE FROM Songs WHERE id = ? AND ${songSame}
    AND NOT EXISTS (SELECT 1 FROM Member_Playlist_Songs WHERE song_id = ?)
    AND NOT EXISTS (SELECT 1 FROM Member_Song_Plays WHERE song_id = ?)
    AND NOT EXISTS (SELECT 1 FROM Member_Play_Events WHERE song_id = ?)
    AND NOT EXISTS (SELECT 1 FROM Lyric_Translations WHERE song_id = ?)`)
    .bind(id, ...songValues(before), id, id, id, id).run();
  if (changed(result) !== 1) fail('VERSION_CONFLICT', '歌曲或其引用已被其他操作修改。', 409);
  return { deletedSongId: id, mediaRetained: true };
}
export async function handleLocalCatalogAdminRoute(request, url, db, headers = {}, session) {
  const path = url.pathname;
  if (!path.startsWith(PREFIX)) return null;
  if (session?.mode !== 'normal' || session?.account?.role !== 'admin') {
    return error('FORBIDDEN', '需要管理员权限。', 403, headers);
  }
  if (path === `${PREFIX}playlists` || path.startsWith(`${PREFIX}playlists/`)) {
    return error('NOT_FOUND', '曲库管理接口不存在。', 404, headers);
  }
  if (!db?.prepare || !db?.batch) return error('CATALOG_STORAGE_UNAVAILABLE', '曲库暂时不可用。', 503, headers);
  try {
    if (path === `${PREFIX}songs`) {
      if (request.method === 'GET') return ok(await listSongs(db, url), 200, headers);
      if (request.method === 'POST') return ok({ song: await createSong(db, await bodyOf(request)) }, 201, headers);
    }
    const songMatch = /^\/api\/admin\/catalog\/songs\/([^/]+)$/.exec(path);
    if (songMatch) {
      const id = pathId(songMatch[1]);
      if (request.method === 'GET') {
        const row = await song(db, id);
        if (!row) fail('SONG_NOT_FOUND', '歌曲不存在。', 404);
        return ok({ song: await songOutput(row) }, 200, headers);
      }
      if (request.method === 'PUT') return ok({ song: await updateSong(db, id, await bodyOf(request)) }, 200, headers);
      if (request.method === 'DELETE') return ok(await deleteSong(db, id, await bodyOf(request)), 200, headers);
    }
    return error('NOT_FOUND', '曲库管理接口不存在。', 404, headers);
  } catch (cause) {
    if (cause instanceof CatalogError) return error(cause.code, cause.message, cause.status, headers, cause.data);
    return error('CATALOG_STORAGE_UNAVAILABLE', '曲库暂时不可用。', 503, headers);
  }
}
