import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const input = process.argv[2];
if (!input) throw new Error('Provide an explicit local D1 SQL export path.');
const database = new DatabaseSync(':memory:');
try {
  database.exec(readFileSync(resolve(input), 'utf8'));
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const summary = tables.map(({ name }) => ({
    table: name,
    rows: database.prepare(`SELECT COUNT(*) AS total FROM ${JSON.stringify(name)}`).get().total,
    columns: database.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all().map((column) => column.name),
  }));
  const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check;
  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
  const ownerTables = ['Member_Playlists', 'Member_Playlist_Shelf', 'Member_Song_Plays', 'Member_Play_Events', 'music_chat_threads'];
  const presentOwnerTables = ownerTables.filter((name) => tables.some((table) => table.name === name));
  const owners = presentOwnerTables.length
    ? database.prepare(presentOwnerTables.map((name) => `SELECT user_sub FROM ${name}`).join(' UNION ')).all()
      .map(({ user_sub }) => ({
        label: createHash('sha256').update(user_sub).digest('hex').slice(0, 12),
        counts: Object.fromEntries(presentOwnerTables.map((name) => [name,
          database.prepare(`SELECT COUNT(*) AS total FROM ${name} WHERE user_sub = ?`).get(user_sub).total])),
      }))
    : [];
  const risks = Object.fromEntries([
    ['playlistSortNull', 'SELECT COUNT(*) AS total FROM Playlist_Songs WHERE sort_order IS NULL'],
    ['playlistCoverInvalid', 'SELECT COUNT(*) AS total FROM Playlists WHERE has_cover IS NULL OR has_cover NOT IN (0, 1)'],
    ['playlistSongOrphans', 'SELECT COUNT(*) AS total FROM Playlist_Songs ps LEFT JOIN Songs s ON s.id = ps.song_id LEFT JOIN Playlists p ON p.id = ps.playlist_id WHERE s.id IS NULL OR p.id IS NULL'],
    ['playEventSongOrphans', 'SELECT COUNT(*) AS total FROM Member_Play_Events e LEFT JOIN Songs s ON s.id = e.song_id WHERE s.id IS NULL'],
    ['playSummarySongOrphans', 'SELECT COUNT(*) AS total FROM Member_Song_Plays p LEFT JOIN Songs s ON s.id = p.song_id WHERE s.id IS NULL'],
    ['lyricSongOrphans', 'SELECT COUNT(*) AS total FROM Lyric_Translations l LEFT JOIN Songs s ON s.id = l.song_id WHERE s.id IS NULL'],
    ['shelfInvalidJson', 'SELECT COUNT(*) AS total FROM Member_Playlist_Shelf WHERE NOT json_valid(items_json)'],
    ['artistInvalidJson', 'SELECT COUNT(*) AS total FROM Artist_Photos WHERE NOT json_valid(photos)'],
    ['runningChatTurns', "SELECT COUNT(*) AS total FROM music_chat_turns WHERE status = 'running'"],
  ].map(([name, sql]) => [name, database.prepare(sql).get().total]));
  process.stdout.write(`${JSON.stringify({ integrity, foreignKeyViolations, tables: summary, owners, risks }, null, 2)}\n`);
} finally {
  database.close();
}
