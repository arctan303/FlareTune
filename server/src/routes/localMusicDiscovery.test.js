import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalMusicDiscoveryRoute } from './localMusicDiscovery.js';

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
  return { sqlite, prepare(sql) { return new Statement(sqlite, sql); } };
}

function seed(db) {
  db.sqlite.exec(`
    INSERT INTO accounts (account_id, username, role, created_at, updated_at) VALUES
      ('owner-a', 'owner-a', 'admin', 1, 1), ('owner-b', 'owner-b', 'member', 1, 1);
    INSERT INTO Songs (id, title, artist, audio_url, cover_url, language) VALUES
      ('track-a', 'Alpha', 'Artist One', '/media/a', '/media/cover-a', 'en'),
      ('track-b', 'Beta', 'Artist One', '/media/b', '/media/cover-b', 'ja'),
      ('track-c', 'Gamma', 'Artist Two', '/media/c', '/media/cover-c', 'en'),
      ('track-no-audio', 'Silent', 'Artist Two', NULL, NULL, 'en'),
      ('track-unknown', 'Other', '未知歌手', '/media/u', NULL, 'en');
    INSERT INTO Artist_Photos (artist_name, photo_url, photos, created_at, updated_at)
      VALUES ('Artist One', '/media/artist', '[]', 1, 1);
    INSERT INTO Member_Playlists (id, account_id, kind, name, created_at, updated_at) VALUES
      ('private-b', 'owner-b', 'regular', 'B secret playlist', 1, 1);
  `);
}

async function call(db, path, { method = 'GET', body, accountId = 'owner-a', contentType = 'application/json' } = {}) {
  const request = new Request(`https://tune.example${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': contentType } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handleLocalMusicDiscoveryRoute(request, new URL(request.url), db, { 'X-Test': 'discovery' }, accountId);
}

test('empty new catalog returns stable discovery shapes', async () => {
  const db = createDb();
  const random = await call(db, '/api/songs/random');
  assert.equal(random.status, 200);
  assert.equal(random.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(random.headers.get('X-Test'), 'discovery');
  assert.deepEqual((await random.json()).data, { songs: [] });
  assert.deepEqual((await (await call(db, '/api/songs/resolve', { method: 'POST', body: { song_ids: ['absent'] } })).json()).data,
    { songs: [], missing_ids: ['absent'] });
  assert.deepEqual((await (await call(db, '/api/songs/roam', { method: 'POST', body: { seenSongIds: [] } })).json()).data,
    { songs: [], language: 'all', limit: 10, totalPlayable: 0, seenPlayable: 0, remainingPlayable: 0, exhausted: true });
  assert.equal((await (await call(db, '/api/songs/spotlight-artist')).json()).data, null);
});

test('random, resolve and roam return only playable baseline song fields', async () => {
  const db = createDb();
  seed(db);
  const random = (await (await call(db, '/api/songs/random?limit=4&exclude=track-a')).json()).data.songs;
  assert.equal(random.length, 4);
  assert.equal(random.at(-1).id, 'track-a');
  assert.ok(random.every((song) => song.audio_url && !('account_id' in song)));
  assert.doesNotMatch(JSON.stringify(random), /B secret playlist|private-b/u);
  const resolved = (await (await call(db, '/api/songs/resolve', {
    method: 'POST', body: { song_ids: ['track-b', 'track-a', 'track-b', 'track-no-audio', 'absent'] },
  })).json()).data;
  assert.deepEqual(resolved.songs.map((song) => song.id), ['track-b', 'track-a']);
  assert.deepEqual(resolved.missing_ids, ['track-no-audio', 'absent']);
  assert.deepEqual(Object.keys(resolved.songs[0]).sort(),
    ['id', 'title', 'artist', 'album', 'duration', 'audio_url', 'cover_url', 'language'].sort());
  const roam = (await (await call(db, '/api/songs/roam', {
    method: 'POST', body: { seenSongIds: ['track-a', 'track-no-audio'], limit: 1, language: 'en' },
  })).json()).data;
  assert.equal(roam.songs.length, 1);
  assert.ok(['track-c', 'track-unknown'].includes(roam.songs[0].id));
  assert.deepEqual({ totalPlayable: roam.totalPlayable, seenPlayable: roam.seenPlayable,
    remainingPlayable: roam.remainingPlayable, exhausted: roam.exhausted },
  { totalPlayable: 3, seenPlayable: 1, remainingPlayable: 1, exhausted: false });
});

test('roam exhaustion and spotlight exclusion/fallback use only playable songs', async () => {
  const db = createDb();
  seed(db);
  const roam = (await (await call(db, '/api/songs/roam', {
    method: 'POST', body: { seenSongIds: ['track-a', 'track-c'], limit: 5, language: 'en' },
  })).json()).data;
  assert.deepEqual(roam.songs.map((song) => song.id), ['track-unknown']);
  assert.equal(roam.exhausted, true);
  assert.equal(roam.remainingPlayable, 0);
  const featured = (await (await call(db, '/api/songs/spotlight-artist')).json()).data;
  assert.equal(featured.artist, 'Artist One');
  assert.deepEqual(featured.songs.map((song) => song.id), ['track-a', 'track-b']);
  assert.equal(featured.photoUrl, '/media/artist');
  assert.equal(featured.songCount, 2);
  const excluded = (await (await call(db, '/api/songs/spotlight-artist?exclude=Artist%20One')).json()).data;
  assert.equal(excluded.artist, 'Artist Two');
  assert.deepEqual(excluded.songs.map((song) => song.id), ['track-c']);
  const fallback = (await (await call(db, '/api/songs/spotlight-artist?exclude=Artist%20One%2CArtist%20Two')).json()).data;
  assert.ok(['Artist One', 'Artist Two'].includes(fallback.artist));
});

test('discovery route requires account and rejects invalid input before data reads', async () => {
  const db = createDb();
  seed(db);
  assert.equal((await call(db, '/api/songs/random', { accountId: null })).status, 401);
  assert.equal((await call(db, '/api/songs/resolve', { method: 'POST', body: { song_ids: ['track-a'] }, accountId: '' })).status, 401);
  assert.equal((await call(db, '/api/songs/random?limit=51')).status, 400);
  assert.equal((await call(db, '/api/songs/random?limit=2abc')).status, 400);
  assert.equal((await call(db, '/api/songs/random?exclude=%00')).status, 400);
  assert.equal((await call(db, '/api/songs/resolve', { method: 'POST', body: { song_ids: [] } })).status, 400);
  assert.equal((await call(db, '/api/songs/resolve', { method: 'POST', body: { song_ids: ['track-a', 2] } })).status, 400);
  assert.equal((await call(db, '/api/songs/resolve', { method: 'POST', body: 'not-json' })).status, 400);
  assert.equal((await call(db, '/api/songs/resolve', {
    method: 'POST', body: { song_ids: ['track-a'], padding: 'x'.repeat(65 * 1024) },
  })).status, 400);
  assert.equal((await call(db, '/api/songs/roam', { method: 'POST', body: { seenSongIds: 'track-a' } })).status, 400);
  assert.equal((await call(db, '/api/songs/roam', { method: 'POST', body: { seenSongIds: [], language: 'unknown' } })).status, 400);
  assert.equal((await call(db, '/api/songs/spotlight-artist?exclude=%00')).status, 400);
  assert.equal(await call(db, '/api/songs/random', { method: 'POST', body: {} }), null);
  assert.equal(await call(db, '/api/songs/search'), null);
});
