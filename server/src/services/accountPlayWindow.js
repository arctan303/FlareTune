import { externalSongDto } from './externalMusicReferences.js';

const rows = result => result?.results || [];

// Receipt retention is bounded to 30 days. This reads saved events only; it
// neither changes lifetime totals nor resolves an external source on a read.
export async function readAccountPlayWindow(db, accountId, limit, summaryOnly, window, external) {
  const local = `SELECT song_id,'local' AS source,COUNT(*) AS play_count,MAX(played_at) AS last_played_at
    FROM Member_Play_Events WHERE account_id=? AND played_at>=? AND played_at<=? GROUP BY song_id`;
  const remote = `SELECT song_id,'youtube' AS source,COUNT(*) AS play_count,MAX(played_at) AS last_played_at
    FROM Member_External_Play_Events WHERE account_id=? AND played_at>=? AND played_at<=? GROUP BY song_id`;
  const aggregation = external ? `${local} UNION ALL ${remote}` : local;
  const bindings = [accountId, window.from, window.to];
  if (external) bindings.push(accountId, window.from, window.to);
  const ranked = await db.prepare(`WITH window_plays AS (${aggregation})
    SELECT p.song_id AS id,s.title,s.artist,s.album,s.duration,s.audio_url,s.cover_url,s.language,
      ${external ? 'e.metadata_json' : 'NULL AS metadata_json'},p.play_count,p.last_played_at
    FROM window_plays p ${external ? 'LEFT JOIN' : 'JOIN'} Songs s ON ${external ? "p.source='local' AND " : ''}s.id=p.song_id
    ${external ? "LEFT JOIN Member_External_Songs e ON p.source='youtube' AND e.account_id=? AND e.song_id=p.song_id" : ''}
    ORDER BY p.play_count DESC,p.last_played_at DESC,p.song_id ASC,p.source ASC LIMIT ?`)
    .bind(...bindings, ...(external ? [accountId] : []), limit).all();
  const songs = rows(ranked).map(({ metadata_json, ...row }) => metadata_json
    ? { ...externalSongDto(JSON.parse(metadata_json), row.id), play_count: row.play_count, last_played_at: row.last_played_at }
    : row);
  if (summaryOnly) return { songs, topAlbums: [], view: 'summary', window };
  const counts = rows(await db.prepare(`WITH window_plays AS (${aggregation})
    SELECT song_id,play_count FROM window_plays`).bind(...bindings).all());
  return {
    songs,
    playCounts: Object.fromEntries(counts.map(row => [row.song_id, Number(row.play_count)])),
    totalPlays: counts.reduce((sum, row) => sum + Number(row.play_count), 0),
    totalUniqueSongs: counts.length,
    topAlbums: [],
    window,
  };
}
