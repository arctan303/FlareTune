import {
  changes,
  cleanId,
  fail,
  parseJsonArray,
  requireDb,
  revisionOf,
  subjectOf,
} from './accountPlaylistCore.js';
import { ensureFavoriteInternal } from './accountPlaylistRead.js';

const shelfSources = async (db, subject) => {
  const members = await db.prepare("SELECT id, kind FROM Member_Playlists WHERE user_sub = ? AND kind IN ('favorite', 'regular') ORDER BY CASE kind WHEN 'favorite' THEN 0 ELSE 1 END, created_at, id").bind(subject).all();
  return {
    memberIds: (members?.results || []).map((row) => row.id),
    favoriteId: (members?.results || []).find((row) => row.kind === 'favorite')?.id || null,
  };
};

const canonicalShelfItems = (items, memberIds, favoriteId) => {
  const validMembers = new Set(memberIds);
  const seen = new Set();
  const canonical = [];
  for (const item of Array.isArray(items) ? items : []) {
    const kind = item?.kind;
    const id = typeof item?.id === 'string' ? item.id : '';
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    if (kind === 'member' && validMembers.has(id)) canonical.push({ kind, id });
    else continue;
    seen.add(key);
  }
  if (favoriteId && !seen.has(`member:${favoriteId}`)) {
    canonical.unshift({ kind: 'member', id: favoriteId });
    seen.add(`member:${favoriteId}`);
  }
  for (const id of memberIds) {
    const key = `member:${id}`;
    if (!seen.has(key)) canonical.push({ kind: 'member', id });
  }
  return canonical;
};

const mapShelf = (row, items) => ({
  revision: Number(row?.revision || 0),
  updatedAt: Number(row?.updated_at || 0),
  items,
});

export async function getPlaylistShelf(db, userSub, now = Date.now()) {
  requireDb(db);
  const subject = subjectOf(userSub);
  await ensureFavoriteInternal(db, subject, now);
  const { memberIds, favoriteId } = await shelfSources(db, subject);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let row = await db.prepare('SELECT * FROM Member_Playlist_Shelf WHERE user_sub = ?').bind(subject).first();
    if (!row) {
      const initialItems = canonicalShelfItems([], memberIds, favoriteId);
      await db.prepare(`INSERT OR IGNORE INTO Member_Playlist_Shelf
        (user_sub, items_json, revision, updated_at) VALUES (?, ?, 0, ?)`)
        .bind(subject, JSON.stringify(initialItems), now).run();
      row = await db.prepare('SELECT * FROM Member_Playlist_Shelf WHERE user_sub = ?').bind(subject).first();
    }
    const parsed = parseJsonArray(row?.items_json);
    const items = canonicalShelfItems(parsed, memberIds, favoriteId);
    if (JSON.stringify(parsed) === JSON.stringify(items)) return mapShelf(row, items);
    const result = await db.prepare(`UPDATE Member_Playlist_Shelf
      SET items_json = ?, revision = revision + 1, updated_at = ?
      WHERE user_sub = ? AND revision = ?`)
      .bind(JSON.stringify(items), now, subject, Number(row.revision)).run();
    if (changes(result) === 1) return mapShelf({ revision: Number(row.revision) + 1, updated_at: now }, items);
  }
  const latest = await db.prepare('SELECT * FROM Member_Playlist_Shelf WHERE user_sub = ?').bind(subject).first();
  return mapShelf(latest, canonicalShelfItems(parseJsonArray(latest?.items_json), memberIds, favoriteId));
}

const validateShelfItems = (input, current) => {
  if (!Array.isArray(input) || input.length !== current.items.length) fail('INVALID_BODY', 'items 必须包含完整唱片架。');
  const items = input.map((item) => {
    if (!item || item.kind !== 'member' || item.hidden !== undefined) {
      fail('INVALID_BODY', '唱片架项目格式无效。');
    }
    return { kind: item.kind, id: cleanId(item.id) };
  });
  const expectedKeys = new Set(current.items.map((item) => `${item.kind}:${item.id}`));
  const keys = items.map((item) => `${item.kind}:${item.id}`);
  if (new Set(keys).size !== keys.length || keys.some((key) => !expectedKeys.has(key))) {
    fail('INVALID_BODY', 'items 必须与当前唱片架项目一致。');
  }
  return items;
};

export async function updatePlaylistShelf(db, userSub, input = {}, now = Date.now()) {
  requireDb(db);
  const subject = subjectOf(userSub);
  const current = await getPlaylistShelf(db, subject, now);
  const expectedRevision = revisionOf(input.expectedRevision);
  if (current.revision !== expectedRevision) fail('REVISION_CONFLICT', '唱片架已在其他页面更新。', { shelf: current });
  const items = validateShelfItems(input.items, current);
  if (JSON.stringify(items) === JSON.stringify(current.items)) return { outcome: 'noop', shelf: current };
  const result = await db.prepare(`UPDATE Member_Playlist_Shelf
    SET items_json = ?, revision = revision + 1, updated_at = ?
    WHERE user_sub = ? AND revision = ?`).bind(JSON.stringify(items), now, subject, expectedRevision).run();
  if (changes(result) !== 1) {
    fail('REVISION_CONFLICT', '唱片架已在其他页面更新。', { shelf: await getPlaylistShelf(db, subject, now) });
  }
  return { outcome: 'applied', shelf: mapShelf({ revision: expectedRevision + 1, updated_at: now }, items) };
}
