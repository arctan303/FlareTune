import { readSchemaInventory } from './schemaInventory.js';

export const HOTPATH_OBJECTS = Object.freeze([
  'Member_Play_Receipt_Counts', 'idx_member_playlist_preview',
  'idx_songs_title_artist_id', 'idx_songs_title_id', 'idx_songs_artist_id',
  'idx_songs_search_order', 'idx_songs_romanized_order',
  'ft_play_receipts_insert_count', 'ft_play_receipts_delete_count', 'ft_play_receipts_move_count',
]);

export const hasHotpathObjects = (objects) => {
  const names = new Set((objects || []).map(row => row.name));
  return HOTPATH_OBJECTS.every(name => names.has(name));
};

export async function hotpathSchemaReady(db) {
  // A business write's outer gate has already refreshed this metadata.
  const inventory = await readSchemaInventory(db, Date.now(), true);
  return hasHotpathObjects(inventory.schema.results);
}
