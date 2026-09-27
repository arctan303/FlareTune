import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  AccountPlaylistError,
  addSongsToPlaylists,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistShelf,
  listPlaylists,
  removePlaylistSong,
  replacePlaylistSongs,
  updatePlaylist,
  updatePlaylistShelf,
} from './accountPlaylists.js';

class Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.owner, this.sql, values); }
  async first() { return this.owner.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.owner.database.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.owner.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

function createMusicDb() {
  const owner = {
    database: new DatabaseSync(':memory:'),
    beforeBatch: null,
    prepare(sql) { return new Statement(this, sql); },
    async batch(statements) {
      this.beforeBatch?.();
      this.beforeBatch = null;
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.database.exec('COMMIT');
        return results;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  owner.database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, album TEXT, duration REAL,
      audio_url TEXT, cover_url TEXT, has_lyrics INTEGER DEFAULT 1,
      needs_translation INTEGER DEFAULT 0, language TEXT DEFAULT 'other', created_at INTEGER
    );
    CREATE TABLE Playlists (
      id TEXT PRIMARY KEY, name TEXT, order_index INTEGER, created_at INTEGER
    );
  `);
  owner.database.exec(readFileSync(new URL('../../db/migrations/0016_member_playlists.sql', import.meta.url), 'utf8'));
  owner.database.exec(`
    INSERT INTO Songs(id,title,cover_url) VALUES
      ('song-1','One','/one.jpg'),('song-2','Two','/two.jpg'),('song-3','Three',NULL),('song-extra','Extra',NULL);
    INSERT INTO Playlists(id,name,order_index,created_at) VALUES
      ('liked','Featured',0,0),('system-a','System A',1,1),('system-b','System B',2,2);
  `);
  return owner;
}

const rejectsCode = async (promise, code) => assert.rejects(promise, (error) => (
  error instanceof AccountPlaylistError && error.code === code
));

test('list initializes one empty favorite per owner without importing old data', async () => {
  const db = createMusicDb();
  const first = await listPlaylists(db, 'owner-a');
  const second = await listPlaylists(db, 'owner-a');
  const other = await listPlaylists(db, 'owner-b');

  assert.equal(first.playlists.length, 1);
  assert.equal(first.playlists[0].kind, 'favorite');
  assert.equal(first.playlists[0].songCount, 0);
  assert.equal(second.playlists[0].id, first.playlists[0].id);
  assert.notEqual(other.playlists[0].id, first.playlists[0].id);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE kind='favorite'").get().count, 2);
  assert.throws(() => db.database.prepare(`INSERT INTO Member_Playlists
    (id,user_sub,kind,name,description,revision,created_at,updated_at)
    VALUES ('duplicate-favorite','owner-a','favorite','Duplicate','',0,1,1)`).run());
});

test('migration and schema keep the Phase 51 tables, constraints, and indexes aligned', () => {
  const migration = readFileSync(new URL('../../db/migrations/0016_member_playlists.sql', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  for (const signature of [
    'CREATE TABLE IF NOT EXISTS Member_Playlists',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_member_playlists_owner_favorite',
    "ON Member_Playlists(user_sub) WHERE kind = 'favorite'",
    'CREATE TABLE IF NOT EXISTS Member_Playlist_Songs',
    'FOREIGN KEY (playlist_id) REFERENCES Member_Playlists(id) ON DELETE CASCADE',
    'FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE',
    'CREATE INDEX IF NOT EXISTS idx_member_playlist_songs_order',
    'CREATE TABLE IF NOT EXISTS Member_Playlist_Shelf',
  ]) {
    assert.ok(migration.includes(signature), `migration missing ${signature}`);
    assert.ok(schema.includes(signature), `schema missing ${signature}`);
  }
});

test('regular playlist CRUD enforces owner, revision, favorite deletion, and the 50 playlist quota', async () => {
  const db = createMusicDb();
  const created = await createPlaylist(db, 'owner-a', { name: '  Road trip  ', description: ' Notes ' }, 10);
  assert.equal(created.playlist.name, 'Road trip');
  assert.equal(created.playlist.revision, 0);
  assert.equal(created.shelf.items.at(-1).id, created.playlist.id);

  const updated = await updatePlaylist(db, 'owner-a', created.playlist.id, { name: 'Road trip 2', expectedRevision: 0 }, 11);
  assert.equal(updated.outcome, 'applied');
  assert.equal(updated.playlist.revision, 1);
  assert.equal((await updatePlaylist(db, 'owner-a', created.playlist.id, { name: 'Road trip 2', expectedRevision: 1 })).outcome, 'noop');
  await rejectsCode(updatePlaylist(db, 'owner-a', created.playlist.id, { description: 'stale', expectedRevision: 0 }), 'REVISION_CONFLICT');
  await rejectsCode(getPlaylist(db, 'owner-b', created.playlist.id), 'PLAYLIST_NOT_FOUND');

  const favorite = (await listPlaylists(db, 'owner-a')).playlists[0];
  await rejectsCode(deletePlaylist(db, 'owner-a', favorite.id, favorite.revision), 'FAVORITE_DELETE_FORBIDDEN');

  db.database.exec(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 49)
    INSERT INTO Member_Playlists(id,user_sub,kind,name,description,revision,created_at,updated_at)
    SELECT 'quota-' || value,'quota-owner','regular','List ' || value,'',0,value,value FROM n;`);
  await createPlaylist(db, 'quota-owner', { name: 'List 50' });
  await rejectsCode(createPlaylist(db, 'quota-owner', { name: 'List 51' }), 'PLAYLIST_LIMIT_REACHED');

  const deleted = await deletePlaylist(db, 'owner-a', created.playlist.id, 1, 12);
  assert.equal(deleted.deletedPlaylistId, created.playlist.id);
  assert.equal(deleted.shelf.items.some((item) => item.id === created.playlist.id), false);
});

test('regular playlist create reuses a stable owner-scoped idempotency key', async () => {
  const db = createMusicDb();
  const options = { idempotencyKey: 'call-create-1' };
  const first = await createPlaylist(db, 'owner-a', { name: 'Night drive' }, 10, options);
  const replay = await createPlaylist(db, 'owner-a', { name: 'Ignored replay name' }, 11, options);
  const otherOwner = await createPlaylist(db, 'owner-b', { name: 'Night drive' }, 12, options);

  assert.equal(first.outcome, 'applied');
  assert.equal(replay.outcome, 'noop');
  assert.equal(replay.playlist.id, first.playlist.id);
  assert.equal(replay.playlist.name, 'Night drive');
  assert.notEqual(otherOwner.playlist.id, first.playlist.id);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE user_sub='owner-a' AND kind='regular'").get().count, 1);
});

test('song mutations support multi-target add, noop, replace, reorder, remove, clear, and per-target failures', async () => {
  const db = createMusicDb();
  const a = (await createPlaylist(db, 'owner-a', { name: 'A' })).playlist;
  const b = (await createPlaylist(db, 'owner-a', { name: 'B' })).playlist;
  const foreign = (await createPlaylist(db, 'owner-b', { name: 'Foreign' })).playlist;

  const added = await addSongsToPlaylists(db, 'owner-a', {
    targets: [
      { playlistId: a.id, expectedRevision: 0 },
      { playlistId: b.id, expectedRevision: 0 },
      { playlistId: foreign.id, expectedRevision: 0 },
    ],
    songIds: ['song-1', 'song-2'],
  }, 20);
  assert.equal(added.outcome, 'partial');
  assert.deepEqual(added.affectedPlaylistIds, [a.id, b.id]);
  assert.equal(added.results[2].error, 'PLAYLIST_NOT_FOUND');
  await rejectsCode(replacePlaylistSongs(db, 'owner-a', foreign.id, ['song-1'], 0), 'PLAYLIST_NOT_FOUND');
  await rejectsCode(removePlaylistSong(db, 'owner-a', foreign.id, 'song-1', 0), 'PLAYLIST_NOT_FOUND');

  const duplicate = await addSongsToPlaylists(db, 'owner-a', {
    targets: [{ playlistId: a.id, expectedRevision: 1 }],
    songIds: ['song-1', 'song-2'],
  });
  assert.equal(duplicate.outcome, 'noop');
  assert.equal(duplicate.results[0].revision, 1);

  const reordered = await replacePlaylistSongs(db, 'owner-a', a.id, ['song-2', 'song-1'], 1, 21);
  assert.deepEqual(reordered.playlist.songs.map((song) => song.id), ['song-2', 'song-1']);
  assert.deepEqual(reordered.playlist.songs.map((song) => song.sortOrder), [0, 1]);

  const removed = await removePlaylistSong(db, 'owner-a', a.id, 'song-2', 2, 22);
  assert.deepEqual(removed.playlist.songs.map((song) => [song.id, song.sortOrder]), [['song-1', 0]]);
  assert.equal((await removePlaylistSong(db, 'owner-a', a.id, 'song-3', 3)).outcome, 'noop');

  const cleared = await replacePlaylistSongs(db, 'owner-a', a.id, [], 3, 23);
  assert.equal(cleared.playlist.songs.length, 0);
  assert.equal(cleared.playlist.revision, 4);
  await rejectsCode(replacePlaylistSongs(db, 'owner-a', a.id, ['missing'], 4), 'SONG_NOT_FOUND');
});

test('song quota and guarded batches prevent overfill and stale partial writes', async () => {
  const db = createMusicDb();
  const playlist = (await createPlaylist(db, 'owner-a', { name: 'Full' })).playlist;
  db.database.exec(`
    WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 499)
      INSERT INTO Songs(id,title) SELECT 'bulk-' || value, 'Bulk ' || value FROM n;
    WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 499)
      INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at)
      SELECT '${playlist.id}', 'bulk-' || value, value, 1 FROM n;
  `);
  const overfill = await addSongsToPlaylists(db, 'owner-a', {
    targets: [{ playlistId: playlist.id, expectedRevision: 0 }],
    songIds: ['song-extra'],
  });
  assert.equal(overfill.outcome, 'failed');
  assert.equal(overfill.results[0].error, 'PLAYLIST_SONG_LIMIT_REACHED');

  const capacity = (await createPlaylist(db, 'owner-a', { name: 'Capacity' })).playlist;
  const bulkIds = Array.from({ length: 500 }, (_, index) => `bulk-${index}`);
  const filled = await replacePlaylistSongs(db, 'owner-a', capacity.id, bulkIds, 0);
  assert.equal(filled.playlist.songCount, 500);
  await rejectsCode(
    replacePlaylistSongs(db, 'owner-a', capacity.id, [...bulkIds, 'song-extra'], 1),
    'PLAYLIST_SONG_LIMIT_REACHED',
  );

  const race = (await createPlaylist(db, 'owner-a', { name: 'Race' })).playlist;
  await replacePlaylistSongs(db, 'owner-a', race.id, ['song-1'], 0);
  db.beforeBatch = () => db.database.prepare('UPDATE Member_Playlists SET revision = 2 WHERE id = ?').run(race.id);
  await rejectsCode(replacePlaylistSongs(db, 'owner-a', race.id, ['song-2'], 1), 'REVISION_CONFLICT');
  assert.deepEqual((await getPlaylist(db, 'owner-a', race.id)).songs.map((song) => song.id), ['song-1']);
});

test('shelf normalization discards legacy shared refs, keeps personal order and CAS', async () => {
  const db = createMusicDb();
  const member = (await createPlaylist(db, 'owner-a', { name: 'Member' }, 30)).playlist;
  const favorite = (await listPlaylists(db, 'owner-a')).playlists[0];
  db.database.prepare(`UPDATE Member_Playlist_Shelf SET items_json = ?, revision = 4 WHERE user_sub = ?`).run(JSON.stringify([
    { kind: 'member', id: member.id, hidden: true },
    { kind: 'system', id: 'system-a', hidden: true },
    { kind: 'system', id: 'ghost', hidden: true },
  ]), 'owner-a');

  const normalized = await getPlaylistShelf(db, 'owner-a', 31);
  assert.equal(normalized.revision, 5);
  assert.deepEqual(normalized.items, [
    { kind: 'member', id: favorite.id },
    { kind: 'member', id: member.id },
  ]);
  assert.equal(normalized.items.some((item) => item.kind === 'system'), false);

  const sortedItems = [normalized.items[1], normalized.items[0]];
  const sorted = await updatePlaylistShelf(db, 'owner-a', { items: sortedItems, expectedRevision: 5 }, 32);
  assert.equal(sorted.shelf.revision, 6);
  assert.equal(sorted.shelf.items[0].id, member.id);
  assert.equal(sorted.shelf.items.at(-1).id, favorite.id);

  await rejectsCode(updatePlaylistShelf(db, 'owner-a', { items: sortedItems, expectedRevision: 5 }), 'REVISION_CONFLICT');
  await rejectsCode(updatePlaylistShelf(db, 'owner-a', {
    items: sortedItems.map((item) => item.id === member.id ? { ...item, hidden: true } : item), expectedRevision: 6,
  }), 'INVALID_BODY');
});

test('previewCovers in playlist summary orders by newest added song (added_at DESC, sort_order DESC)', async () => {
  const db = createMusicDb();
  db.database.exec(`
    INSERT INTO Songs (id, title, cover_url) VALUES
      ('s1', '老歌', 'cover/old.jpg'),
      ('s2', '中生代歌', 'cover/mid.jpg'),
      ('s3', '最新歌', 'cover/newest.jpg');
  `);

  const { playlist } = await createPlaylist(db, 'owner-cover', { name: '封面测试歌单' }, 100);
  
  // 依次添加歌曲：s1 (t=101), s2 (t=102), s3 (t=103)
  await addSongsToPlaylists(db, 'owner-cover', {
    targets: [{ playlistId: playlist.id, expectedRevision: 0 }],
    songIds: ['s1'],
  }, 101);

  await addSongsToPlaylists(db, 'owner-cover', {
    targets: [{ playlistId: playlist.id, expectedRevision: 1 }],
    songIds: ['s2'],
  }, 102);

  await addSongsToPlaylists(db, 'owner-cover', {
    targets: [{ playlistId: playlist.id, expectedRevision: 2 }],
    songIds: ['s3'],
  }, 103);

  const lists = await listPlaylists(db, 'owner-cover');
  const target = lists.playlists.find((p) => p.id === playlist.id);

  assert.ok(target);
  assert.equal(target.songCount, 3);
  // previewCovers 的第一首必须是最新添加的歌曲 (s3)，随后依次是 s2, s1
  assert.equal(target.previewCovers[0], 'cover/newest.jpg');
  assert.deepEqual(target.previewCovers, ['cover/newest.jpg', 'cover/mid.jpg', 'cover/old.jpg']);
});
