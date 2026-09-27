import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const baseline = readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const expand = readFileSync(new URL('../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(baseline);
  db.exec(`
    INSERT INTO accounts(account_id, username, role, created_at, updated_at) VALUES
      ('a', 'alice', 'admin', 1, 1), ('b', 'bob', 'member', 1, 1);
    INSERT INTO Songs(id, title) VALUES
      ('s1', 'One'), ('s2', 'Two'), ('s3', 'Three'), ('s4', 'Four');
    INSERT INTO Member_Playlists(id, account_id, kind, name, created_at, updated_at) VALUES
      ('p1', 'a', 'regular', 'First', 1, 1),
      ('p2', 'b', 'regular', 'Second', 1, 1);
    INSERT INTO Member_Playlist_Songs(playlist_id, song_id, sort_order, added_at) VALUES
      ('p1', 's1', 0, 1), ('p1', 's2', 1, 1), ('p2', 's3', 0, 1);
  `);
  return db;
}

// The v1 summary query deliberately keeps p.* and a computed song_count alias.
const v1Summary = `SELECT p.*,
  (SELECT COUNT(*) FROM Member_Playlist_Songs ps WHERE ps.playlist_id = p.id) AS song_count
  FROM Member_Playlists p ORDER BY p.id`;

function publicSummary(db) {
  return db.prepare(v1Summary).all().map(({ id, account_id, name, song_count }) => ({
    id, account_id, name, song_count,
  }));
}

function cachedCounts(db) {
  return db.prepare('SELECT id, cached_song_count FROM Member_Playlists ORDER BY id')
    .all().map(({ id, cached_song_count }) => ({ id, cached_song_count }));
}

test('expand keeps v1 playlist reads and control rows unchanged and leaves preexisting counts for backfill', () => {
  const db = fixture();
  try {
    const before = publicSummary(db);
    const instance = db.prepare('SELECT * FROM ft_instance').all();
    const ledger = db.prepare('SELECT * FROM ft_migrations').all();
    assert.deepEqual(before.map((row) => row.song_count), [2, 1]);

    db.exec(expand);

    assert.deepEqual(publicSummary(db), before);
    const expandedRow = db.prepare(v1Summary).get();
    assert.equal(expandedRow.song_count, 2);
    assert.equal(expandedRow.cached_song_count, 0);
    assert.deepEqual(cachedCounts(db), [
      { id: 'p1', cached_song_count: 0 },
      { id: 'p2', cached_song_count: 0 },
    ]);
    assert.deepEqual(db.prepare('SELECT * FROM ft_instance').all(), instance);
    assert.deepEqual(db.prepare('SELECT * FROM ft_migrations').all(), ledger);
    assert.deepEqual(db.prepare('SELECT * FROM ft_migration_progress').all(), []);
    const progressColumns = db.prepare('PRAGMA table_info(ft_migration_progress)').all();
    assert.ok(progressColumns.some((column) => column.name === 'phase'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('v1 writes remain valid while insert, delete, move and owner changes recalculate actual association rows', () => {
  const db = fixture();
  try {
    db.exec(expand);
    // Old code omits the new column; the trigger must include preexisting rows.
    db.exec("INSERT INTO Member_Playlist_Songs(playlist_id, song_id, sort_order, added_at) VALUES ('p1', 's4', 2, 2)");
    assert.deepEqual(cachedCounts(db), [
      { id: 'p1', cached_song_count: 3 },
      { id: 'p2', cached_song_count: 0 },
    ]);

    db.exec("DELETE FROM Member_Playlist_Songs WHERE playlist_id = 'p1' AND song_id = 's2'");
    assert.equal(cachedCounts(db)[0].cached_song_count, 2);

    db.exec("UPDATE Member_Playlist_Songs SET playlist_id = 'p2' WHERE playlist_id = 'p1' AND song_id = 's4'");
    assert.deepEqual(cachedCounts(db), [
      { id: 'p1', cached_song_count: 1 },
      { id: 'p2', cached_song_count: 2 },
    ]);

    db.exec("UPDATE Member_Playlist_Songs SET song_id = 's2' WHERE playlist_id = 'p2' AND song_id = 's4'");
    assert.equal(cachedCounts(db)[1].cached_song_count, 2);

    // An owner change must repair a pre-backfill/stale count, not just retain it.
    db.exec("UPDATE Member_Playlists SET cached_song_count = 0 WHERE id = 'p1'");
    db.exec("UPDATE Member_Playlists SET account_id = 'b' WHERE id = 'p1'");
    assert.equal(cachedCounts(db)[0].cached_song_count, 1);

    // Cascading song deletion removes an association and must not leave a stale count.
    db.exec("DELETE FROM Songs WHERE id = 's1'");
    assert.equal(cachedCounts(db)[0].cached_song_count, 0);

    db.exec("INSERT INTO Member_Playlists(id, account_id, kind, name, created_at, updated_at) VALUES ('p3', 'a', 'regular', 'Third', 3, 3)");
    assert.equal(db.prepare("SELECT cached_song_count FROM Member_Playlists WHERE id = 'p3'").get().cached_song_count, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
