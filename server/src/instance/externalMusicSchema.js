import { readSchemaInventory } from './schemaInventory.js';
export class ExternalMusicError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
export const EXTERNAL_MUSIC_OBJECTS = Object.freeze(['Member_Play_Receipt_Counts', 'Member_External_Songs', 'Member_External_Playlist_Songs',
  'Member_External_Song_Plays', 'Member_External_Play_Events', 'Member_All_Playlist_Songs', 'Member_All_Song_Plays', 'Member_All_Play_Events',
  'ft_external_playlist_insert_count', 'ft_external_playlist_delete_count', 'ft_external_playlist_move_count',
  'ft_music_local_event_unique', 'ft_music_external_event_unique', 'ft_external_play_apply',
  'ft_external_receipts_insert_count', 'ft_external_receipts_delete_count', 'ft_external_receipts_move_count']);
export const hasExternalMusicObjects = objects => {
  const names = new Set((objects || []).map(row => row.name));
  return EXTERNAL_MUSIC_OBJECTS.every(name => names.has(name));
};
export async function externalMusicSchemaReady(db) {
  const inventory = await readSchemaInventory(db, Date.now(), true);
  const objects = inventory.schema.results;
  if (hasExternalMusicObjects(objects)) return true;
  const names = new Set((objects || []).map(row => row.name));
  // An old database with no 0014 objects can keep serving local music. Once any
  // external object exists, an incomplete schema must never hide saved tracks
  // by silently falling back to local tables. The controlled admin repair path
  // uses hasExternalMusicObjects instead of this serving gate.
  if (EXTERNAL_MUSIC_OBJECTS.some(name => name !== 'Member_Play_Receipt_Counts' && names.has(name))) {
    throw new ExternalMusicError('EXTERNAL_MUSIC_SCHEMA_INCOMPLETE');
  }
  return false;
}
