import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migration = (name) => readFileSync(new URL(`../../db/migrations-flaretune/${name}`, import.meta.url), 'utf8');

test('system playlist removal preserves account playlists, songs, and personal shelf order', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of ['0001_baseline.sql', '0002_expand_playlist_count.sql',
    '0003_upgrade_assistant_model.sql']) db.exec(migration(name));
  db.exec(`
    INSERT INTO accounts (account_id, username, role, created_at, updated_at)
      VALUES ('owner', 'owner', 'member', 1, 1),
             ('other', 'other', 'member', 1, 1),
             ('hidden', 'hidden', 'member', 1, 1);
    INSERT INTO Songs (id, title, audio_url) VALUES ('song', 'Song', '/media/song');
    INSERT INTO Playlists (id, name) VALUES ('legacy', 'Legacy');
    INSERT INTO Playlist_Songs (playlist_id, song_id, sort_order) VALUES ('legacy', 'song', 0);
    INSERT INTO Member_Playlists (id, account_id, kind, name, created_at, updated_at)
      VALUES ('favorite', 'owner', 'favorite', '我喜欢', 1, 1),
             ('personal', 'owner', 'regular', 'Personal', 1, 1);
    INSERT INTO Member_Playlist_Songs (playlist_id, song_id, sort_order, added_at)
      VALUES ('personal', 'song', 0, 1);
    INSERT INTO Member_Playlist_Shelf (account_id, items_json, revision, updated_at)
      VALUES ('owner', '[{"kind":"member","id":"personal"},{"kind":"system","id":"legacy"},{"kind":"member","id":"favorite"}]', 3, 1),
             ('other', '["legacy",{"id":"orphan"},{"kind":"system","id":"legacy"}]', 2, 1),
             ('hidden', '[{"kind":"member","id":"another","hidden":false}]', 5, 1);
  `);
  db.exec(migration('0004_remove_system_playlists.sql'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.equal(tables.includes('Playlists'), false);
  assert.equal(tables.includes('Playlist_Songs'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Songs').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Member_Playlist_Songs').get().count, 1);
  const shelf = db.prepare("SELECT items_json, revision FROM Member_Playlist_Shelf WHERE account_id = 'owner'").get();
  assert.deepEqual(JSON.parse(shelf.items_json), [
    { kind: 'member', id: 'personal' }, { kind: 'member', id: 'favorite' },
  ]);
  assert.equal(shelf.revision, 4);
  const malformedShelf = db.prepare("SELECT items_json, revision FROM Member_Playlist_Shelf WHERE account_id = 'other'").get();
  assert.deepEqual(JSON.parse(malformedShelf.items_json), []);
  assert.equal(malformedShelf.revision, 3);
  const hiddenShelf = db.prepare("SELECT items_json, revision FROM Member_Playlist_Shelf WHERE account_id = 'hidden'").get();
  assert.deepEqual(JSON.parse(hiddenShelf.items_json), [{ kind: 'member', id: 'another' }]);
  assert.equal(hiddenShelf.revision, 6);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
