import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { resolveInstanceState } from '../../server/src/instance/state.js';

const target = process.argv[2];
if (!target) throw new Error('Provide an explicit local SQLite target path.');
const sqlite = new DatabaseSync(resolve(target), { readOnly: true });
try {
  const adapter = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return {
      async first() { return statement.get() ?? null; },
      async all() { return { results: statement.all() }; },
    };
  } };
  const state = await resolveInstanceState(adapter);
  const integrity = sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check;
  const foreignKeyViolations = sqlite.prepare('PRAGMA foreign_key_check').all().length;
  const instance = sqlite.prepare('SELECT schema_version, revision, initialized_at FROM ft_instance WHERE id = 1').get();
  const counts = Object.fromEntries([
    'accounts', 'account_credentials', 'account_sessions', 'Songs', 'Playlists', 'Playlist_Songs',
    'Member_Playlists', 'Member_Playlist_Songs', 'Member_Play_Events', 'Member_Song_Plays', 'AI_Daily_Usage',
    'music_chat_threads', 'music_chat_thread_messages', 'music_chat_turns', 'audit_events',
  ].map((table) => [table, sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total]));
  const importMarker = Boolean(sqlite.prepare("SELECT 1 FROM audit_events WHERE id = 'legacy-d1-import-v1'").get());
  process.stdout.write(`${JSON.stringify({ state: state.state, integrity, foreignKeyViolations,
    schemaVersion: instance?.schema_version, instanceRevision: instance?.revision,
    initialized: Number.isSafeInteger(instance?.initialized_at) && instance.initialized_at > 0,
    importMarker, counts }, null, 2)}\n`);
} finally {
  sqlite.close();
}
