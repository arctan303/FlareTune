import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalCatalogAdminRoute } from './localCatalogAdmin.js';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { return { meta: { changes: this.db.prepare(this.sql).run(...this.params).changes } }; }
}
function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  const db = {
    sqlite,
    prepare(sql) { return new Statement(sqlite, sql); },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return db;
}
const admin = { mode: 'normal', account: { accountId: 'owner', role: 'admin' } };
const member = { mode: 'normal', account: { accountId: 'member', role: 'member' } };
async function call(db, path, { method = 'GET', body, session = admin } = {}) {
  const request = new Request(`https://tune.example${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const response = await handleLocalCatalogAdminRoute(request, new URL(request.url), db, { 'X-Test': 'catalog' }, session);
  return response && { status: response.status, headers: response.headers, body: await response.json() };
}
const songs = '/api/admin/catalog/songs';
const playlists = '/api/admin/catalog/playlists';

test('legacy system playlist admin endpoints are retired while song admin remains available', async () => {
  const db = createDb();
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const path = method === 'GET' || method === 'POST' ? playlists : `${playlists}/legacy`;
    const result = await call(db, path, { method, ...(method === 'GET' ? {} : { body: {} }) });
    assert.equal(result.status, 404);
  }
  assert.equal((await call(db, songs)).status, 200);
});

test('route is independent of legacy paths and denies member, anonymous and limited sessions', async () => {
  const db = createDb();
  assert.equal(await call(db, '/api/manage/songs'), null);
  assert.equal((await call(db, songs, { session: member })).status, 403);
  assert.equal((await call(db, songs, { session: null })).status, 403);
  assert.equal((await call(db, songs, { session: { ...admin, mode: 'must_change_password' } })).status, 403);
  assert.equal((await call(db, songs, { session: member, method: 'POST', body: { id: 'x' } })).status, 403);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM Songs').get().n, 0);
});

test('song CRUD validates bounded metadata, version preconditions, relationships and retained media', async () => {
  const db = createDb();
  const created = await call(db, songs, { method: 'POST', body: {
    id: 'track-1', title: 'First', artist: 'Artist', audio_url: '/media/track-1.mp3',
    cover_url: '/media/track-1.jpg', language: 'en', duration: 123,
  } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.song.id, 'track-1');
  assert.match(created.body.data.song.version, /^[a-f0-9]{64}$/);
  assert.equal(created.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(created.headers.get('X-Test'), 'catalog');
  assert.equal((await call(db, songs, { method: 'POST', body: { id: 'track-1', title: 'Duplicate', audio_url: '/media/x' } })).status, 409);
  assert.equal((await call(db, songs, { method: 'POST', body: { id: 'bad', title: 'Bad', audio_url: 'javascript:alert(1)' } })).status, 400);
  const list = await call(db, `${songs}?page=1&limit=10&q=First`);
  assert.equal(list.body.data.total, 1);
  assert.deepEqual(list.body.data.songs.map((item) => item.id), ['track-1']);
  assert.equal((await call(db, `${songs}?limit=9999`)).status, 400);
  const update = await call(db, `${songs}/track-1`, { method: 'PUT', body: {
    expectedVersion: created.body.data.song.version, title: 'Updated', cover_url: '/media/new.jpg',
  } });
  assert.equal(update.status, 200);
  assert.equal(update.body.data.song.artist, 'Artist');
  assert.notEqual(update.body.data.song.version, created.body.data.song.version);
  assert.equal((await call(db, `${songs}/track-1`, { method: 'PUT', body: {
    expectedVersion: created.body.data.song.version, title: 'Stale',
  } })).status, 409);
  assert.equal((await call(db, `${songs}/track-1`, { method: 'PUT', body: {
    expectedVersion: update.body.data.song.version, audio_url: 'data:bad',
  } })).status, 400);
  assert.equal((await call(db, `${songs}/track-1`, { method: 'DELETE', body: {
    expectedVersion: update.body.data.song.version,
  } })).status, 400);
  const deleted = await call(db, `${songs}/track-1`, { method: 'DELETE', body: {
    expectedVersion: update.body.data.song.version, confirmDelete: true,
  } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.data.mediaRetained, true);
  assert.equal((await call(db, `${songs}/track-1`)).status, 404);
});

test('catalog accepts current media object keys when editing song metadata', async () => {
  const db = createDb();
  const created = await call(db, songs, { method: 'POST', body: {
    id: 'key-song', title: 'Original', audio_url: 'audio/key-song.mp3', cover_url: 'cover/key-song.jpg',
  } });
  assert.equal(created.status, 201);
  const saved = await call(db, `${songs}/key-song`, { method: 'PUT', body: {
    expectedVersion: created.body.data.song.version, title: 'Renamed',
    audio_url: 'audio/key-song.mp3', cover_url: 'cover/key-song.jpg',
  } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.song.title, 'Renamed');
  assert.equal(saved.body.data.song.audio_url, 'audio/key-song.mp3');
  assert.equal(saved.body.data.song.cover_url, 'cover/key-song.jpg');
  for (const key of ['../secret.mp3', 'audio/../secret.mp3', 'audio/%2e%2e/secret.mp3',
    'audio//secret.mp3', 'audio/secret.mp3?x=1', '//outside/key', 'javascript:alert(1)']) {
    assert.equal((await call(db, songs, { method: 'POST', body: {
      id: `invalid-${key.length}-${key.charCodeAt(0)}`, title: 'Invalid', audio_url: key,
    } })).status, 400, key);
  }
});

test('compare-and-swap guard rejects a concurrent song edit without overwriting it', async () => {
  const db = createDb();
  const created = await call(db, songs, { method: 'POST', body: { id: 'race', title: 'Original', audio_url: '/media/race' } });
  const originalBatch = db.batch;
  db.batch = async (statements) => {
    db.sqlite.prepare('UPDATE Songs SET title = ? WHERE id = ?').run('Other admin', 'race');
    return originalBatch(statements);
  };
  const response = await call(db, `${songs}/race`, { method: 'PUT', body: {
    expectedVersion: created.body.data.song.version, title: 'My edit',
  } });
  assert.equal(response.status, 409);
  assert.equal(db.sqlite.prepare('SELECT title FROM Songs WHERE id = ?').get('race').title, 'Other admin');
});
