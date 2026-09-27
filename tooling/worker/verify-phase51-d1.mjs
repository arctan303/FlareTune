import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '../..');
const workerRoot = join(repositoryRoot, 'server');
const wranglerBin = join(repositoryRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const runWrangler = (args) => {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: workerRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler verification command failed.\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
};

const findSqliteFiles = (directory, found = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      findSqliteFiles(target, found);
    } else if (entry.name.endsWith('.sqlite')) found.push(target);
  }
  return found;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runConcurrentStatement = (sqlitePath, sql, params) => new Promise((resolvePromise, rejectPromise) => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    (() => {
      const db = new DatabaseSync(workerData.sqlitePath);
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const result = db.prepare(workerData.sql).run(...workerData.params);
          db.close();
          parentPort.postMessage({ changes: Number(result.changes) });
          return;
        } catch (error) {
          if (!String(error?.code || error?.message).includes('BUSY') || attempt === 19) throw error;
          Atomics.wait(sleeper, 0, 0, 25);
        }
      }
    })();
  `, { eval: true, workerData: { sqlitePath, sql, params } });
  worker.once('message', resolvePromise);
  worker.once('error', rejectPromise);
  worker.once('exit', (code) => {
    if (code !== 0) rejectPromise(new Error(`Concurrent SQLite worker exited with ${code}`));
  });
});

const verifyDatabase = async (persistDir) => {
  const baseSchemaPath = join(persistDir, 'base.sql');
  writeFileSync(baseSchemaPath, [
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE Songs (id TEXT PRIMARY KEY);',
    "INSERT INTO Songs(id) VALUES ('s1'), ('s2');",
  ].join('\n'));
  const sharedArgs = ['d1', 'execute', 'DB', '--local', '--config', 'wrangler.local.toml', '--persist-to', persistDir];
  runWrangler([...sharedArgs, '--file', baseSchemaPath]);
  runWrangler([...sharedArgs, '--file', './db/migrations/0016_member_playlists.sql']);
  runWrangler([...sharedArgs, '--file', './db/migrations/0016_member_playlists.sql']);

  const sqlitePaths = findSqliteFiles(persistDir);
  assert(sqlitePaths.length > 0, 'Wrangler did not create a local SQLite database.');
  let db = null;
  let selectedSqlitePath = null;
  for (const sqlitePath of sqlitePaths) {
    const candidate = new DatabaseSync(sqlitePath);
    const hasMemberTables = candidate.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='Member_Playlists'").get().count;
    if (Number(hasMemberTables) === 1) {
      db = candidate;
      selectedSqlitePath = sqlitePath;
      break;
    }
    candidate.close();
  }
  assert(db, 'Wrangler database is missing the Phase 51 tables.');
  db.exec('PRAGMA foreign_keys = ON');

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Member_Playlist%'").all().map((row) => row.name));
  for (const name of ['Member_Playlists', 'Member_Playlist_Songs', 'Member_Playlist_Shelf']) {
    assert(tables.has(name), `Missing ${name}`);
  }
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_member_playlist%'").all().map((row) => row.name));
  for (const name of ['idx_member_playlists_owner_favorite', 'idx_member_playlists_owner_created', 'idx_member_playlist_songs_order', 'idx_member_playlist_songs_song']) {
    assert(indexes.has(name), `Missing ${name}`);
  }

  db.prepare("INSERT INTO Member_Playlists(id,user_sub,kind,name,description,revision,created_at,updated_at) VALUES ('fav','u1','favorite','我喜欢','',0,1,1)").run();
  let duplicateFavoriteRejected = false;
  try {
    db.prepare("INSERT INTO Member_Playlists(id,user_sub,kind,name,description,revision,created_at,updated_at) VALUES ('fav2','u1','favorite','重复','',0,2,2)").run();
  } catch { duplicateFavoriteRejected = true; }
  assert(duplicateFavoriteRejected, 'Favorite uniqueness was not enforced.');

  let missingSongRejected = false;
  try {
    db.prepare("INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at) VALUES ('fav','missing',0,1)").run();
  } catch { missingSongRejected = true; }
  assert(missingSongRejected, 'Song foreign key was not enforced.');

  db.prepare("INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at) VALUES ('fav','s1',0,1),('fav','s2',1,2)").run();
  const orders = db.prepare("SELECT sort_order FROM Member_Playlist_Songs WHERE playlist_id='fav' ORDER BY sort_order").all().map((row) => Number(row.sort_order));
  assert(JSON.stringify(orders) === '[0,1]', 'Song ordering is not contiguous.');

  assert(db.prepare("UPDATE Member_Playlists SET revision=revision+1 WHERE id='fav' AND user_sub='u1' AND revision=0").run().changes === 1, 'Initial CAS update failed.');
  assert(db.prepare("UPDATE Member_Playlists SET revision=revision+1 WHERE id='fav' AND user_sub='u1' AND revision=0").run().changes === 0, 'Stale CAS update was accepted.');

  db.prepare("DELETE FROM Member_Playlists WHERE id='fav'").run();
  assert(Number(db.prepare("SELECT COUNT(*) AS count FROM Member_Playlist_Songs WHERE playlist_id='fav'").get().count) === 0, 'Playlist song cascade failed.');
  db.prepare("INSERT INTO Member_Playlists(id,user_sub,kind,name,description,revision,created_at,updated_at) VALUES ('cas','cas-owner','regular','CAS','',0,10,10)").run();
  const quotaInsert = db.prepare("INSERT INTO Member_Playlists(id,user_sub,kind,name,description,revision,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)");
  for (let index = 0; index < 49; index += 1) {
    quotaInsert.run(`quota-${index}`, 'quota-owner', 'regular', `Q${index}`, '', 100 + index, 100 + index);
  }
  db.close();

  const casSql = "UPDATE Member_Playlists SET revision=revision+1 WHERE id='cas' AND user_sub='cas-owner' AND revision=0";
  const casResults = await Promise.all([
    runConcurrentStatement(selectedSqlitePath, casSql, []),
    runConcurrentStatement(selectedSqlitePath, casSql, []),
  ]);
  assert(casResults.reduce((sum, result) => sum + result.changes, 0) === 1, 'Concurrent CAS accepted more than one writer.');

  const favoriteSql = "INSERT OR IGNORE INTO Member_Playlists(id,user_sub,kind,name,description,revision,created_at,updated_at) VALUES (?, 'favorite-owner', 'favorite', '我喜欢', '', 0, ?, ?)";
  const favoriteResults = await Promise.all([
    runConcurrentStatement(selectedSqlitePath, favoriteSql, ['favorite-a', 200, 200]),
    runConcurrentStatement(selectedSqlitePath, favoriteSql, ['favorite-b', 201, 201]),
  ]);
  assert(favoriteResults.reduce((sum, result) => sum + result.changes, 0) === 1, 'Concurrent favorite initialization created more than one row.');

  const guardedQuotaSql = "INSERT INTO Member_Playlists(id,user_sub,kind,name,description,revision,created_at,updated_at) SELECT ?, 'quota-owner', 'regular', ?, '', 0, ?, ? WHERE (SELECT COUNT(*) FROM Member_Playlists WHERE user_sub='quota-owner' AND kind='regular') < 50";
  const quotaResults = await Promise.all([
    runConcurrentStatement(selectedSqlitePath, guardedQuotaSql, ['quota-a', 'QA', 300, 300]),
    runConcurrentStatement(selectedSqlitePath, guardedQuotaSql, ['quota-b', 'QB', 301, 301]),
  ]);
  assert(quotaResults.reduce((sum, result) => sum + result.changes, 0) === 1, 'Concurrent quota guard accepted more than one 50th playlist.');

  db = new DatabaseSync(selectedSqlitePath);
  db.exec('PRAGMA foreign_keys = ON');
  assert(Number(db.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE user_sub='favorite-owner' AND kind='favorite'").get().count) === 1, 'Favorite race did not converge to one row.');
  assert(Number(db.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE user_sub='quota-owner' AND kind='regular'").get().count) === 50, 'Quota race did not converge at 50 playlists.');
  assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'PRAGMA foreign_key_check found violations.');
  db.close();
};

if (process.argv[2] === '--verify-in') {
  await verifyDatabase(resolve(process.argv[3]));
} else {
  const persistDir = mkdtempSync(join(workerRoot, '.phase51-verify-'));
  try {
    const result = spawnSync(process.execPath, [scriptPath, '--verify-in', persistDir], {
      cwd: workerRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Phase 51 D1 verification failed.\n${result.stdout || ''}\n${result.stderr || ''}`);
    console.log('✓ Phase 51 isolated Wrangler D1 verification passed (idempotency, tables, indexes, favorite/quota races, FK check/cascade, ordering, CAS race).');
  } finally {
    rmSync(persistDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
