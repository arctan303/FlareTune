import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleAccountPlaylistsRoute } from './accountPlaylists.js';

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

function createDb() {
  const db = {
    database: new DatabaseSync(':memory:'),
    prepare(sql) { return new Statement(this, sql); },
    async batch(statements) {
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
  db.database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, album TEXT, duration REAL,
      audio_url TEXT, cover_url TEXT, has_lyrics INTEGER DEFAULT 1,
      needs_translation INTEGER DEFAULT 0, language TEXT DEFAULT 'other', created_at INTEGER
    );
    CREATE TABLE Playlists (id TEXT PRIMARY KEY, name TEXT, order_index INTEGER, created_at INTEGER);
  `);
  db.database.exec(readFileSync(new URL('../../db/migrations/0016_member_playlists.sql', import.meta.url), 'utf8'));
  db.database.exec(`
    INSERT INTO Songs(id,title) VALUES ('song-1','One'),('song-2','Two');
    INSERT INTO Playlists(id,name,order_index,created_at) VALUES ('system-a','System',1,1);
  `);
  return db;
}

const headers = { 'X-Test': 'route' };
const user = { subject: 'owner-a', role: 'member' };

const call = (db, path, { method = 'GET', body, viewer = user } = {}) => {
  const request = new Request(`https://example.test${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleAccountPlaylistsRoute(request, new URL(request.url), db, headers, viewer);
};

test('account playlist routes require a user and always return private no-store envelopes', async () => {
  const db = createDb();
  const response = await call(db, '/api/account/playlists', { viewer: null });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'AUTH_REQUIRED',
    message: '需要登录账号才能管理个人歌单。',
  });
});

test('playlist collection and detail routes use stable success envelopes and status codes', async () => {
  const db = createDb();
  const listResponse = await call(db, '/api/account/playlists');
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.ok, true);
  assert.equal(listed.data.playlists[0].kind, 'favorite');

  const createResponse = await call(db, '/api/account/playlists', {
    method: 'POST', body: { name: 'Mine', description: 'Notes' },
  });
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.headers.get('Cache-Control'), 'private, no-store');
  const created = (await createResponse.json()).data.playlist;

  const detailResponse = await call(db, `/api/account/playlists/${created.id}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).data.playlist.id, created.id);

  const updateResponse = await call(db, `/api/account/playlists/${created.id}`, {
    method: 'PUT', body: { name: 'Renamed', expectedRevision: 0 },
  });
  assert.equal((await updateResponse.json()).data.playlist.revision, 1);

  const conflictResponse = await call(db, `/api/account/playlists/${created.id}`, {
    method: 'PUT', body: { name: 'Stale', expectedRevision: 0 },
  });
  assert.equal(conflictResponse.status, 409);
  const conflict = await conflictResponse.json();
  assert.equal(conflict.error, 'REVISION_CONFLICT');
  assert.equal(conflict.data.playlist.revision, 1);

  const crossAccount = await call(db, `/api/account/playlists/${created.id}`, { viewer: { subject: 'owner-b' } });
  assert.equal(crossAccount.status, 404);
  assert.equal((await crossAccount.json()).error, 'PLAYLIST_NOT_FOUND');
});

test('song subresource routes are matched before playlist detail and preserve ordered DTOs', async () => {
  const db = createDb();
  const createdResponse = await call(db, '/api/account/playlists', { method: 'POST', body: { name: 'Songs' } });
  const playlist = (await createdResponse.json()).data.playlist;

  const addResponse = await call(db, '/api/account/playlist-songs', {
    method: 'POST',
    body: { targets: [{ playlistId: playlist.id, expectedRevision: 0 }], songIds: ['song-1', 'song-2'] },
  });
  assert.equal(addResponse.status, 200);
  assert.equal((await addResponse.json()).data.outcome, 'applied');

  const reorderResponse = await call(db, `/api/account/playlists/${playlist.id}/songs`, {
    method: 'PUT', body: { songIds: ['song-2', 'song-1'], expectedRevision: 1 },
  });
  assert.equal(reorderResponse.status, 200);
  assert.deepEqual((await reorderResponse.json()).data.playlist.songs.map((song) => song.id), ['song-2', 'song-1']);

  const removeResponse = await call(db, `/api/account/playlists/${playlist.id}/songs/song-2`, {
    method: 'DELETE', body: { expectedRevision: 2 },
  });
  assert.equal(removeResponse.status, 200);
  assert.deepEqual((await removeResponse.json()).data.playlist.songs.map((song) => song.id), ['song-1']);
});

test('shelf routes normalize, sort, retire visibility, and reject malformed bodies', async () => {
  const db = createDb();
  const created = await call(db, '/api/account/playlists', {
    method: 'POST', body: { name: '自己的歌单' },
  });
  const personal = (await created.json()).data.playlist;
  const shelfResponse = await call(db, '/api/account/playlist-shelf');
  const shelf = (await shelfResponse.json()).data.shelf;
  const favorite = (await (await call(db, '/api/account/playlists')).json()).data.playlists[0];
  assert.deepEqual(shelf.items, [{ kind: 'member', id: favorite.id }, { kind: 'member', id: personal.id }]);

  const visibilityResponse = await call(db, '/api/account/playlist-shelf/visibility', {
    method: 'PUT', body: { playlistId: 'system-a', hidden: true, expectedRevision: shelf.revision },
  });
  assert.equal(visibilityResponse.status, 404);

  const sortedResponse = await call(db, '/api/account/playlist-shelf', {
    method: 'PUT', body: { items: [...shelf.items].reverse(), expectedRevision: shelf.revision },
  });
  const sorted = (await sortedResponse.json()).data;
  assert.equal(sorted.outcome, 'applied');
  assert.equal(sorted.shelf.items.at(-1).id, favorite.id);

  const invalidResponse = await call(db, '/api/account/playlist-shelf', {
    method: 'PUT', body: { items: [], expectedRevision: sorted.shelf.revision },
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error, 'INVALID_BODY');

  const malformedRequest = new Request('https://example.test/api/account/playlists', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  const malformed = await handleAccountPlaylistsRoute(malformedRequest, new URL(malformedRequest.url), db, headers, user);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'INVALID_BODY');
});
