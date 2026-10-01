import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runKnownDatabaseUpgrade } from './upgradeDatabase.js';
import { resolveInstanceState } from './state.js';
import { MIGRATION_BUNDLE } from './migrationBundle.generated.js';
import { KNOWN_MIGRATIONS } from './schemaManifest.js';

const baseline = readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');

test('v2 protocol addon preserves profile secrets and assignment, and retries safely', async () => {
  const { sqlite, db } = fixture();
  try {
    for (let step = 0; step < 8; step += 1) {
      if ((await runKnownDatabaseUpgrade(db)).status === 'completed') break;
    }
    sqlite.exec(`DROP TABLE ai_profile_protocols;
      INSERT INTO ai_model_profiles (id,name,provider,model,encrypted_key,key_iv,created_at,updated_at,updated_by)
        VALUES ('legacy','Old','openai','gpt-fixture','ciphertext','iv',1,1,'admin');
      INSERT INTO ai_feature_assignments (feature,profile_id,updated_at,updated_by)
        VALUES ('assistant','legacy',1,'admin');`);
    const before = sqlite.prepare('SELECT * FROM ai_model_profiles').get();
    await runKnownDatabaseUpgrade(db);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_profile_protocols'").get());
    assert.deepEqual(sqlite.prepare('SELECT * FROM ai_model_profiles').get(), before);
    assert.equal(sqlite.prepare('SELECT profile_id FROM ai_feature_assignments').get().profile_id, 'legacy');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM ai_profile_protocols').get().count, 0);
    assert.equal((await runKnownDatabaseUpgrade(db)).status, 'current');
    sqlite.exec('DROP TABLE ai_profile_protocols');
    const failing = { ...db, batch: async () => { throw new Error('fixture batch unavailable'); } };
    await assert.rejects(runKnownDatabaseUpgrade(failing), { code: 'migration_supplemental_failed' });
    assert.deepEqual(sqlite.prepare('SELECT * FROM ai_model_profiles').get(), before);
    await runKnownDatabaseUpgrade(db);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_profile_protocols'").get());
  } finally { sqlite.close(); }
});

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(baseline);
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, db };
}

test('known v1 database upgrades in bounded steps and preserves personal playlist counts', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(`INSERT INTO accounts(account_id, username, role, created_at, updated_at)
    VALUES ('a', 'alice', 'admin', 1, 1);
    INSERT INTO account_credentials(account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, updated_at)
    VALUES ('a', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}',
      '${Buffer.alloc(16, 1).toString('base64url')}', '${Buffer.alloc(32, 2).toString('base64url')}', 1);
    UPDATE ft_instance SET initialized_at = 1 WHERE id = 1;
    INSERT INTO Songs(id, title) VALUES ('s', 'Song');
    INSERT INTO Member_Playlists(id, account_id, kind, name, created_at, updated_at)
    VALUES ('p', 'a', 'regular', 'Private', 1, 1);
    INSERT INTO Member_Playlist_Songs(playlist_id, song_id, sort_order, added_at)
    VALUES ('p', 's', 0, 1);`);
  assert.equal((await resolveInstanceState(db)).state, 'maintenance');
  let result;
  for (let step = 0; step < 8; step += 1) {
    const before = await resolveInstanceState(db);
    assert.equal(before.state, 'maintenance', `step ${step}`);
    assert.equal(before.schemaVersion, 1, JSON.stringify(before));
    assert.ok(['migration_pending', 'migration_interrupted', 'migration_running', 'migration_retryable'].includes(before.reason), JSON.stringify(before));
    result = await runKnownDatabaseUpgrade(db);
    if (result.status === 'completed') break;
  }
  assert.equal(result.status, 'completed');
  assert.equal(sqlite.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p'").get().cached_song_count, 1);
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 2);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'assistant_memories'").get());
  assert.equal((await runKnownDatabaseUpgrade(db)).status, 'current');
  sqlite.exec(`UPDATE ft_migration_lock SET owner_token = '${'b'.repeat(32)}', lease_expires_at = 1 WHERE id = 1`);
  assert.equal((await resolveInstanceState(db)).reason, 'migration_lock_stale');
  assert.equal((await runKnownDatabaseUpgrade(db)).status, 'current');
  assert.equal((await resolveInstanceState(db)).state, 'ready');
  sqlite.close();
});

test('secret upgrade resumes after a stale lease acquired before ledger start', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(`UPDATE ft_migration_lock SET owner_token = '${'c'.repeat(32)}', lease_expires_at = 1 WHERE id = 1`);
  assert.equal((await resolveInstanceState(db)).reason, 'migration_lock_stale');
  assert.equal((await runKnownDatabaseUpgrade(db)).status, 'in_progress');
  assert.equal(sqlite.prepare('SELECT owner_token FROM ft_migration_lock WHERE id = 1').get().owner_token, null);
  sqlite.close();
});

test('orphan legacy playlist songs are never deleted by known upgrade', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(`INSERT INTO Songs(id, title) VALUES ('song', 'Song');
    INSERT INTO Playlists(id, name) VALUES ('legacy', 'Shared');
    INSERT INTO Playlist_Songs(playlist_id, song_id, sort_order) VALUES ('legacy', 'song', 0);
    PRAGMA foreign_keys = OFF;
    DROP TABLE Playlists;`);
  assert.equal((await resolveInstanceState(db)).reason, 'migration_schema_inconsistent');
  await assert.rejects(() => runKnownDatabaseUpgrade(db), { code: 'invalid_state' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM Playlist_Songs').get().total, 1);
  sqlite.close();
});

test('missing baseline ledger never permits a retry to delete legacy playlists', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(`INSERT INTO Playlists(id, name) VALUES ('legacy', 'Shared');
    DELETE FROM ft_migrations WHERE version = 1;`);
  const migration = KNOWN_MIGRATIONS[1];
  sqlite.prepare(`INSERT INTO ft_migrations
    (version, name, checksum, stage, state, started_at, error_code)
    VALUES (2, ?, ?, 'migrate', 'failed', 1, 'PLAYLIST_COUNT_STEP_FAILED')`)
    .run(migration.name, migration.checksum);
  assert.equal((await resolveInstanceState(db)).reason, 'migration_ledger_incomplete');
  await assert.rejects(() => runKnownDatabaseUpgrade(db, { allowDestructive: true }),
    { code: 'invalid_state' });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM Playlists WHERE id = 'legacy'").get().total, 1);
  sqlite.close();
});

test('invalid saved migration cursor cannot delete legacy playlists', async () => {
  const { sqlite, db } = fixture();
  for (const statement of MIGRATION_BUNDLE[1].statements) sqlite.prepare(statement).run();
  sqlite.exec(`INSERT INTO Playlists(id, name) VALUES ('legacy', 'Shared');
    INSERT INTO ft_migration_progress(version, phase, cursor, updated_at)
      VALUES (2, 'backfill', '${'x'.repeat(241)}', 1);`);
  const migration = KNOWN_MIGRATIONS[1];
  sqlite.prepare(`INSERT INTO ft_migrations
    (version, name, checksum, stage, state, started_at, error_code)
    VALUES (2, ?, ?, 'migrate', 'failed', 1, 'PLAYLIST_COUNT_STEP_FAILED')`)
    .run(migration.name, migration.checksum);
  assert.equal((await resolveInstanceState(db)).reason, 'migration_retryable');
  await assert.rejects(() => runKnownDatabaseUpgrade(db, { allowDestructive: true }),
    { code: 'migration_step_failed' });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM Playlists WHERE id = 'legacy'").get().total, 1);
  sqlite.close();
});

test('plausible cursor with skipped counts cannot delete legacy playlists', async () => {
  const { sqlite, db } = fixture();
  for (const statement of MIGRATION_BUNDLE[1].statements) sqlite.prepare(statement).run();
  sqlite.exec(`INSERT INTO accounts(account_id, username, role, created_at, updated_at)
      VALUES ('a', 'alice', 'admin', 1, 1);
    INSERT INTO Songs(id, title) VALUES ('song', 'Song');
    INSERT INTO Member_Playlists(id, account_id, kind, name, created_at, updated_at)
      VALUES ('a', 'a', 'regular', 'A', 1, 1), ('b', 'a', 'regular', 'B', 1, 1);
    INSERT INTO Member_Playlist_Songs(playlist_id, song_id, sort_order, added_at)
      VALUES ('a', 'song', 0, 1);
    UPDATE Member_Playlists SET cached_song_count = 0 WHERE id = 'a';
    INSERT INTO Playlists(id, name) VALUES ('legacy', 'Shared');
    INSERT INTO ft_migration_progress(version, phase, cursor, updated_at)
      VALUES (2, 'verify', 'b', 1);`);
  const migration = KNOWN_MIGRATIONS[1];
  sqlite.prepare(`INSERT INTO ft_migrations
    (version, name, checksum, stage, state, started_at, error_code)
    VALUES (2, ?, ?, 'migrate', 'failed', 1, 'PLAYLIST_COUNT_STEP_FAILED')`)
    .run(migration.name, migration.checksum);
  await assert.rejects(() => runKnownDatabaseUpgrade(db, { allowDestructive: true }),
    { code: 'migration_step_failed' });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM Playlists WHERE id = 'legacy'").get().total, 1);
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  sqlite.close();
});

test('valid playlist IDs longer than 240 characters can migrate', async () => {
  const { sqlite, db } = fixture();
  const id = 'p'.repeat(241);
  sqlite.prepare(`INSERT INTO accounts(account_id, username, role, created_at, updated_at)
    VALUES ('a', 'alice', 'admin', 1, 1)`).run();
  sqlite.prepare(`INSERT INTO Member_Playlists(id, account_id, kind, name, created_at, updated_at)
    VALUES (?, 'a', 'regular', 'Long ID', 1, 1)`).run(id);
  let result;
  for (let step = 0; step < 6; step += 1) {
    result = await runKnownDatabaseUpgrade(db);
    if (result.status === 'completed') break;
  }
  assert.equal(result.status, 'completed');
  assert.equal(sqlite.prepare('SELECT cached_song_count FROM Member_Playlists WHERE id = ?').get(id).cached_song_count, 0);
  sqlite.close();
});

test('shared playlist data requires the secret maintenance path and backup confirmation', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec("INSERT INTO Playlists(id, name) VALUES ('legacy', 'Shared')");
  await assert.rejects(() => runKnownDatabaseUpgrade(db), { code: 'backup_required' });
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  const result = await runKnownDatabaseUpgrade(db, { allowDestructive: true });
  assert.equal(result.status, 'in_progress');
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'Playlists'").get(), undefined);
  sqlite.close();
});

test('compatible expanded v1 remains usable so an administrator can start upgrade from System Status', async () => {
  const { sqlite, db } = fixture();
  for (const migration of MIGRATION_BUNDLE.slice(1)) {
    for (const statement of migration.statements) sqlite.prepare(statement).run();
  }
  sqlite.exec(`INSERT INTO accounts(account_id, username, role, created_at, updated_at)
    VALUES ('a', 'alice', 'admin', 1, 1);
    INSERT INTO account_credentials(account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, updated_at)
    VALUES ('a', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}',
      '${Buffer.alloc(16, 1).toString('base64url')}', '${Buffer.alloc(32, 2).toString('base64url')}', 1);
    UPDATE ft_instance SET initialized_at = 1 WHERE id = 1;`);
  assert.deepEqual(await resolveInstanceState(db),
    { state: 'ready', reason: 'migration_available', schemaVersion: 1 });
  assert.equal((await runKnownDatabaseUpgrade(db)).status, 'in_progress');
  assert.equal((await resolveInstanceState(db)).state, 'maintenance');
  sqlite.close();
});

test('partially expanded v1 is rejected before supplemental migrations write data', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec('ALTER TABLE Member_Playlists ADD COLUMN cached_song_count INTEGER NOT NULL DEFAULT 0');
  await assert.rejects(() => runKnownDatabaseUpgrade(db), { code: 'migration_step_failed' });
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_model_profiles'").get(), undefined);
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').get().schema_version, 1);
  sqlite.close();
});
