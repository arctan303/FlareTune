import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalCatalogAdminRoute } from './localCatalogAdmin.js';
import { managedMediaPath } from '../services/adminMusicMedia.js';
import { buildLyricArtifactMarker } from '../services/lyricArtifactStore.js';

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
async function call(db, path, { method = 'GET', body, session = admin, env = {} } = {}) {
  const request = new Request(`https://tune.example${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const response = await handleLocalCatalogAdminRoute(request, new URL(request.url), db, { 'X-Test': 'catalog' }, session, env);
  return response && { status: response.status, headers: response.headers, body: await response.json() };
}
const songs = '/api/admin/catalog/songs';
const playlists = '/api/admin/catalog/playlists';

test('media cleanup accepts only canonical managed media paths', () => {
  assert.equal(managedMediaPath('audio/aaaaaaaaaaaaaaaa.mp3', 'audio'), true);
  assert.equal(managedMediaPath('/media/cover/bbbbbbbbbbbbbbbb.jpg', 'cover'), true);
  assert.equal(managedMediaPath('audio/aaaaaaaaaaaaaaaaxmp3', 'audio'), false);
  assert.equal(managedMediaPath('/media/cover/bbbbbbbbbbbbbbbbxjpg', 'cover'), false);
});

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

test('impact preview removes referenced song and only its unshared managed media', async () => {
  const db = createDb();
  db.sqlite.exec(`
    INSERT INTO accounts(account_id, username, role, created_at, updated_at) VALUES
      ('owner', 'owner', 'admin', 1, 1), ('other', 'other', 'member', 1, 1);
    INSERT INTO Songs(id, title, audio_url, cover_url, created_at) VALUES
      ('remove-me', 'Remove', '/media/audio/1111111111111111.mp3', '/media/cover/2222222222222222.jpg', 1),
      ('keep-me', 'Keep', 'audio/1111111111111111.mp3', NULL, 1),
      ('keep-absolute', 'Keep absolute', 'https://music.example/media/audio/1111111111111111.mp3', NULL, 1);
    INSERT INTO Member_Playlists(id, account_id, kind, name, created_at, updated_at)
      VALUES ('list', 'other', 'regular', 'Other list', 1, 1);
    INSERT INTO Member_Playlist_Songs(playlist_id, song_id, sort_order, added_at)
      VALUES ('list', 'remove-me', 0, 1), ('list', 'keep-me', 1, 1);
    INSERT INTO Member_Play_Events(account_id, event_id, song_id, played_at, received_at)
      VALUES ('other', 'event', 'remove-me', 1, 1);
    INSERT INTO Lyric_Translations(song_id, source, raw_hash, status, prompt_version, created_at, updated_at)
      VALUES ('remove-me', 'kugou', 'hash', 'cached', 'v1', 1, 1);
  `);
  const objects = new Map([
    ['media/audio/1111111111111111.mp3', 'audio'],
    ['media/cover/2222222222222222.jpg', 'cover'],
  ]);
  let nextEtag = 1;
  const env = { MEDIA_BUCKET: {
    async get(key) { const item = objects.get(key); return item === undefined ? null : {
      size: new TextEncoder().encode(item).length, etag: `e${nextEtag}`, text: async () => item,
    }; },
    async put(key, value) { objects.set(key, String(value)); nextEtag += 1; return { etag: `e${nextEtag}` }; },
    async delete(key) { objects.delete(key); },
  } };
  const path = '/api/admin/catalog/delete-preview';
  assert.equal((await call(db, path, { method: 'POST', body: { ids: ['remove-me'] }, session: member, env })).status, 403);
  const preview = await call(db, path, { method: 'POST', body: { ids: ['remove-me'] }, env });
  assert.equal(preview.status, 200);
  const impact = preview.body.data;
  assert.equal(impact.affected_playlists.length, 1);
  assert.equal(impact.play_records[0].play_events, 1);
  assert.equal(impact.lyric_translations[0].count, 1);
  assert.equal(impact.media.find((item) => item.field === 'audio_url').can_delete, false);
  assert.deepEqual(impact.media.find((item) => item.field === 'audio_url').remaining_reference_ids,
    ['keep-absolute', 'keep-me']);
  assert.equal(impact.media.find((item) => item.field === 'cover_url').can_delete, true);
  const deleted = await call(db, '/api/admin/catalog/delete', { method: 'POST', body: {
    ids: ['remove-me'], delete_media: true, impact_digest: impact.impact_digest,
  }, env });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.data.deleted_ids, ['remove-me']);
  assert.deepEqual(deleted.body.data.media.deleted.map((item) => item.path), ['cover/2222222222222222.jpg']);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM Songs WHERE id='remove-me'").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlist_Songs WHERE song_id='remove-me'").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Play_Events WHERE song_id='remove-me'").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Song_Plays WHERE song_id='remove-me'").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM Lyric_Translations WHERE song_id='remove-me'").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT revision FROM Member_Playlists WHERE id='list'").get().revision, 1);
  assert.equal(db.sqlite.prepare("SELECT sort_order FROM Member_Playlist_Songs WHERE playlist_id='list' AND song_id='keep-me'").get().sort_order, 0);
  assert.equal(objects.has('media/audio/1111111111111111.mp3'), true);
  assert.equal(objects.has('media/cover/2222222222222222.jpg'), false);
});

test('delete keeps media by default and rejects a stale impact before deleting data', async () => {
  const db = createDb();
  db.sqlite.exec("INSERT INTO Songs(id, title, audio_url) VALUES ('target', 'Original', 'audio/3333333333333333.mp3')");
  const removedKeys = [];
  let artifact = null;
  const env = { MEDIA_BUCKET: {
    async get() { return artifact === null ? null : { size: artifact.length, etag: 'etag', text: async () => artifact }; },
    async put(_key, value) { artifact = String(value); return { etag: 'etag' }; },
    async delete(key) { removedKeys.push(key); artifact = null; },
  } };
  const previewPath = '/api/admin/catalog/delete-preview';
  const deletePath = '/api/admin/catalog/delete';
  const old = (await call(db, previewPath, { method: 'POST', body: { ids: ['target'] }, env })).body.data;
  db.sqlite.prepare("UPDATE Songs SET title='Changed' WHERE id='target'").run();
  const stale = await call(db, deletePath, { method: 'POST', body: {
    ids: ['target'], delete_media: true, impact_digest: old.impact_digest,
  }, env });
  assert.equal(stale.status, 409);
  assert.equal(db.sqlite.prepare("SELECT title FROM Songs WHERE id='target'").get().title, 'Changed');
  assert.deepEqual(removedKeys, []);
  const current = (await call(db, previewPath, { method: 'POST', body: { ids: ['target'] }, env })).body.data;
  const originalBatch = db.batch;
  db.batch = async (statements) => {
    db.sqlite.prepare("UPDATE Songs SET title='Concurrent edit' WHERE id='target'").run();
    db.batch = originalBatch;
    return originalBatch(statements);
  };
  const raced = await call(db, deletePath, { method: 'POST', body: {
    ids: ['target'], delete_media: true, impact_digest: current.impact_digest,
  }, env });
  assert.equal(raced.status, 409);
  assert.equal(db.sqlite.prepare("SELECT title FROM Songs WHERE id='target'").get().title, 'Concurrent edit');
  assert.deepEqual(removedKeys.filter((key) => key.endsWith('.mp3')), []);
  artifact = JSON.stringify(buildLyricArtifactMarker('target', 'deleting', {
    now: Date.now() - 6 * 60 * 1000, operationId: 'previous-failed-delete',
  }));
  const refreshed = (await call(db, previewPath, { method: 'POST', body: { ids: ['target'] }, env })).body.data;
  const deleted = await call(db, deletePath, { method: 'POST', body: {
    ids: ['target'], delete_media: false, impact_digest: refreshed.impact_digest,
  }, env });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.data.media.retained.map((item) => item.path), ['audio/3333333333333333.mp3']);
  assert.deepEqual(removedKeys.filter((key) => key.endsWith('.mp3')), []);
});

test('deleted song reports pending lyric object and permits a fresh cleanup retry', async () => {
  const db = createDb();
  db.sqlite.exec("INSERT INTO Songs(id, title) VALUES ('lyric-target', 'Lyric')");
  let stored = null;
  let failCleanup = true;
  const env = { MEDIA_BUCKET: {
    async get() { return stored === null ? null : { size: stored.length, etag: 'etag', text: async () => stored }; },
    async put(_key, value) { stored = String(value); return { etag: 'etag' }; },
    async delete(key) { if (key.endsWith('.json') && failCleanup) { failCleanup = false; throw new Error('R2 unavailable'); } stored = null; },
  } };
  const previewPath = '/api/admin/catalog/delete-preview';
  const deletePath = '/api/admin/catalog/delete';
  const preview = (await call(db, previewPath, { method: 'POST', body: { ids: ['lyric-target'] }, env })).body.data;
  const first = await call(db, deletePath, { method: 'POST', body: {
    ids: ['lyric-target'], delete_media: false, impact_digest: preview.impact_digest,
  }, env });
  assert.equal(first.status, 503);
  assert.deepEqual(first.body.data.deleted_ids, ['lyric-target']);
  assert.deepEqual(first.body.data.lyric_cleanup.pending_objects,
    [{ song_id: 'lyric-target', object_key: 'media/lyrics/lyric-target.json' }]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM Songs WHERE id='lyric-target'").get().n, 0);
  const retryPreview = (await call(db, previewPath, { method: 'POST', body: { ids: ['lyric-target'] }, env })).body.data;
  const retry = await call(db, deletePath, { method: 'POST', body: {
    ids: ['lyric-target'], delete_media: false, impact_digest: retryPreview.impact_digest,
  }, env });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.data.lyric_cleanup.recovered_song_ids, ['lyric-target']);
  assert.equal(stored, null);
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
