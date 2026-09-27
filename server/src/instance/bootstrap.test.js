import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeEmptyDatabase } from './bootstrap.js';
import { resolveInstanceState } from './state.js';
import { MIGRATION_BUNDLE } from './migrationBundle.generated.js';
import { issueSetupProof, verifySetupProof } from './setupProof.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  let failAt = -1;
  const db = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
        runSync() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement, index) => {
          if (index === failAt) throw new Error('injected failure');
          return statement.runSync();
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, db, failAt(index) { failAt = index; } };
}

test('fresh D1 enters setup and the built-in bundle installs a complete schema atomically', async () => {
  const { sqlite, db } = fixture();
  assert.deepEqual(await resolveInstanceState(db), { state: 'setup_required', reason: null, schemaVersion: 0 });
  await initializeEmptyDatabase(db);
  await initializeEmptyDatabase(db);
  assert.equal((await resolveInstanceState(db)).schemaVersion, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ft_migrations').get().n, 2);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'assistant_memories'").get());
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'Playlists'").get(), undefined);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  sqlite.close();
});

test('failed bootstrap rolls back every statement and permits a clean retry', async () => {
  const { sqlite, db, failAt } = fixture();
  failAt(MIGRATION_BUNDLE[0].statements.length + 2);
  await assert.rejects(() => initializeEmptyDatabase(db), { code: 'bootstrap_failed' });
  assert.deepEqual(await resolveInstanceState(db), { state: 'setup_required', reason: null, schemaVersion: 0 });
  failAt(-1);
  await initializeEmptyDatabase(db);
  assert.equal((await resolveInstanceState(db)).state, 'setup_required');
  sqlite.close();
});

test('unrelated or partially created tables cannot be mistaken for an empty installation', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec('CREATE TABLE Songs (id TEXT PRIMARY KEY)');
  assert.equal((await resolveInstanceState(db)).state, 'recovery_required');
  await assert.rejects(() => initializeEmptyDatabase(db), { code: 'invalid_state' });
  sqlite.close();
});

test('short-lived setup proof binds to the origin and secret', async () => {
  const secret = 'this-is-a-local-test-secret-of-sufficient-length';
  const now = Date.now();
  assert.equal(await issueSetupProof(secret, 'incorrect', 'https://music.example', now), null);
  const proof = await issueSetupProof(secret, secret, 'https://music.example', now);
  assert.equal(await verifySetupProof(secret, proof, 'https://music.example', now + 1000), true);
  assert.equal(await verifySetupProof(secret, proof, 'https://other.example', now + 1000), false);
  assert.equal(await verifySetupProof(secret, proof, 'https://music.example', now + 600_001), false);
  assert.equal(await verifySetupProof(`${secret}x`, proof, 'https://music.example', now), false);
});
