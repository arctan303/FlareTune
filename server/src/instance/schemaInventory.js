// Metadata only: sessions, accounts, maintenance locks and migration state must
// still be read on every request. Entries are isolated by the D1 binding object.
import { keepTaskAlive } from '../utils/sharedRequestTask.js';
import { databaseIdentity } from '../services/databaseIdentity.js';
export const SCHEMA_CHECK_TTL_MS = 60_000;
const inventories = new WeakMap();
function inventoryForRequest(entry, db, executionContext) {
  return keepTaskAlive(entry.promise, executionContext).then(({ schema }) => ({
    schema,
    playlistColumns(currentContext) {
      entry.columns ??= db.prepare('PRAGMA table_info(Member_Playlists)').all();
      return keepTaskAlive(entry.columns, currentContext);
    },
  }));
}

export function invalidateSchemaInventory(db) {
  if (db && typeof db === 'object') inventories.delete(databaseIdentity(db));
}

export async function readSchemaInventory(db, now, reuse = false, executionContext) {
  const identity = databaseIdentity(db);
  const cached = reuse && inventories.get(identity);
  if (cached && now >= cached.checkedAt && now < cached.expiresAt) return inventoryForRequest(cached, db, executionContext);
  const entry = { checkedAt: now, expiresAt: now + SCHEMA_CHECK_TTL_MS };
  entry.promise = (async () => {
    const schema = await db.prepare(`SELECT type, name FROM sqlite_master
      WHERE (type = 'table' AND name NOT LIKE 'sqlite_%')
        OR (type = 'view' AND name LIKE 'Member_All_%')
        OR (type = 'trigger' AND (name LIKE 'ft_member_playlist_%' OR name LIKE 'ft_play_receipts_%' OR name LIKE 'ft_external_%' OR name LIKE 'ft_music_%'))
        OR (type = 'index' AND (name = 'idx_member_playlist_preview' OR name LIKE 'idx_songs_%'))`).all();
    return { schema };
  })();
  keepTaskAlive(entry.promise, executionContext);
  // A fresh read never reuses an old entry, but can serve later metadata-only
  // checks in the same request. Instance validation removes non-ready entries.
  inventories.set(identity, entry);
  try { return await inventoryForRequest(entry, db, executionContext); }
  catch (error) {
    if (inventories.get(identity) === entry) inventories.delete(identity);
    throw error;
  }
}
