import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalAccountMusicRoute } from './localAccountMusic.js';

class Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.owner, this.sql, values); }
  async first() { return this.owner.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.owner.database.prepare(this.sql).all(...this.values) }; }
  async run() {
    if (this.owner.failSql?.test(this.sql)) throw new Error('injected write failure');
    if (/^DELETE FROM Member_Playlists\b/.test(this.sql)) this.owner.beforePlaylistDelete?.();
    const cascadeDeletes = this.owner.reportCascadeChanges && /^DELETE FROM Member_Playlists\b/.test(this.sql)
      ? this.owner.database.prepare('SELECT COUNT(*) AS count FROM Member_Playlist_Songs WHERE playlist_id = ?')
        .get(this.values[0]).count : 0;
    const result = this.owner.database.prepare(this.sql).run(...this.values);
    const triggeredSummary = this.owner.reportTriggerChanges && result.changes > 0
      && /^INSERT INTO Member_Play_Events\b/.test(this.sql) ? 1 : 0;
    return { meta: { changes: Number(result.changes) + (result.changes > 0 ? cascadeDeletes : 0)
      + triggeredSummary } };
  }
}

function createDb() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8'));
  database.exec(`
    INSERT INTO accounts(account_id, username, role, created_at, updated_at) VALUES
      ('account-a', 'account-a', 'admin', 1, 1),
      ('account-b', 'account-b', 'member', 1, 1);
    INSERT INTO Songs(id,title,cover_url) VALUES
      ('song-1','One','/cover-1'),('song-2','Two','/cover-2');
    INSERT INTO Playlists(id,name,order_index,created_at) VALUES
      ('system-a','System',1,1);
  `);
  return {
    database,
    failSql: null,
    beforeBatch: null,
    prepare(sql) { return new Statement(this, sql); },
    async batch(statements) {
      this.beforeBatch?.();
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
}

async function call(db, path, { method = 'GET', body, session = { accountId: 'account-a', mode: 'normal' }, headers = {} } = {}) {
  const request = new Request(`https://flaretune.test${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleLocalAccountMusicRoute(request, new URL(request.url), db, {}, session);
  return { response, body: response ? await response.json() : null };
}

test('account music route accepts only router-supplied normal account identity', async () => {
  const db = createDb();
  const anonymous = await call(db, '/api/account/playlists', { session: null, headers: { 'X-Arc-Account-Subject': 'account-a' } });
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(anonymous.body.error, 'AUTH_REQUIRED');
  assert.equal((await call(db, '/api/account/play-stats', { session: { accountId: 'account-a', mode: 'must_change_password' } })).response.status, 401);
  assert.equal((await call(db, '/api/account/playlists', { session: { accountId: 'account-a' } })).response.status, 401);
  assert.equal((await call(db, '/api/account/playlists', { session: { subject: 'account-a', mode: 'normal' } })).response.status, 401);
  assert.equal((await call(db, '/api/account/playlists', {
    session: { mode: 'normal', account: { accountId: 'account-a' } },
  })).response.status, 200);
  const switched = await call(db, '/api/account/playlists', {
    headers: { 'X-FlareTune-Expected-Account': 'account-b' },
  });
  assert.equal(switched.response.status, 409);
  assert.equal(switched.body.error, 'ACCOUNT_CONTEXT_CHANGED');
  assert.equal(await handleLocalAccountMusicRoute(
    new Request('https://flaretune.test/api/other'), new URL('https://flaretune.test/api/other'), db, {}, null,
  ), null);
});

test('favorite, playlist CRUD and song order stay isolated by account_id', async () => {
  const db = createDb();
  const a = { accountId: 'account-a', mode: 'normal' };
  const b = { account_id: 'account-b', mode: 'normal' };
  const listedA = await call(db, '/api/account/playlists');
  const listedB = await call(db, '/api/account/playlists', { session: b });
  assert.deepEqual(listedA.body.data.playlists.map((playlist) => playlist.kind), ['favorite']);
  assert.deepEqual(listedB.body.data.playlists.map((playlist) => playlist.kind), ['favorite']);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE kind='favorite'").get().count, 2);

  const created = await call(db, '/api/account/playlists', { method: 'POST', body: { name: 'Mine' } });
  assert.equal(created.response.status, 201);
  const id = created.body.data.playlist.id;
  const denied = await call(db, `/api/account/playlists/${id}`, {
    session: b, headers: { 'X-Arc-Account-Subject': 'account-a' },
  });
  assert.equal(denied.response.status, 404);
  assert.equal((await call(db, `/api/account/playlists/${id}`, {
    method: 'PUT', body: { name: 'Stolen', expectedRevision: 0 }, session: b,
  })).response.status, 404);
  assert.equal((await call(db, `/api/account/playlists/${id}`, {
    method: 'DELETE', body: { expectedRevision: 0 }, session: b,
  })).response.status, 404);

  const added = await call(db, '/api/account/playlist-songs', {
    method: 'POST', body: { targets: [{ playlistId: id, expectedRevision: 0 }], songIds: ['song-1', 'song-2'] }, session: a,
  });
  assert.equal(added.body.data.outcome, 'applied');
  const reordered = await call(db, `/api/account/playlists/${id}/songs`, {
    method: 'PUT', body: { songIds: ['song-2', 'song-1'], expectedRevision: 1 },
  });
  assert.deepEqual(reordered.body.data.playlist.songs.map((song) => song.id), ['song-2', 'song-1']);
  const removed = await call(db, `/api/account/playlists/${id}/songs/song-2`, {
    method: 'DELETE', body: { expectedRevision: 2 },
  });
  assert.deepEqual(removed.body.data.playlist.songs.map((song) => song.id), ['song-1']);
  const stale = await call(db, `/api/account/playlists/${id}`, {
    method: 'PUT', body: { name: 'Stale', expectedRevision: 0 },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.data.playlist.revision, 3);
  const favoriteId = listedA.body.data.playlists[0].id;
  const favoriteDeletion = await call(db, `/api/account/playlists/${favoriteId}`, {
    method: 'DELETE', body: { expectedRevision: 0 },
  });
  assert.equal(favoriteDeletion.body.error, 'FAVORITE_DELETE_FORBIDDEN');
  assert.equal(db.database.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('collection has a fixed identity while star and assistant song operations remain available', async () => {
  const db = createDb();
  const listed = await call(db, '/api/account/playlists');
  const favorite = listed.body.data.playlists[0];
  assert.equal(favorite.name, '我的收藏');
  db.database.prepare('UPDATE Member_Playlists SET name = ?, description = ? WHERE id = ?')
    .run('旧名称', '旧简介', favorite.id);
  const detail = await call(db, `/api/account/playlists/${favorite.id}`);
  assert.equal(detail.body.data.playlist.name, '我的收藏');
  assert.equal(detail.body.data.playlist.description, '');
  const update = await call(db, `/api/account/playlists/${favorite.id}`, {
    method: 'PUT', body: { name: '其他名称', expectedRevision: 0 },
  });
  assert.equal(update.response.status, 409);
  assert.equal(update.body.error, 'FAVORITE_METADATA_FORBIDDEN');
  const added = await call(db, '/api/account/playlist-songs', {
    method: 'POST', body: { targets: [{ playlistId: favorite.id, expectedRevision: 0 }], songIds: ['song-1', 'song-2'] },
  });
  assert.equal(added.body.data.outcome, 'applied');
  const reordered = await call(db, `/api/account/playlists/${favorite.id}/songs`, {
    method: 'PUT', body: { songIds: ['song-2', 'song-1'], expectedRevision: 1 },
  });
  assert.deepEqual(reordered.body.data.playlist.songs.map((song) => song.id), ['song-2', 'song-1']);
  const removed = await call(db, `/api/account/playlists/${favorite.id}/songs/song-2`, {
    method: 'DELETE', body: { expectedRevision: 2 },
  });
  assert.deepEqual(removed.body.data.playlist.songs.map((song) => song.id), ['song-1']);
  db.database.exec(readFileSync(new URL('../../db/migrations-flaretune/0005_collection_identity.sql', import.meta.url), 'utf8'));
  assert.deepEqual({ ...db.database.prepare('SELECT name, description FROM Member_Playlists WHERE id = ?').get(favorite.id) },
    { name: '我的收藏', description: '' });
});

test('deleting a populated playlist reports success when D1 counts cascaded song rows', async () => {
  const db = createDb();
  db.reportCascadeChanges = true;
  const created = (await call(db, '/api/account/playlists', {
    method: 'POST', body: { name: 'Temporary' },
  })).body.data.playlist;
  const added = await call(db, '/api/account/playlist-songs', {
    method: 'POST', body: { targets: [{ playlistId: created.id, expectedRevision: 0 }], songIds: ['song-1'] },
  });
  assert.equal(added.body.data.outcome, 'applied');
  const stale = await call(db, `/api/account/playlists/${created.id}`, {
    method: 'DELETE', body: { expectedRevision: 0 },
  });
  assert.equal(stale.response.status, 409);
  const deleted = await call(db, `/api/account/playlists/${created.id}`, {
    method: 'DELETE', body: { expectedRevision: 1 },
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.data.deletedPlaylistId, created.id);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Playlists WHERE id = ?').get(created.id).count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Playlist_Songs WHERE playlist_id = ?').get(created.id).count, 0);
});

test('a playlist revision changed after read still rejects delete when cascade counting is enabled', async () => {
  const db = createDb();
  db.reportCascadeChanges = true;
  const created = (await call(db, '/api/account/playlists', {
    method: 'POST', body: { name: 'Concurrent' },
  })).body.data.playlist;
  await call(db, '/api/account/playlist-songs', {
    method: 'POST', body: { targets: [{ playlistId: created.id, expectedRevision: 0 }], songIds: ['song-1'] },
  });
  db.beforePlaylistDelete = () => {
    db.database.prepare('UPDATE Member_Playlists SET revision = revision + 1 WHERE id = ?').run(created.id);
    db.beforePlaylistDelete = null;
  };
  const stale = await call(db, `/api/account/playlists/${created.id}`, {
    method: 'DELETE', body: { expectedRevision: 1 },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error, 'REVISION_CONFLICT');
  assert.equal(stale.body.data.playlist.revision, 2);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Playlists WHERE id = ?').get(created.id).count, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Playlist_Songs WHERE playlist_id = ?').get(created.id).count, 1);
});

test('shelf ordering is account-owned and revision checked while visibility is retired', async () => {
  const db = createDb();
  const mine = (await call(db, '/api/account/playlists', { method: 'POST', body: { name: 'Mine' } })).body.data.playlist;
  const aShelf = (await call(db, '/api/account/playlist-shelf')).body.data.shelf;
  const aFavorite = (await call(db, '/api/account/playlists')).body.data.playlists[0];
  assert.deepEqual(aShelf.items, [
    { kind: 'member', id: aFavorite.id },
    { kind: 'member', id: mine.id },
  ]);
  const hidden = await call(db, '/api/account/playlist-shelf/visibility', {
    method: 'PUT', body: { playlistId: mine.id, hidden: true, expectedRevision: aShelf.revision },
  });
  assert.equal(hidden.response.status, 404);
  const sorted = await call(db, '/api/account/playlist-shelf', {
    method: 'PUT', body: { items: [...aShelf.items].reverse(), expectedRevision: aShelf.revision },
  });
  assert.equal(sorted.body.data.shelf.revision, aShelf.revision + 1);
  assert.equal(sorted.body.data.shelf.items[0].id, mine.id);
  assert.equal(Object.hasOwn(sorted.body.data.shelf.items[0], 'hidden'), false);
  const bShelf = (await call(db, '/api/account/playlist-shelf', {
    session: { accountId: 'account-b', mode: 'normal' },
  })).body.data.shelf;
  assert.notEqual(bShelf.items[0].id, aFavorite.id);
  assert.deepEqual(bShelf.items.slice(1), []);
  const stale = await call(db, '/api/account/playlist-shelf', {
    method: 'PUT', body: { items: aShelf.items, expectedRevision: aShelf.revision },
  });
  assert.equal(stale.response.status, 409);
  const invalid = await call(db, '/api/account/playlist-shelf', {
    method: 'PUT', body: { items: [], expectedRevision: aShelf.revision + 1 },
  });
  assert.equal(invalid.body.error, 'INVALID_BODY');
});

test('legacy system shelf entries are discarded while personal playlists remain sortable', async () => {
  const db = createDb();
  const mine = (await call(db, '/api/account/playlists', { method: 'POST', body: { name: 'Mine' } })).body.data.playlist;
  const initial = (await call(db, '/api/account/playlist-shelf')).body.data.shelf;
  db.database.prepare('UPDATE Member_Playlist_Shelf SET items_json = ?, revision = 7 WHERE account_id = ?')
    .run(JSON.stringify([
      { kind: 'system', id: 'system-b', hidden: true },
      { kind: 'system', id: 'system-a', hidden: false },
      { kind: 'member', id: mine.id, hidden: true },
    ]), 'account-a');

  const shelf = (await call(db, '/api/account/playlist-shelf')).body.data.shelf;
  assert.equal(shelf.revision, 8);
  assert.deepEqual(shelf.items, initial.items);
  const persisted = JSON.parse(db.database.prepare('SELECT items_json FROM Member_Playlist_Shelf WHERE account_id = ?').get('account-a').items_json);
  assert.deepEqual(persisted, shelf.items);
  const rejected = await call(db, '/api/account/playlist-shelf', {
    method: 'PUT', body: { items: shelf.items.map((item) => ({ ...item, hidden: true })), expectedRevision: 8 },
  });
  assert.equal(rejected.body.error, 'INVALID_BODY');
});

test('failed playlist batch rolls back compare-and-swap and rows', async () => {
  const db = createDb();
  const created = (await call(db, '/api/account/playlists', {
    method: 'POST', body: { name: 'Rollback' },
  })).body.data.playlist;
  db.failSql = /^INSERT INTO Member_Playlist_Songs/;
  const failed = await call(db, `/api/account/playlists/${created.id}/songs`, {
    method: 'PUT', body: { songIds: ['song-1'], expectedRevision: 0 },
  });
  assert.equal(failed.response.status, 503);
  assert.equal(db.database.prepare('SELECT revision FROM Member_Playlists WHERE id = ?').get(created.id).revision, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Playlist_Songs WHERE playlist_id = ?').get(created.id).count, 0);
  db.failSql = null;
  const retry = await call(db, `/api/account/playlists/${created.id}/songs`, {
    method: 'PUT', body: { songIds: ['song-1'], expectedRevision: 0 },
  });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.data.playlist.revision, 1);
});

test('concurrent revision change makes a stale reorder inert', async () => {
  const db = createDb();
  const created = (await call(db, '/api/account/playlists', {
    method: 'POST', body: { name: 'Race' },
  })).body.data.playlist;
  db.beforeBatch = () => {
    db.database.prepare('UPDATE Member_Playlists SET revision = 1 WHERE id = ?').run(created.id);
    db.beforeBatch = null;
  };
  const stale = await call(db, `/api/account/playlists/${created.id}/songs`, {
    method: 'PUT', body: { songIds: ['song-1'], expectedRevision: 0 },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error, 'REVISION_CONFLICT');
  assert.equal(db.database.prepare('SELECT revision FROM Member_Playlists WHERE id = ?').get(created.id).revision, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Playlist_Songs WHERE playlist_id = ?').get(created.id).count, 0);
});

test('play event receipts and trigger-backed summaries are idempotent per account', async () => {
  const db = createDb();
  db.reportTriggerChanges = true;
  const event = { event_id: 'event-1', song_id: 'song-1', played_at: 123456 };
  const first = await call(db, '/api/account/play-stats', { method: 'POST', body: { events: [event, event] } });
  assert.equal(first.body.data.recorded, 1);
  assert.deepEqual(first.body.data.acceptedEventIds, ['event-1']);
  assert.equal((await call(db, '/api/account/play-stats', { method: 'POST', body: { events: [event] } })).body.data.recorded, 0);
  const other = await call(db, '/api/account/play-stats', {
    method: 'POST', body: { events: [event] }, session: { accountId: 'account-b', mode: 'normal' },
    headers: { 'X-Arc-Account-Subject': 'account-a' },
  });
  assert.equal(other.body.data.recorded, 1);
  const statsA = (await call(db, '/api/account/play-stats')).body.data;
  const statsB = (await call(db, '/api/account/play-stats', {
    session: { accountId: 'account-b', mode: 'normal' },
  })).body.data;
  assert.equal(statsA.totalPlays, 1);
  assert.equal(statsB.totalPlays, 1);
  assert.equal(statsA.totalUniqueSongs, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Play_Events').get().count, 2);
  const invalid = await call(db, '/api/account/play-stats', {
    method: 'POST', body: { events: [{ event_id: 'bad!', song_id: 'song-1', played_at: 1 }] },
  });
  assert.equal(invalid.response.status, 400);
});

test('frequent albums aggregate every song for the current account, beyond the top-song limit', async () => {
  const db = createDb();
  db.database.exec(`UPDATE Songs SET artist = 'Singer', album = 'Record', audio_url = '/media/song-1'
    WHERE id = 'song-1';
    UPDATE Songs SET artist = 'Singer', album = 'Record', audio_url = '/media/song-2'
    WHERE id = 'song-2';
    INSERT INTO Member_Song_Plays(account_id,song_id,play_count,last_played_at) VALUES
      ('account-a','song-1',3,100),('account-a','song-2',2,200),('account-b','song-2',9,300);`);
  const a = (await call(db, '/api/account/play-stats?limit=1')).body.data;
  const b = (await call(db, '/api/account/play-stats?limit=1', {
    session: { accountId: 'account-b', mode: 'normal' },
  })).body.data;
  assert.equal(a.songs.length, 1);
  assert.deepEqual(a.topAlbums.map((album) => [album.title, album.playCount, album.listenedTrackCount]),
    [['Record', 5, 2]]);
  assert.equal(a.topAlbums[0].lastPlayedAt, 200);
  assert.equal(b.topAlbums[0].playCount, 9);
  assert.equal(b.topAlbums[0].listenedTrackCount, 1);
  assert.equal(a.topAlbums[0].id, b.topAlbums[0].id);
});
