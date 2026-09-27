import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalMusicReadRoute } from './localMusicRead.js';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
}

function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  const db = { sqlite, prepare(sql) { return new Statement(sqlite, sql); } };
  return db;
}

function seed(db) {
  db.sqlite.exec(`
    INSERT INTO accounts (account_id, username, role, created_at, updated_at) VALUES
      ('owner-a', 'owner-a', 'admin', 1, 1),
      ('owner-b', 'owner-b', 'member', 1, 1);
    INSERT INTO Songs (id, title, artist, audio_url, language, created_at) VALUES
      ('track-a', 'Alpha', 'Artist', '/media/a', 'en', 1),
      ('track-b', 'Beta', 'Artist', '/media/b', 'ja', 2),
      ('track-no-audio', 'Silent', 'Artist', NULL, 'en', 3);
    INSERT INTO Playlists (id, name, author, preview_covers, order_index) VALUES
      ('global', 'Shared', 'Tune', '["/media/cover"]', 1);
    INSERT INTO Playlist_Songs (playlist_id, song_id, sort_order) VALUES
      ('global', 'track-b', 0), ('global', 'track-a', 1);
    INSERT INTO Member_Playlists (id, account_id, kind, name, description, created_at, updated_at) VALUES
      ('fav-a', 'owner-a', 'favorite', 'A likes', '', 1, 1),
      ('private-a', 'owner-a', 'regular', 'A private', '', 2, 2),
      ('fav-b', 'owner-b', 'favorite', 'B likes', '', 1, 1),
      ('private-b', 'owner-b', 'regular', 'B private', '', 2, 2);
    INSERT INTO Member_Playlist_Songs (playlist_id, song_id, sort_order, added_at) VALUES
      ('fav-a', 'track-a', 0, 1), ('private-a', 'track-a', 0, 1),
      ('fav-b', 'track-b', 0, 1), ('private-b', 'track-b', 0, 1);
  `);
}

async function call(db, path, accountId = 'owner-a', method = 'GET') {
  const request = new Request(`https://tune.example${path}`, { method });
  return handleLocalMusicReadRoute(request, new URL(request.url), db, { 'X-Test': 'read' }, accountId);
}

test('empty local catalog returns stable private init shape', async () => {
  const db = createDb();
  const response = await call(db, '/api/init');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Test'), 'read');
  assert.deepEqual((await response.json()).data, {
    default_playlist: { id: 'favorite', name: '我的收藏', type: 'favorite', songs: [] },
    other_playlists: [],
  });
});

test('init and playlist detail expose only account-owned rows even when legacy system rows exist', async () => {
  const db = createDb();
  seed(db);
  const a = (await (await call(db, '/api/init', 'owner-a')).json()).data;
  const b = (await (await call(db, '/api/init', 'owner-b')).json()).data;
  assert.deepEqual(a.default_playlist.songs.map((song) => song.id), ['track-a']);
  assert.deepEqual(b.default_playlist.songs.map((song) => song.id), ['track-b']);
  assert.deepEqual(a.other_playlists.map((p) => p.id), ['private-a']);
  assert.deepEqual(b.other_playlists.map((p) => p.id), ['private-b']);
  const own = await call(db, '/api/playlists/private-a', 'owner-a');
  assert.deepEqual((await own.json()).data.songs.map((song) => song.id), ['track-a']);
  assert.equal((await call(db, '/api/playlists/private-b', 'owner-a')).status, 404);
  assert.equal((await call(db, '/api/playlists/fav-b', 'owner-a')).status, 404);
  assert.equal((await call(db, '/api/playlists/global', 'owner-b')).status, 404);
});

test('favorite alias resolves only current account and works without a favorite row', async () => {
  const db = createDb();
  seed(db);
  assert.deepEqual((await (await call(db, '/api/playlists/favorite', 'owner-b')).json()).data.songs.map((s) => s.id), ['track-b']);
  assert.deepEqual((await (await call(db, '/api/playlists/favorite', 'new-account')).json()).data.songs, []);
});

test('song search, detail, language list and counts use baseline columns and playable filtering', async () => {
  const db = createDb();
  seed(db);
  const search = await call(db, '/api/songs/search?q=Alpha&limit=20&offset=0&language=en');
  assert.deepEqual((await search.json()).data.songs.map((song) => song.id), ['track-a']);
  const noAudio = await call(db, '/api/songs/search?q=Silent');
  assert.deepEqual((await noAudio.json()).data.songs, []);
  const detail = await call(db, '/api/songs/track-a');
  assert.equal((await detail.json()).data.audio_url, '/media/a');
  assert.equal((await call(db, '/api/songs/missing')).status, 404);
  const counts = await call(db, '/api/songs?counts=language');
  assert.deepEqual((await counts.json()).data, { en: 1, ja: 1 });
  const language = await call(db, '/api/songs?language=ja&page=1&limit=20');
  assert.deepEqual((await language.json()).data.songs.map((song) => song.id), ['track-b']);
});

test('route rejects missing account and malformed IDs or query parameters without reading private data', async () => {
  const db = createDb();
  seed(db);
  assert.equal((await call(db, '/api/init', null)).status, 401);
  assert.equal((await call(db, '/api/playlists/private-a', null)).status, 401);
  assert.equal((await call(db, '/api/playlists/%ZZ')).status, 400);
  assert.equal((await call(db, '/api/songs/%00')).status, 400);
  assert.equal((await call(db, '/api/songs/search?q=x&limit=abc')).status, 400);
  assert.equal((await call(db, '/api/songs/search?q=x&language=invalid')).status, 400);
  assert.equal((await call(db, '/api/songs?language=invalid')).status, 400);
  assert.equal((await call(db, '/api/songs?language=en&page=0')).status, 400);
  assert.equal(await call(db, '/api/unknown'), null);
  assert.equal(await call(db, '/api/songs/random'), null);
  assert.equal(await call(db, '/api/init', 'owner-a', 'POST'), null);
});
