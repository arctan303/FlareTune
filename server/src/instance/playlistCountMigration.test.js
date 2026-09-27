import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runPlaylistCountMigration } from './playlistCountMigration.js';
import { resolveInstanceState } from './state.js';

const baseline = readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const expand = readFileSync(new URL('../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8');
const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);
const BASE = Date.now();

function fixture({ expanded = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(baseline);
  if (expanded) sqlite.exec(expand);
  let beforeBatch = null;
  let beforeStatement = null;
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        sql,
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) ?? null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { return { meta: { changes: statement.run(...args).changes } }; },
      };
    },
    async batch(statements) {
      if (beforeBatch) { const hook = beforeBatch; beforeBatch = null; hook(); }
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const item of statements) {
          if (beforeStatement) beforeStatement(item.sql);
          results.push(await item.run());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  sqlite.prepare(`INSERT INTO accounts(account_id, username, role, created_at, updated_at)
    VALUES ('a', 'alice', 'admin', 1, 1)`).run();
  sqlite.prepare("INSERT INTO Songs(id, title) VALUES ('song-1', 'One'), ('song-2', 'Two')").run();
  const addPlaylist = (id, songIds = []) => {
    sqlite.prepare(`INSERT INTO Member_Playlists(id, account_id, kind, name, created_at, updated_at)
      VALUES (?, 'a', 'regular', ?, 1, 1)`).run(id, id);
    songIds.forEach((songId, index) => sqlite.prepare(`INSERT INTO Member_Playlist_Songs
      (playlist_id, song_id, sort_order, added_at) VALUES (?, ?, ?, 1)`).run(id, songId, index));
  };
  return {
    sqlite, db, addPlaylist,
    setBeforeBatch(hook) { beforeBatch = hook; },
    setBeforeStatement(hook) { beforeStatement = hook; },
  };
}

const run = (db, overrides = {}) => runPlaylistCountMigration(db, {
  ownerToken: OWNER_A, now: () => BASE, batchSize: 1, ...overrides,
});

test('v2 backfill requires expanded schema and leaves baseline untouched when absent', async () => {
  const { sqlite, db } = fixture({ expanded: false });
  await assert.rejects(run(db), { code: 'migration_expand_missing' });
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ft_migrations WHERE version = 2').get().n, 0);
  assert.equal(sqlite.prepare('SELECT owner_token FROM ft_migration_lock WHERE id = 1').get().owner_token, null);
  sqlite.close();
});

test('bounded calls backfill exact counts, advance cursor atomically and complete v2 only at the end', async () => {
  const { sqlite, db, addPlaylist } = fixture();
  addPlaylist('p1', ['song-1', 'song-2']);
  addPlaylist('p2', ['song-1']);
  sqlite.prepare('UPDATE Member_Playlists SET cached_song_count = 0').run();
  assert.deepEqual(await run(db), { status: 'in_progress', phase: 'backfill', processed: 1, cursor: 'p1' });
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 2);
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p2'").get().cached_song_count, 0);
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  assert.equal(sqlite.prepare('SELECT state FROM ft_migrations WHERE version = 2').get().state, 'running');
  assert.deepEqual(await run(db, { now: () => BASE + 1 }), { status: 'in_progress', phase: 'backfill', processed: 1, cursor: 'p2' });
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p2'").get().cached_song_count, 1);
  assert.deepEqual(await run(db, { now: () => BASE + 2 }), { status: 'in_progress', phase: 'verify', processed: 0, cursor: null });
  assert.deepEqual(await run(db, { now: () => BASE + 3 }), { status: 'in_progress', phase: 'verify', processed: 1, cursor: 'p1' });
  assert.deepEqual(await run(db, { now: () => BASE + 4 }), { status: 'in_progress', phase: 'verify', processed: 1, cursor: 'p2' });
  assert.deepEqual(await run(db, { now: () => BASE + 5 }), { status: 'completed', phase: 'verify', processed: 0, cursor: 'p2' });
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 2);
  assert.equal(sqlite.prepare('SELECT state FROM ft_migrations WHERE version = 2').get().state, 'completed');
  assert.deepEqual(await run(db, { now: () => BASE + 6 }), { status: 'already_completed', processed: 0, cursor: null });
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 2);
  sqlite.close();
});

test('a held lease rejects a second runner without changing the migration ledger', async () => {
  const { sqlite, db } = fixture();
  sqlite.prepare(`UPDATE ft_migration_lock SET owner_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = 1`)
    .run(OWNER_B, BASE + 60_000, BASE);
  assert.deepEqual(await run(db), { status: 'lease_busy', processed: 0, cursor: null });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ft_migrations WHERE version = 2').get().n, 0);
  sqlite.close();
});

test('failed batch rolls back count and cursor so a later invocation safely resumes', async () => {
  const { sqlite, db, addPlaylist, setBeforeStatement } = fixture();
  addPlaylist('p1', ['song-1']);
  sqlite.prepare('UPDATE Member_Playlists SET cached_song_count = 0').run();
  let failOnce = true;
  setBeforeStatement((sql) => {
    if (failOnce && sql.includes('UPDATE ft_migration_progress SET cursor = ?')) {
      failOnce = false;
      throw new Error('sensitive SQL detail');
    }
  });
  await assert.rejects(run(db), { code: 'migration_storage_unavailable' });
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 0);
  assert.equal(sqlite.prepare('SELECT cursor FROM ft_migration_progress WHERE version = 2').get().cursor, null);
  assert.equal(sqlite.prepare('SELECT state, error_code FROM ft_migrations WHERE version = 2').get().state, 'failed');
  assert.equal(sqlite.prepare('SELECT state, error_code FROM ft_migrations WHERE version = 2').get().error_code,
    'PLAYLIST_COUNT_STEP_FAILED');
  assert.equal(sqlite.prepare('SELECT owner_token FROM ft_migration_lock WHERE id = 1').get().owner_token, null);
  assert.deepEqual(await run(db, { now: () => BASE + 1 }), { status: 'in_progress', phase: 'backfill', processed: 1, cursor: 'p1' });
  assert.equal(sqlite.prepare('SELECT state FROM ft_migrations WHERE version = 2').get().state, 'running');
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 1);
  sqlite.close();
});

test('stolen owner is fenced before writes and cannot release the successor lease', async () => {
  const { sqlite, db, addPlaylist, setBeforeBatch } = fixture();
  addPlaylist('p1', ['song-1']);
  sqlite.prepare('UPDATE Member_Playlists SET cached_song_count = 0').run();
  setBeforeBatch(() => sqlite.prepare(`UPDATE ft_migration_lock SET owner_token = ?,
    lease_expires_at = ?, updated_at = ? WHERE id = 1`).run(OWNER_B, BASE + 80_000, BASE + 1));
  await assert.rejects(run(db), { code: 'migration_storage_unavailable' });
  assert.equal(sqlite.prepare('SELECT owner_token FROM ft_migration_lock WHERE id = 1').get().owner_token, OWNER_B);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ft_migrations WHERE version = 2').get().n, 0);
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 0);
  assert.deepEqual(await run(db, { ownerToken: OWNER_B, now: () => BASE + 80_000 }),
    { status: 'in_progress', phase: 'backfill', processed: 1, cursor: 'p1' });
  sqlite.close();
});

test('an owner whose lease expires during the run cannot advance the cursor', async () => {
  const { sqlite, db, addPlaylist } = fixture();
  addPlaylist('p1', ['song-1']);
  sqlite.prepare('UPDATE Member_Playlists SET cached_song_count = 0').run();
  let ticks = 0;
  const clock = () => ++ticks <= 2 ? BASE : BASE + 61_000;
  await assert.rejects(run(db, { now: clock }), { code: 'migration_storage_unavailable' });
  assert.equal(sqlite.prepare('SELECT cursor FROM ft_migration_progress WHERE version = 2').get().cursor, null);
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 0);
  assert.deepEqual(await run(db, { ownerToken: OWNER_B, now: () => BASE + 61_000 }),
    { status: 'in_progress', phase: 'backfill', processed: 1, cursor: 'p1' });
  sqlite.close();
});

test('database wall clock fences an owner even when caller clock is stale', async () => {
  const { sqlite, db, addPlaylist, setBeforeBatch } = fixture();
  addPlaylist('p1', ['song-1']);
  setBeforeBatch(() => sqlite.prepare('UPDATE ft_migration_lock SET lease_expires_at = ? WHERE id = 1').run(BASE - 1));
  await assert.rejects(run(db, { now: () => BASE - 5_000 }), { code: 'migration_storage_unavailable' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ft_migrations WHERE version = 2').get().n, 0);
  sqlite.close();
});

test('lease renewal and expiry fencing use the supplied leaseMs, not a fixed default', async () => {
  const { sqlite, db, addPlaylist, setBeforeStatement } = fixture();
  addPlaylist('p1', ['song-1']);
  let ticks = 0;
  let observedExpiry = null;
  setBeforeStatement((sql) => {
    if (sql.includes('SELECT 1, NULL, 0, 0 WHERE NOT EXISTS')) {
      observedExpiry = sqlite.prepare('SELECT lease_expires_at FROM ft_migration_lock WHERE id = 1').get().lease_expires_at;
    }
  });
  const clock = () => BASE + [0, 1_000, 2_000, 3_000][Math.min(ticks++, 3)];
  assert.equal((await run(db, { now: clock, leaseMs: 10_000 })).status, 'in_progress');
  assert.equal(observedExpiry, BASE + 12_000);
  sqlite.close();

  const expired = fixture();
  expired.addPlaylist('p1', ['song-1']);
  let expirationTicks = 0;
  const expiredClock = () => ++expirationTicks <= 2 ? BASE : BASE + 10_001;
  await assert.rejects(run(expired.db, { now: expiredClock, leaseMs: 10_000 }),
    { code: 'migration_storage_unavailable' });
  assert.equal(expired.sqlite.prepare('SELECT cursor FROM ft_migration_progress WHERE version = 2').get().cursor, null);
  expired.sqlite.close();
});

test('a stale earlier count is repaired by the bounded verify phase before finalizing', async () => {
  const { sqlite, db, addPlaylist } = fixture();
  addPlaylist('p1', ['song-1']);
  addPlaylist('p2', ['song-2']);
  sqlite.prepare('UPDATE Member_Playlists SET cached_song_count = 0').run();
  await run(db);
  await run(db, { now: () => BASE + 1 });
  sqlite.prepare("UPDATE Member_Playlists SET cached_song_count = 0 WHERE id = 'p1'").run();
  assert.deepEqual(await run(db, { now: () => BASE + 2 }),
    { status: 'in_progress', phase: 'verify', processed: 0, cursor: null });
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  assert.equal((await run(db, { now: () => BASE + 3 })).phase, 'verify');
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 1);
  await run(db, { now: () => BASE + 4 });
  assert.equal((await run(db, { now: () => BASE + 5 })).status, 'completed');
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p1'").get().cached_song_count, 1);
  sqlite.close();
});

test('verify-phase failure keeps phase and cursor, records a safe failure, then resumes', async () => {
  const { sqlite, db, addPlaylist, setBeforeStatement } = fixture();
  addPlaylist('p1', ['song-1']);
  await run(db);
  assert.equal((await run(db, { now: () => BASE + 1 })).phase, 'verify');
  let failOnce = true;
  setBeforeStatement((sql) => {
    if (failOnce && sql.includes('UPDATE ft_migration_progress SET cursor = ?')) {
      failOnce = false;
      throw new Error('private D1 text');
    }
  });
  await assert.rejects(run(db, { now: () => BASE + 2 }), { code: 'migration_storage_unavailable' });
  assert.equal(sqlite.prepare('SELECT phase FROM ft_migration_progress WHERE version = 2').get().phase, 'verify');
  assert.equal(sqlite.prepare('SELECT cursor FROM ft_migration_progress WHERE version = 2').get().cursor, null);
  assert.equal(sqlite.prepare('SELECT state FROM ft_migrations WHERE version = 2').get().state, 'failed');
  assert.deepEqual(await run(db, { now: () => BASE + 3 }),
    { status: 'in_progress', phase: 'verify', processed: 1, cursor: 'p1' });
  assert.equal((await run(db, { now: () => BASE + 4 })).status, 'completed');
  sqlite.close();
});

test('finalization uses bounded-result playlist verification', async () => {
  const { sqlite, db, addPlaylist } = fixture();
  addPlaylist('p1', ['song-1']);
  const selected = [];
  const prepared = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/FROM Member_Playlists\s+WHERE \(\? IS NULL OR id > \?\)/.test(sql)) selected.push(sql);
    if (/SELECT 1 AS mismatch FROM Member_Playlists/.test(sql) && !sql.includes('LIMIT 1')) {
      throw new Error('unbounded verification result');
    }
    return prepared(sql);
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await run(db, { now: () => BASE + attempt });
    if (result.status === 'completed') break;
  }
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 2);
  assert.equal(selected.length, 4);
  assert.ok(selected.every((sql) => sql.includes('LIMIT ?')));
  sqlite.close();
});

test('plausible forged verify cursor cannot mark incorrect counts complete', async () => {
  const { sqlite, db, addPlaylist } = fixture();
  addPlaylist('a', ['song-1']);
  addPlaylist('b');
  assert.equal((await run(db)).cursor, 'a');
  sqlite.exec(`UPDATE Member_Playlists SET cached_song_count = 0 WHERE id = 'a';
    UPDATE ft_migration_progress SET phase = 'verify', cursor = 'b' WHERE version = 2;`);
  const recovered = await run(db, { now: () => BASE + 1 });
  assert.deepEqual(recovered, { status: 'in_progress', phase: 'verify', processed: 0, cursor: null });
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  for (let step = 2; step < 6; step += 1) {
    const result = await run(db, { now: () => BASE + step });
    if (result.status === 'completed') break;
  }
  assert.equal(sqlite.prepare('SELECT cached_song_count FROM Member_Playlists WHERE id = ?').get('a').cached_song_count, 1);
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 2);
  sqlite.close();
});

test('completion ledger and instance version roll back together when final statement fails', async () => {
  const { sqlite, db, setBeforeStatement } = fixture();
  assert.equal((await run(db)).phase, 'verify');
  let failOnce = true;
  setBeforeStatement((sql) => {
    if (failOnce && sql.includes('UPDATE ft_instance SET schema_version = 2')) {
      failOnce = false;
      throw new Error('database internals');
    }
  });
  await assert.rejects(run(db, { now: () => BASE + 1 }), { code: 'migration_storage_unavailable' });
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  assert.equal(sqlite.prepare('SELECT state, error_code FROM ft_migrations WHERE version = 2').get().state, 'failed');
  assert.equal(sqlite.prepare('SELECT state, error_code FROM ft_migrations WHERE version = 2').get().error_code,
    'PLAYLIST_COUNT_STEP_FAILED');
  assert.equal((await run(db, { now: () => BASE + 2 })).status, 'completed');
  sqlite.close();
});

test('a completed migration can reclaim an expired lock after final release fails', async () => {
  const { sqlite, db } = fixture();
  assert.equal((await run(db)).phase, 'verify');
  const originalPrepare = db.prepare.bind(db);
  let releaseFailsOnce = true;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (/UPDATE ft_migration_lock\s+SET owner_token = NULL/.test(sql)) {
      const originalRun = statement.run.bind(statement);
      statement.run = async () => {
        if (releaseFailsOnce) {
          releaseFailsOnce = false;
          throw new Error('transient D1 release failure');
        }
        return originalRun();
      };
    }
    return statement;
  };
  await assert.rejects(run(db, { now: () => BASE + 1 }), { code: 'migration_storage_unavailable' });
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 2);
  assert.equal(sqlite.prepare('SELECT state FROM ft_migrations WHERE version = 2').get().state, 'completed');
  for (const name of ['0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
    '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
    '0007_default_ai_guidance.sql', '0008_assistant_memory.sql']) {
    sqlite.exec(readFileSync(new URL(`../../db/migrations-flaretune/${name}`, import.meta.url), 'utf8'));
  }
  assert.equal((await resolveInstanceState(db, BASE + 60_002)).reason, 'migration_lock_stale');
  assert.deepEqual(await run(db, { ownerToken: OWNER_B, now: () => BASE + 2 }),
    { status: 'lease_busy', processed: 0, cursor: null });
  assert.deepEqual(await run(db, { ownerToken: OWNER_B, now: () => BASE + 60_002 }),
    { status: 'already_completed', processed: 0, cursor: null });
  assert.equal(sqlite.prepare('SELECT owner_token FROM ft_migration_lock WHERE id = 1').get().owner_token, null);
  // This fixture intentionally has a playlist owner but no initialized admin;
  // the remaining claim-state error is unrelated to the migration lock.
  assert.equal((await resolveInstanceState(db, BASE + 60_003)).reason, 'claim_state_inconsistent');
  sqlite.close();
});

test('unknown version and mismatched ledger fail closed without applying SQL', async () => {
  const { sqlite, db } = fixture();
  sqlite.prepare('UPDATE ft_instance SET schema_version = 3 WHERE id = 1').run();
  await assert.rejects(run(db), { code: 'migration_version_unknown' });
  sqlite.prepare('UPDATE ft_instance SET schema_version = 1 WHERE id = 1').run();
  sqlite.prepare('UPDATE ft_migrations SET checksum = ? WHERE version = 1').run('0'.repeat(64));
  await assert.rejects(run(db), { code: 'migration_baseline_invalid' });
  sqlite.close();
});
