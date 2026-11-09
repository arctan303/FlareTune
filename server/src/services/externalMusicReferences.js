import { externalMusicSchemaReady, ExternalMusicError } from '../instance/externalMusicSchema.js';
export { externalMusicSchemaReady, ExternalMusicError };
export const isExternalSongId = id => typeof id === 'string' && /^yt:[A-Za-z0-9_-]{11}$/.test(id);
const cleanText = (value, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';
// This validates a previously saved reference only. Fetching images remains the
// selected source's responsibility; stored playlists do not import that source.
function storedCoverTarget(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
    !['lh3.googleusercontent.com', 'i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname)) throw new TypeError('INVALID_STORED_COVER');
  return url.href;
}
export function externalSongDto(value, expectedId) {
  if (!isExternalSongId(expectedId) || value?.id !== expectedId || value?.source !== 'youtube' || value.sourceId !== expectedId.slice(3)
    || typeof value.title !== 'string' || !value.title.trim()) throw new ExternalMusicError('EXTERNAL_SONG_INVALID', 502);
  let cover = null;
  try {
    const raw = new URL(value.cover_url || value.coverUrl, 'https://external-reference.internal');
    if (raw.origin === 'https://external-reference.internal' && raw.pathname === '/media/youtube/image') {
      const target = storedCoverTarget(raw.searchParams.get('url'));
      const params = new URLSearchParams({ url: target });
      if (raw.searchParams.get('size') === '1200') params.set('size', '1200');
      cover = '/media/youtube/image?' + params;
    }
  } catch { /* Missing/unsupported art is not a signed media reference. */ }
  const artists = (Array.isArray(value.artists) ? value.artists : []).slice(0, 30).map(artist => ({
    name: cleanText(artist?.name, 500),
    id: /^yt:artist:UC[A-Za-z0-9_-]{1,126}$/.test(artist?.id || '') ? artist.id : null,
    sourceId: /^UC[A-Za-z0-9_-]{1,126}$/.test(artist?.sourceId || '') ? artist.sourceId : null,
  }));
  return { id: expectedId, source: 'youtube', sourceId: expectedId.slice(3), kind: 'song', title: cleanText(value.title, 1000),
    artist: cleanText(value.artist), album: cleanText(value.album), artists,
    albumId: /^yt:album:MPREb_[A-Za-z0-9_-]{1,122}$/.test(value.albumId || '') ? value.albumId : null,
    duration: Number.isFinite(value.duration) && value.duration >= 0 && value.duration <= 604800 ? value.duration : null,
    language: typeof value.language === 'string' && value.language.length < 40 ? value.language : null,
    audio_url: '/media/youtube/audio/' + expectedId.slice(3), cover_url: cover, coverUrl: cover };
}
export async function loadExternalSongs(db, accountId, ids) {
  if (!ids.length || !await externalMusicSchemaReady(db)) return [];
  const byId = new Map();
  for (let start = 0; start < ids.length; start += 90) {
    const part = ids.slice(start, start + 90);
    const result = await db.prepare(`SELECT song_id,metadata_json FROM Member_External_Songs WHERE account_id=? AND song_id IN (${part.map(() => '?').join(',')})`)
      .bind(accountId, ...part).all();
    for (const row of result.results || []) {
      try { byId.set(row.song_id, externalSongDto(JSON.parse(row.metadata_json), row.song_id)); }
      catch { throw new ExternalMusicError('EXTERNAL_SONG_STORAGE_INVALID'); }
    }
  }
  return ids.map(id => byId.get(id)).filter(Boolean);
}
export async function prepareExternalSongs(db, accountId, ids, now, deps = {}, { partial = false } = {}) {
  const externalIds = [...new Set(ids.filter(isExternalSongId))];
  if (!externalIds.length) return { statements: [], resolvedIds: [], assertCurrent: async () => {} };
  if (!await externalMusicSchemaReady(db)) throw new ExternalMusicError('EXTERNAL_MUSIC_MIGRATION_REQUIRED');
  const existing = new Set((await loadExternalSongs(db, accountId, externalIds)).map(song => song.id));
  const missing = externalIds.filter(id => !existing.has(id));
  if (!missing.length) return { statements: [], resolvedIds: [], assertCurrent: async () => {} };
  if (typeof deps.resolveExternalSongs !== 'function' || typeof deps.assertExternalCurrent !== 'function') throw new ExternalMusicError('EXTERNAL_SOURCE_UNAVAILABLE', 409);
  let resolved;
  try { resolved = await deps.resolveExternalSongs(missing, { partial }); await deps.assertExternalCurrent(); }
  catch { throw new ExternalMusicError('EXTERNAL_SOURCE_UNAVAILABLE', 409); }
  if (!Array.isArray(resolved)) throw new ExternalMusicError('EXTERNAL_SONG_INVALID', 502);
  const byId = new Map(resolved.map(song => [song?.id, song]));
  const references = [];
  for (const id of missing) {
    try {
      const value = externalSongDto(byId.get(id), id);
      const serialized = JSON.stringify(value);
      if (new TextEncoder().encode(serialized).byteLength > 16384) throw new ExternalMusicError('EXTERNAL_SONG_INVALID', 502);
      references.push({ id, sourceId: value.sourceId, metadata: value });
    } catch (error) { if (!partial) throw error; }
  }
  const statements = [];
  // A full 500-track playlist stays within D1's per-request query budget.
  // Each validated snapshot is <=16KiB and each statement has only three binds.
  for (let start = 0; start < references.length; start += 40) {
    statements.push(db.prepare(`INSERT INTO Member_External_Songs(account_id,song_id,source,source_id,metadata_json,updated_at)
      SELECT ?,json_extract(value,'$.id'),'youtube',json_extract(value,'$.sourceId'),json_extract(value,'$.metadata'),?
      FROM json_each(?) WHERE 1 ON CONFLICT(account_id,song_id) DO UPDATE
      SET metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
      .bind(accountId, now, JSON.stringify(references.slice(start, start + 40))));
  }
  return { statements, resolvedIds: references.map(row => row.id), async assertCurrent() {
    try { await deps.assertExternalCurrent(); } catch { throw new ExternalMusicError('EXTERNAL_SOURCE_UNAVAILABLE', 409); }
  } };
}
