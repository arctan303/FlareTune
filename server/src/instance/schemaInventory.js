// Metadata only: sessions, accounts, maintenance locks and migration state must
// still be read on every request. Entries are isolated by the D1 binding object.
import { keepTaskAlive } from '../utils/sharedRequestTask.js';
export const SCHEMA_CHECK_TTL_MS = 60_000;
const inventories = new WeakMap();

export function invalidateSchemaInventory(db) {
  if (db && typeof db === 'object') inventories.delete(db);
}

export async function readSchemaInventory(db, now, reuse = false, executionContext) {
  const cached = reuse && inventories.get(db);
  if (cached && now >= cached.checkedAt && now < cached.expiresAt) return keepTaskAlive(cached.promise, executionContext);
  const entry = { checkedAt: now, expiresAt: now + SCHEMA_CHECK_TTL_MS };
  entry.promise = (async () => {
    const schema = await db.prepare(`SELECT type, name FROM sqlite_master
      WHERE (type = 'table' AND name NOT LIKE 'sqlite_%')
        OR (type = 'trigger' AND (name LIKE 'ft_member_playlist_%' OR name LIKE 'ft_play_receipts_%'))
        OR (type = 'index' AND (name = 'idx_member_playlist_preview' OR name LIKE 'idx_songs_%'))`).all();
    let columns;
    return {
      schema,
      playlistColumns(currentContext) {
        columns ??= db.prepare('PRAGMA table_info(Member_Playlists)').all();
        return keepTaskAlive(columns, currentContext);
      },
    };
  })();
  keepTaskAlive(entry.promise, executionContext);
  // A fresh read never reuses an old entry, but can serve later metadata-only
  // checks in the same request. Instance validation removes non-ready entries.
  inventories.set(db, entry);
  try { return await entry.promise; }
  catch (error) {
    if (inventories.get(db) === entry) inventories.delete(db);
    throw error;
  }
}
