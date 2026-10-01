import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { resolveInstanceState } from './state.js';
import { KNOWN_MIGRATIONS } from './schemaManifest.js';
import { SCHEMA_CHECK_TTL_MS } from './schemaInventory.js';

const baseline = readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const expand = readFileSync(new URL('../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8');
const now = Date.now();
const validSalt = Buffer.alloc(16, 1).toString('base64url');
const validHash = Buffer.alloc(32, 2).toString('base64url');

function fixture({ current = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(baseline);
  if (current) {
    sqlite.exec(expand);
    for (const name of ['0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
      '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
      '0007_default_ai_guidance.sql', '0008_assistant_memory.sql']) {
      sqlite.exec(readFileSync(new URL(`../../db/migrations-flaretune/${name}`, import.meta.url), 'utf8'));
    }
    sqlite.prepare(`INSERT INTO ft_migrations (version, name, checksum, stage, state, started_at, completed_at)
      VALUES (2, ?, ?, 'migrate', 'completed', 1, 1)`).run(KNOWN_MIGRATIONS[1].name, KNOWN_MIGRATIONS[1].checksum);
    sqlite.exec('UPDATE ft_instance SET schema_version = 2 WHERE id = 1');
  }
  const d1 = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) { statement.bind(...values); return this; },
        async first() { return statement.get() ?? null; },
        async all() { return { results: statement.all() }; },
        async run() { const result = statement.run(); return { meta: { changes: result.changes } }; },
      };
    },
  };
  return { sqlite, d1 };
}

function readyFixture() {
  const f = fixture({ current: true });
  f.sqlite.exec(`INSERT INTO accounts (account_id, username, role, created_at, updated_at)
    VALUES ('a1', 'owner', 'admin', 1, 1);
    INSERT INTO account_credentials (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, updated_at)
    VALUES ('a1', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}', '${validSalt}', '${validHash}', 1);
    UPDATE ft_instance SET initialized_at = 1 WHERE id = 1;`);
  const queries = [];
  return { ...f, queries, observed: { prepare(sql) { queries.push(sql); return f.d1.prepare(sql); } } };
}

test('serving requests coalesce metadata and reuse it for at most 60 seconds without caching control state', async () => {
  const f = readyFixture();
  const read = (time) => resolveInstanceState(f.observed, time, { cacheSchema: true });
  const states = await Promise.all(Array.from({ length: 40 }, () => read(now)));
  assert.ok(states.every((result) => result.state === 'ready'));
  assert.equal(f.queries.filter((sql) => sql.includes('FROM sqlite_master')).length, 1);
  assert.equal(f.queries.filter((sql) => sql.startsWith('PRAGMA')).length, 1);
  assert.equal(f.queries.filter((sql) => sql.includes('FROM ft_instance')).length, 40);
  assert.equal((await read(now + SCHEMA_CHECK_TTL_MS - 1)).state, 'ready');
  assert.equal(f.queries.filter((sql) => sql.includes('FROM sqlite_master')).length, 1);
  f.sqlite.exec('DROP TRIGGER ft_member_playlist_songs_insert_count');
  assert.equal((await read(now + SCHEMA_CHECK_TTL_MS)).reason, 'schema_structure_invalid');
  assert.equal(f.queries.filter((sql) => sql.includes('FROM sqlite_master')).length, 2);
  f.sqlite.close();
});

test('warm schema never hides maintenance, damaged ledger, disabled admin or storage errors', async () => {
  for (const mutation of [
    `UPDATE ft_migration_lock SET owner_token = '${'a'.repeat(32)}', lease_expires_at = ${now + 60_000}`,
    "UPDATE ft_migrations SET checksum = '0' || substr(checksum, 2)",
    "UPDATE accounts SET status = 'disabled'",
    'DROP TABLE ft_instance',
  ]) {
    const f = readyFixture();
    assert.equal((await resolveInstanceState(f.observed, now, { cacheSchema: true })).state, 'ready');
    f.sqlite.exec(mutation);
    assert.notEqual((await resolveInstanceState(f.observed, now + 1, { cacheSchema: true })).state, 'ready', mutation);
    const before = f.queries.filter((sql) => sql.includes('FROM sqlite_master')).length;
    await resolveInstanceState(f.observed, now + 2, { cacheSchema: true });
    assert.ok(f.queries.filter((sql) => sql.includes('FROM sqlite_master')).length > before);
    f.sqlite.close();
  }
});

test('full checks and separate databases cannot reuse a warm serving schema', async () => {
  const a = readyFixture();
  const b = readyFixture();
  await resolveInstanceState(a.observed, now, { cacheSchema: true });
  b.sqlite.exec('DROP TRIGGER ft_member_playlist_songs_insert_count');
  assert.equal((await resolveInstanceState(b.observed, now, { cacheSchema: true })).reason, 'schema_structure_invalid');
  a.sqlite.exec('DROP TRIGGER ft_member_playlist_songs_insert_count');
  assert.equal((await resolveInstanceState(a.observed, now + 1, { cacheSchema: true })).state, 'ready');
  assert.equal((await resolveInstanceState(a.observed, now + 1)).reason, 'schema_structure_invalid');
  assert.equal((await resolveInstanceState(a.observed, now + 2, { cacheSchema: true })).reason, 'schema_structure_invalid');
  a.sqlite.close(); b.sqlite.close();
});

test('v1 baseline awaits migration, then completed v2 is setup_required', async () => {
  const old = fixture();
  assert.deepEqual(await resolveInstanceState(old.d1, now), { state: 'maintenance', reason: 'migration_pending', schemaVersion: 1 });
  old.sqlite.close();
  const { sqlite, d1 } = fixture({ current: true });
  assert.deepEqual(await resolveInstanceState(d1, now), { state: 'setup_required', reason: null, schemaVersion: 2 });
  sqlite.close();
});

test('initialized instance requires an active admin with credentials', async () => {
  const { sqlite, d1 } = fixture({ current: true });
  sqlite.exec(`INSERT INTO accounts (account_id, username, role, created_at, updated_at) VALUES ('a1', 'owner', 'admin', 1, 1);
    INSERT INTO account_credentials (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, updated_at)
    VALUES ('a1', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}', '${validSalt}', '${validHash}', 1);`);
  assert.equal((await resolveInstanceState(d1, now)).reason, 'claim_state_inconsistent');
  sqlite.exec('UPDATE ft_instance SET initialized_at = 1 WHERE id = 1');
  assert.equal((await resolveInstanceState(d1, now)).state, 'ready');
  sqlite.exec("UPDATE accounts SET status = 'disabled' WHERE account_id = 'a1'");
  assert.equal((await resolveInstanceState(d1, now)).reason, 'claim_state_inconsistent');
  sqlite.close();
});

test('unsupported or damaged administrator credentials cannot make an instance ready', async () => {
  const { sqlite, d1 } = fixture({ current: true });
  sqlite.exec(`INSERT INTO accounts (account_id, username, role, created_at, updated_at) VALUES ('a1', 'owner', 'admin', 1, 1);
    INSERT INTO account_credentials (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, updated_at)
    VALUES ('a1', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}', '${validSalt}', '${validHash}', 1);
    UPDATE ft_instance SET initialized_at = 1 WHERE id = 1;`);
  for (const mutation of [
    "UPDATE account_credentials SET kdf = 'unsupported' WHERE account_id = 'a1'",
    "UPDATE account_credentials SET kdf = 'pbkdf2-sha256-chain', salt = 'short' WHERE account_id = 'a1'",
    `UPDATE account_credentials SET salt = '${validSalt}', kdf_params_json = '{"iterations":1}' WHERE account_id = 'a1'`,
    "UPDATE account_credentials SET kdf_params_json = '{\"iterations\":100000,\"rounds\":6}', password_hash = 'x' WHERE account_id = 'a1'",
  ]) {
    sqlite.exec(mutation);
    assert.equal((await resolveInstanceState(d1, now)).reason, 'claim_state_inconsistent');
  }
  sqlite.close();
});

test('known running v2 migration remains in maintenance with or without a live lock', async () => {
  const { sqlite, d1 } = fixture();
  const migration = KNOWN_MIGRATIONS[1];
  sqlite.prepare(`INSERT INTO ft_migrations (version, name, checksum, stage, state, started_at)
    VALUES (2, ?, ?, 'migrate', 'running', 1)`).run(migration.name, migration.checksum);
  sqlite.exec(`UPDATE ft_migration_lock SET owner_token = '${'a'.repeat(32)}', lease_expires_at = ${now + 60_000} WHERE id = 1;`);
  assert.equal((await resolveInstanceState(d1, now)).state, 'maintenance');
  assert.equal((await resolveInstanceState(d1, now + 61_000)).reason, 'migration_interrupted');
  sqlite.close();
});

test('running baseline cannot grant maintenance upgrade access', async () => {
  const { sqlite, d1 } = fixture();
  sqlite.exec(`UPDATE ft_migrations SET state = 'running', completed_at = NULL WHERE version = 1;
    UPDATE ft_migration_lock SET owner_token = '${'a'.repeat(32)}', lease_expires_at = ${now + 60_000} WHERE id = 1;`);
  assert.equal((await resolveInstanceState(d1, now)).reason, 'migration_ledger_incomplete');
  sqlite.close();
});

test('known standalone lock remains in maintenance until secret recovery', async () => {
  const { sqlite, d1 } = fixture();
  sqlite.exec(`UPDATE ft_migration_lock SET owner_token = '${'c'.repeat(32)}', lease_expires_at = ${now + 60_000} WHERE id = 1`);
  assert.equal((await resolveInstanceState(d1, now)).state, 'maintenance');
  assert.deepEqual(await resolveInstanceState(d1, now + 61_000),
    { state: 'maintenance', reason: 'migration_lock_stale', schemaVersion: 1 });
  sqlite.close();
});

test('completed v2 with missing business table fails closed', async () => {
  const { sqlite, d1 } = fixture({ current: true });
  sqlite.exec('DROP TABLE Songs');
  assert.deepEqual(await resolveInstanceState(d1, now),
    { state: 'recovery_required', reason: 'schema_structure_invalid', schemaVersion: null });
  sqlite.close();
});

test('one schema inventory detects a missing required trigger on the next request', async () => {
  const { sqlite, d1 } = fixture({ current: true });
  let inventories = 0;
  const observed = { prepare(sql) {
    if (sql.includes('FROM sqlite_master')) inventories += 1;
    return d1.prepare(sql);
  } };
  assert.equal((await resolveInstanceState(observed, now)).state, 'setup_required');
  assert.equal(inventories, 1);
  sqlite.exec('DROP TRIGGER ft_member_playlist_songs_insert_count');
  assert.deepEqual(await resolveInstanceState(observed, now),
    { state: 'recovery_required', reason: 'schema_structure_invalid', schemaVersion: null });
  assert.equal(inventories, 2);
  sqlite.close();
});

test('legacy playlist tables must remain paired while v1 migration is pending', async () => {
  const { sqlite, d1 } = fixture();
  sqlite.exec('PRAGMA foreign_keys = OFF; DROP TABLE Playlists');
  assert.deepEqual(await resolveInstanceState(d1, now),
    { state: 'recovery_required', reason: 'migration_schema_inconsistent', schemaVersion: null });
  sqlite.close();
});

test('damaged migration lock fails closed before setup or ready', async () => {
  for (const initialized of [false, true]) {
    for (const lease of [1, -1, 'invalid']) {
      const { sqlite, d1 } = fixture({ current: true });
      if (initialized) {
        sqlite.exec(`INSERT INTO accounts (account_id, username, role, created_at, updated_at)
          VALUES ('a1', 'owner', 'admin', 1, 1);
          INSERT INTO account_credentials (account_id, kdf, kdf_version, kdf_params_json,
            salt, password_hash, updated_at)
          VALUES ('a1', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}',
            '${validSalt}', '${validHash}', 1);
          UPDATE ft_instance SET initialized_at = 1 WHERE id = 1;`);
      }
      sqlite.exec('PRAGMA ignore_check_constraints = ON');
      sqlite.prepare('UPDATE ft_migration_lock SET lease_expires_at = ? WHERE id = 1').run(lease);
      assert.deepEqual(await resolveInstanceState(d1, now), {
        state: 'recovery_required', reason: 'migration_lock_invalid', schemaVersion: null,
      });
      sqlite.close();
    }
  }
});

test('failed, unknown and checksum-mismatched migrations fail closed', async () => {
  for (const mutation of [
    "UPDATE ft_migrations SET state = 'failed', completed_at = NULL, error_code = 'interrupted' WHERE version = 1",
    'UPDATE ft_migrations SET started_at = 0 WHERE version = 1',
    'UPDATE ft_migrations SET started_at = completed_at + 1 WHERE version = 1',
    "UPDATE ft_migrations SET checksum = '0' || substr(checksum, 2) WHERE version = 1",
    "INSERT INTO ft_migrations (version, name, checksum, stage, state, started_at, completed_at) VALUES (2, 'unknown.sql', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'expand', 'completed', 1, 1)",
  ]) {
    const { sqlite, d1 } = fixture();
    sqlite.exec(mutation);
    assert.equal((await resolveInstanceState(d1, now)).state, 'recovery_required');
    sqlite.close();
  }
});

test('missing control plane and incompatible future schema fail closed', async () => {
  assert.equal((await resolveInstanceState(null, now)).state, 'recovery_required');
  const old = new DatabaseSync(':memory:');
  old.exec('CREATE TABLE Songs (id TEXT PRIMARY KEY)');
  const oldD1 = { prepare(sql) { return { async first() { return old.prepare(sql).get(); } }; } };
  assert.equal((await resolveInstanceState(oldD1, now)).state, 'recovery_required');
  old.close();
  const { sqlite, d1 } = fixture();
  sqlite.exec('UPDATE ft_instance SET schema_version = 3 WHERE id = 1');
  assert.equal((await resolveInstanceState(d1, now)).reason, 'schema_version_unknown');
  sqlite.close();
});

test('one transient control-plane read failure is retried without weakening recovery checks', async () => {
  const { sqlite, d1 } = fixture({ current: true });
  sqlite.exec(`INSERT INTO accounts (account_id, username, role, created_at, updated_at) VALUES ('a1', 'owner', 'admin', 1, 1);
    INSERT INTO account_credentials (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, updated_at)
    VALUES ('a1', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}', '${validSalt}', '${validHash}', 1);
    UPDATE ft_instance SET initialized_at = 1 WHERE id = 1;`);
  let reads = 0;
  const intermittent = { prepare(sql) {
    if (sql.startsWith('SELECT schema_version')) {
      reads += 1;
      if (reads === 1) return { async first() { throw new Error('temporary D1 transport failure'); } };
    }
    return d1.prepare(sql);
  } };
  assert.equal((await resolveInstanceState(intermittent, now)).state, 'ready');
  assert.equal(reads, 2);
  const unavailable = { prepare() { return { async first() { throw new Error('D1 unavailable'); } }; } };
  assert.deepEqual(await resolveInstanceState(unavailable, now),
    { state: 'recovery_required', reason: 'control_plane_unavailable', schemaVersion: null });
  sqlite.exec("UPDATE ft_migrations SET state = 'failed', completed_at = NULL, error_code = 'migration_failed' WHERE version = 2");
  assert.equal((await resolveInstanceState(d1, now)).reason, 'migration_failed');
  sqlite.close();
});
