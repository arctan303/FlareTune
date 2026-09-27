import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CURRENT_SCHEMA_VERSION, KNOWN_MIGRATIONS } from './schemaManifest.js';

const sql = readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const expand = readFileSync(new URL('../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8');

test('baseline migration checksum is immutable and matches the runtime manifest', () => {
  const migration = KNOWN_MIGRATIONS[0];
  assert.equal(migration.version, 1);
  assert.equal(migration.name, '0001_baseline.sql');
  assert.equal((sql.match(new RegExp(migration.checksum, 'g')) || []).length, 1);
  const normalized = sql.replace(migration.checksum, '0'.repeat(64));
  assert.equal(createHash('sha256').update(normalized).digest('hex'), migration.checksum);
});

test('v2 expand migration checksum is immutable and distinct from the application ledger', () => {
  const migration = KNOWN_MIGRATIONS[1];
  assert.equal(CURRENT_SCHEMA_VERSION, 2);
  assert.equal(migration.version, 2);
  assert.equal(migration.name, '0002_expand_playlist_count.sql');
  assert.equal(migration.stage, 'migrate');
  assert.equal(createHash('sha256').update(expand).digest('hex'), migration.checksum);
  assert.doesNotMatch(expand, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?ft_(?:instance|migrations)\b/i);
});

test('fresh baseline has only FlareTune account, control and music tables', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(sql);
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['ft_instance', 'ft_migrations', 'ft_migration_lock', 'accounts', 'account_credentials', 'account_sessions', 'instance_settings', 'audit_events', 'Songs', 'Playlists', 'Playlist_Songs', 'AI_Assistants']) {
    assert.ok(tables.includes(table), table);
  }
  assert.equal(tables.some((name) => /oauth|legacy|guest/i.test(name)), false);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  const instance = sqlite.prepare('SELECT schema_version, initialized_at FROM ft_instance WHERE id = 1').get();
  assert.equal(instance.schema_version, 1);
  assert.equal(instance.initialized_at, null);
  sqlite.close();
});
