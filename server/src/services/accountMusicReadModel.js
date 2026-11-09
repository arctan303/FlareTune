import { runtimeSongColumns } from '../utils/songProjection.js';
import { externalMusicSchemaReady, externalSongDto } from './externalMusicReferences.js';

const rows = result => result?.results || [];
const localColumns = runtimeSongColumns('s');

function projectedSong(row) {
  if (row.reference_source === 'youtube') {
    return externalSongDto(JSON.parse(row.metadata_json), row.reference_id);
  }
  return Object.fromEntries(['id', 'title', 'artist', 'album', 'duration', 'audio_url', 'cover_url', 'language']
    .map(key => [key, row[key]]));
}

// These account-scoped views are deliberately separate from Songs: catalog
// discovery and protocol media never gain an external track through a JOIN.
export async function accountMembershipTable(db) {
  return await externalMusicSchemaReady(db) ? 'Member_All_Playlist_Songs' : 'Member_Playlist_Songs';
}

export async function accountPlaysTable(db) {
  return await externalMusicSchemaReady(db) ? 'Member_All_Song_Plays' : 'Member_Song_Plays';
}

export async function readAccountPlaylistSongs(db, accountId, playlistId, { limit, offset = 0 } = {}) {
  const external = await externalMusicSchemaReady(db);
  const membership = external ? 'Member_All_Playlist_Songs' : 'Member_Playlist_Songs';
  const result = await db.prepare(`SELECT ${localColumns}, ps.sort_order, ps.added_at
    ${external ? ', ps.song_id AS reference_id, ps.source AS reference_source, e.metadata_json' : ''}
    FROM ${membership} ps JOIN Member_Playlists p ON p.id = ps.playlist_id
    ${external ? "LEFT JOIN Songs s ON ps.source = 'local' AND s.id = ps.song_id" : 'JOIN Songs s ON s.id = ps.song_id'}
    ${external ? 'LEFT JOIN Member_External_Songs e ON e.account_id = ps.account_id AND e.song_id = ps.song_id' : ''}
    WHERE p.id = ? AND p.account_id = ? ${external ? 'AND ps.account_id = p.account_id' : ''}
    ORDER BY ps.sort_order, ps.song_id ${limit === undefined ? '' : 'LIMIT ? OFFSET ?'}`)
    .bind(playlistId, accountId, ...(limit === undefined ? [] : [limit, offset])).all();
  return rows(result).map(projectedSong);
}

export async function readAccountTopSongs(db, accountId, limit) {
  const external = await externalMusicSchemaReady(db);
  const plays = external ? 'Member_All_Song_Plays' : 'Member_Song_Plays';
  const result = await db.prepare(`SELECT ${localColumns}, p.play_count, p.last_played_at
    ${external ? ', p.song_id AS reference_id, p.source AS reference_source, e.metadata_json' : ''}
    FROM ${plays} p
    ${external ? "LEFT JOIN Songs s ON p.source = 'local' AND s.id = p.song_id" : 'JOIN Songs s ON s.id = p.song_id'}
    ${external ? 'LEFT JOIN Member_External_Songs e ON e.account_id = p.account_id AND e.song_id = p.song_id' : ''}
    WHERE p.account_id = ? ORDER BY p.play_count DESC, p.last_played_at DESC, p.song_id ASC LIMIT ?`)
    .bind(accountId, limit).all();
  return rows(result).map(row => ({ ...projectedSong(row), play_count: Number(row.play_count), last_played_at: Number(row.last_played_at) }));
}
