import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalAccountMusicRoute, accountMusic } from './localAccountMusic.js';
import { prepareExternalSongs, loadExternalSongs } from '../services/externalMusicReferences.js';
import { invalidateSchemaInventory } from '../instance/schemaInventory.js';
import { readAccountPlaylistSongs, readAccountTopSongs } from '../services/accountMusicReadModel.js';

const yt = n => 'yt:' + String(n).padStart(11, 'a');
const dto = id => ({ id, source: 'youtube', sourceId: id.slice(3), title: 'Trusted ' + id,
  artist: 'Artist', album: 'Album', duration: 120, language: 'en',
  artists: [{ id: 'yt:artist:UCartist', sourceId: 'UCartist', name: 'Artist' }], albumId: 'yt:album:MPREb_album',
  audio_url: 'https://private.googlevideo.com/signed?token=must-not-store', token: 'must-not-store',
  cover_url: '/media/youtube/image?url=' + encodeURIComponent('https://lh3.googleusercontent.com/art=w120-h120') + '&size=1200&key=must-not-store' });

function fixture({ external = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0001_baseline', '0002_expand_playlist_count', '0013_hotpath_indexes_and_counts', ...(external ? ['0014_external_music_references'] : [])]) {
    sqlite.exec(readFileSync(new URL(`../../db/migrations-flaretune/${name}.sql`, import.meta.url), 'utf8'));
  }
  sqlite.exec(`INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES ('a','alice','admin',1,1),('b','bob','member',1,1);
    INSERT INTO Songs(id,title,cover_url) VALUES ('local1','Local One','/cover/local1'),('local2','Local Two','/cover/local2');`);
  const db = {
    sqlite, queries: [], beforeBatch: null, fail: null,
    prepare(sql) {
      let args = [];
      return { bind(...values) { args = values; return this; },
        async first() { db.queries.push(sql); db.beforeRead?.(sql); return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { db.queries.push(sql); return { results: sqlite.prepare(sql).all(...args) }; },
        async run() {
          db.queries.push(sql);
          if (db.fail?.test(sql)) throw new Error('injected storage failure');
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } };
        } };
    },
    async batch(statements) {
      db.beforeBatch?.();
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  let calls = 0, assertions = 0;
  const deps = { externalReferences: true,
    async resolveExternalSongs(ids) { calls++; return ids.map(dto); },
    async assertExternalCurrent() { assertions++; } };
  async function call(path, { method = 'GET', body, account = 'a', dependencies = deps } = {}) {
    const request = new Request('https://example.test' + path, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
    const response = await handleLocalAccountMusicRoute(request, new URL(request.url), db, {}, { accountId: account, mode: 'normal' }, dependencies);
    return { status: response.status, ...(await response.json()) };
  }
  async function create(ids = [], account = 'a') {
    const result = await call('/api/account/playlists', { method: 'POST', body: { name: 'Mixed', songIds: ids }, account });
    assert.equal(result.status, 201, JSON.stringify(result)); return result.data.playlist;
  }
  return { db, sqlite, deps, call, create, calls: () => calls, assertions: () => assertions };
}

test('mixed playlists persist only own trusted metadata and keep global order, counts, previews and DTOs after reopening', async () => {
  const f = fixture();
  try {
    const p = await f.create(['local1', yt(1), 'local2', yt(2)]);
    assert.equal(p.songCount, 4);
    assert.equal(p.previewCovers.length, 4);
    const read = await f.call(`/api/account/playlists/${p.id}`);
    assert.deepEqual(read.data.playlist.songs.map(s => [s.id, s.sortOrder]), [['local1', 0], [yt(1), 1], ['local2', 2], [yt(2), 3]]);
    const external = read.data.playlist.songs[1];
    assert.equal(external.source, 'youtube'); assert.equal(external.sourceId, yt(1).slice(3));
    assert.equal(external.audio_url, '/media/youtube/audio/' + yt(1).slice(3));
    assert.equal(external.albumId, 'yt:album:MPREb_album'); assert.equal(external.artists[0].id, 'yt:artist:UCartist');
    assert.ok(external.cover_url.includes('size=1200')); assert.ok(!external.cover_url.includes('key='));
    const stored = f.sqlite.prepare('SELECT metadata_json FROM Member_External_Songs').all().map(r => r.metadata_json).join('');
    assert.ok(!stored.includes('must-not-store')); assert.ok(!stored.includes('googlevideo'));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM Songs WHERE id LIKE 'yt:%'").get().n, 0);
    const reorder = await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', body: { expectedRevision: 0, songIds: [yt(2), 'local2', yt(1), 'local1'], metadata: { title: 'Untrusted' } } });
    assert.equal(reorder.status, 200); assert.equal(reorder.data.playlist.songs[0].title, 'Trusted ' + yt(2));
    const removed = await f.call(`/api/account/playlists/${p.id}/songs/${encodeURIComponent('local2')}`, { method: 'DELETE', body: { expectedRevision: 1 } });
    assert.deepEqual(removed.data.playlist.songs.map(s => [s.id, s.sortOrder]), [[yt(2), 0], [yt(1), 1], ['local1', 2]]);
    assert.equal(removed.data.playlist.songCount, 3);
    const removedYt = await f.call(`/api/account/playlists/${p.id}/songs/${encodeURIComponent(yt(2))}`, { method: 'DELETE', body: { expectedRevision: 2 } });
    assert.deepEqual(removedYt.data.playlist.songs.map(s => [s.id, s.sortOrder]), [[yt(1), 0], ['local1', 1]]);
    assert.equal((await f.call(`/api/account/playlists/${p.id}`, { account: 'b' })).status, 404);
    assert.equal((await f.call('/api/account/playlists', { account: 'b' })).data.playlists.length, 1);
    assert.deepEqual(await loadExternalSongs(f.db, 'b', [yt(1)]), []);
    assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { f.sqlite.close(); }
});

test('favorites and bulk add use mixed membership, preserve noops, and enforce combined 500-track capacity', async () => {
  const f = fixture();
  try {
    const favorite = (await f.call('/api/account/playlists')).data.playlists[0];
    const added = await f.call('/api/account/playlist-songs', { method: 'POST', body: { songIds: ['local1', yt(1)], targets: [{ playlistId: favorite.id, expectedRevision: 0 }] } });
    assert.equal(added.data.outcome, 'applied'); assert.deepEqual(added.data.results[0].addedSongIds, ['local1', yt(1)]);
    const duplicate = await f.call('/api/account/playlist-songs', { method: 'POST', body: { songIds: [yt(1)], targets: [{ playlistId: favorite.id, expectedRevision: 1 }] } });
    assert.equal(duplicate.data.outcome, 'noop'); assert.equal(f.calls(), 1);
    const read = await accountMusic.getFavorite(f.db, 'a', Date.now(), { externalReferences: true });
    assert.deepEqual(read.songs.map(s => s.id), ['local1', yt(1)]);
    // Legacy/internal callers explicitly opt into references; default results stay local.
    assert.deepEqual((await accountMusic.getFavorite(f.db, 'a', Date.now())).songs.map(s => s.id), ['local1']);
    f.db.queries.length = 0;
    const full = await f.create(['local1', ...Array.from({ length: 499 }, (_, n) => yt(n + 10))]);
    assert.equal(full.songCount, 500); assert.ok(f.db.queries.length <= 50, `500-reference create ran ${f.db.queries.length} queries`);
    const overflow = await f.call('/api/account/playlist-songs', { method: 'POST', body: { songIds: ['local2'], targets: [{ playlistId: full.id, expectedRevision: 0 }] } });
    assert.equal(overflow.data.results[0].error, 'PLAYLIST_SONG_LIMIT_REACHED');
    const excessive = await f.call(`/api/account/playlists/${full.id}/songs`, { method: 'PUT', body: { expectedRevision: 0, songIds: ['local1', 'local2', ...Array.from({ length: 499 }, (_, n) => yt(n + 10))] } });
    assert.equal(excessive.status, 409);
  } finally { f.sqlite.close(); }
});

test('disconnect permits stored references to be read, reordered, removed and counted; missing references need trusted resolution', async () => {
  const f = fixture();
  try {
    const p = await f.create([yt(1), 'local1']);
    const offline = { externalReferences: true, async resolveExternalSongs() { throw new Error('offline'); }, async assertExternalCurrent() { throw new Error('offline'); } };
    assert.equal((await f.call(`/api/account/playlists/${p.id}`, { dependencies: offline })).data.playlist.songCount, 2);
    const reordered = await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', dependencies: offline, body: { expectedRevision: 0, songIds: ['local1', yt(1)] } });
    assert.equal(reordered.status, 200);
    const invalid = await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', dependencies: offline, body: { expectedRevision: 1, songIds: [yt(2)] } });
    assert.equal(invalid.status, 409); assert.equal(invalid.error, 'EXTERNAL_SOURCE_UNAVAILABLE');
    const stats = await f.call('/api/account/play-stats', { method: 'POST', dependencies: offline, body: { events: [{ event_id: 'offline-known', song_id: yt(1), played_at: 100 }] } });
    assert.equal(stats.data.recorded, 1);
    const removed = await f.call(`/api/account/playlists/${p.id}/songs/${encodeURIComponent(yt(1))}`, { method: 'DELETE', dependencies: offline, body: { expectedRevision: 1 } });
    assert.equal(removed.data.playlist.songCount, 1);
    assert.equal(f.calls(), 1);
  } finally { f.sqlite.close(); }
});

test('new references and mixed membership rollback together on stale revision, stale binding and storage failure', async () => {
  const f = fixture();
  try {
    const p = await f.create(['local1']);
    const body = { expectedRevision: 0, songIds: [yt(1)] };
    f.db.beforeBatch = () => { f.db.beforeBatch = null; f.sqlite.prepare('UPDATE Member_Playlists SET revision=1 WHERE id=?').run(p.id); };
    assert.equal((await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', body })).status, 409);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Songs').get().n, 0);
    f.db.fail = /INSERT INTO Member_External_Playlist_Songs/;
    assert.equal((await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', body: { ...body, expectedRevision: 1 } })).status, 503);
    assert.equal(f.sqlite.prepare('SELECT revision FROM Member_Playlists WHERE id=?').get(p.id).revision, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Songs').get().n, 0);
    f.db.fail = null;
    let checks = 0;
    const stale = { ...f.deps, async assertExternalCurrent() { if (++checks > 1) throw new Error('binding changed'); } };
    assert.equal((await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', dependencies: stale, body: { ...body, expectedRevision: 1 } })).status, 409);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Songs').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT song_id FROM Member_Playlist_Songs WHERE playlist_id=?').get(p.id).song_id, 'local1');
  } finally { f.sqlite.close(); }
});

test('composite ownership foreign keys reject cross-account external membership and account deletion cascades only its own refs', async () => {
  const f = fixture();
  try {
    const a = await f.create([yt(1)]), b = await f.create([], 'b');
    assert.throws(() => f.sqlite.prepare('INSERT INTO Member_External_Playlist_Songs VALUES (?,?,?,?,?)').run(b.id, 'a', yt(1), 0, 1), /FOREIGN KEY/);
    assert.throws(() => f.sqlite.prepare('INSERT INTO Member_External_Playlist_Songs VALUES (?,?,?,?,?)').run(b.id, 'b', yt(1), 0, 1), /FOREIGN KEY/);
    await f.create([yt(2)], 'b');
    f.sqlite.exec("DELETE FROM accounts WHERE account_id='a'");
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Songs WHERE account_id=?').get('a').n, 0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Songs WHERE account_id=?').get('b').n, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_Playlists WHERE id=?').get(a.id).n, 0);
    assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { f.sqlite.close(); }
});

test('play receipts deduplicate across local/external sources in both directions, isolate accounts and keep real rankings', async () => {
  const f = fixture();
  try {
    const post = (id, song, account = 'a') => f.call('/api/account/play-stats', { method: 'POST', account, body: { events: [{ event_id: id, song_id: song, played_at: 100 }] } });
    assert.equal((await post('same', 'local1')).data.recorded, 1);
    assert.equal((await post('same', yt(1))).data.recorded, 0);
    assert.equal(f.calls(), 0); // Duplicate source changes do not even resolve a new track.
    assert.equal((await post('other', yt(1))).data.recorded, 1);
    assert.equal((await post('other', 'local1')).data.recorded, 0);
    assert.equal((await post('second', yt(1))).data.recorded, 1);
    assert.equal((await post('same', yt(1), 'b')).data.recorded, 1);
    const stats = await f.call('/api/account/play-stats');
    assert.deepEqual(stats.data.playCounts, { local1: 1, [yt(1)]: 2 });
    assert.equal(stats.data.totalPlays, 3); assert.equal(stats.data.totalUniqueSongs, 2);
    assert.deepEqual(stats.data.songs.map(s => [s.id, s.play_count]), [[yt(1), 2], ['local1', 1]]);
    assert.equal(stats.data.songs[0].source, 'youtube');
    assert.equal((await f.call('/api/account/play-stats?view=summary&limit=1')).data.songs.length, 1);
    assert.equal(f.sqlite.prepare("SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id='a'").get().receipt_count, 3);
    // Database-level guards also stop direct competing writes after preflight.
    f.sqlite.prepare('INSERT OR IGNORE INTO Member_External_Play_Events VALUES (?,?,?,?,?)').run('a', 'same', yt(1), 200, Date.now());
    f.sqlite.prepare('INSERT OR IGNORE INTO Member_Play_Events VALUES (?,?,?,?,?)').run('a', 'other', 'local1', 200, Date.now());
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM Member_All_Play_Events WHERE account_id='a'").get().n, 3);
  } finally { f.sqlite.close(); }
});

test('temporary unknown YT failures return partial acknowledgements while local and known offline plays remain accepted', async () => {
  const f = fixture();
  try {
    await f.create([yt(1)]);
    const offline = { externalReferences: true, async resolveExternalSongs() { throw new Error('upstream unavailable'); }, async assertExternalCurrent() { throw new Error('disconnected'); } };
    const body = { events: [{ event_id: 'local', song_id: 'local1', played_at: 100 }, { event_id: 'known', song_id: yt(1), played_at: 100 }, { event_id: 'pending', song_id: yt(2), played_at: 100 }] };
    const partial = await f.call('/api/account/play-stats', { method: 'POST', dependencies: offline, body });
    assert.equal(partial.status, 200); assert.equal(partial.data.recorded, 2); assert.deepEqual(partial.data.acceptedEventIds, ['local', 'known']);
    const retry = await f.call('/api/account/play-stats', { method: 'POST', body });
    assert.equal(retry.data.recorded, 1); assert.deepEqual(retry.data.acceptedEventIds, ['local', 'known', 'pending']);
    assert.equal((await f.call('/api/account/play-stats')).data.totalPlays, 3);
  } finally { f.sqlite.close(); }
});

test('combined receipt quota and retention remain bounded and concurrent cross-source duplicates count once', async () => {
  const f = fixture();
  try {
    await f.create([yt(1)]); const now = Date.now();
    f.sqlite.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<9999)
      INSERT INTO Member_Play_Events SELECT 'a','receipt-'||n,'local1',?,? FROM seq`).run(now, now);
    const event = (event_id, song_id) => ({ event_id, song_id, played_at: now });
    const post = events => f.call('/api/account/play-stats', { method: 'POST', body: { events } });
    assert.equal((await post([event('last', yt(1))])).data.recorded, 1);
    assert.equal((await post([event('overflow', 'local1')])).status, 429);
    assert.equal((await post([event('last', 'local2')])).data.recorded, 0);
    assert.equal(f.sqlite.prepare("SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id='a'").get().receipt_count, 10000);
    f.sqlite.prepare("UPDATE Member_External_Play_Events SET received_at=? WHERE event_id='last'").run(now - 31 * 86400000);
    assert.equal((await post([event('new', yt(1))])).data.recorded, 1);
    assert.equal(f.sqlite.prepare("SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id='a'").get().receipt_count, 10000);
    f.sqlite.prepare("DELETE FROM Member_Play_Events WHERE event_id='receipt-1'").run();
    f.db.beforeBatch = () => {
      // First batch is retention cleanup; inject just before the event batch.
      f.db.beforeBatch = () => { f.db.beforeBatch = null; f.sqlite.prepare('INSERT INTO Member_Play_Events VALUES (?,?,?,?,?)').run('a', 'race', 'local1', now, now); };
    };
    const race = await post([event('race', yt(1))]);
    // Conservative quota recheck may reject; it must never count/ack a second play.
    assert.ok([200, 429].includes(race.status));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM Member_All_Play_Events WHERE account_id='a' AND event_id='race'").get().n, 1);
    assert.equal(f.sqlite.prepare("SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id='a'").get().receipt_count, 10000);
  } finally { f.sqlite.close(); }
});

test('old schema keeps local reads/writes working and explicitly rejects external writes instead of acknowledging missing YT', async () => {
  const f = fixture({ external: false });
  try {
    const p = await f.create(['local1']);
    assert.equal((await f.call(`/api/account/playlists/${p.id}`)).data.playlist.songCount, 1);
    const add = await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', body: { expectedRevision: 0, songIds: [yt(1)] } });
    assert.equal(add.status, 503); assert.equal(add.error, 'EXTERNAL_MUSIC_MIGRATION_REQUIRED');
    const stats = await f.call('/api/account/play-stats', { method: 'POST', body: { events: [{ event_id: 'not-ack', song_id: yt(1), played_at: 100 }] } });
    assert.equal(stats.status, 503); assert.equal(stats.error, 'EXTERNAL_MUSIC_MIGRATION_REQUIRED');
    assert.equal(f.calls(), 0);
    assert.equal((await f.call('/api/account/play-stats', { method: 'POST', body: { events: [{ event_id: 'local', song_id: 'local1', played_at: 100 }] } })).data.recorded, 1);
  } finally { f.sqlite.close(); }
});

test('50-playlist quota and all-or-nothing references remain unchanged on failed creation', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<50)
      INSERT INTO Member_Playlists(id,account_id,kind,name,created_at,updated_at) SELECT 'p'||n,'a','regular','Playlist',1,1 FROM seq;`);
    const result = await f.call('/api/account/playlists', { method: 'POST', body: { name: 'Overflow', songIds: [yt(1)] } });
    assert.equal(result.status, 409); assert.equal(result.error, 'PLAYLIST_LIMIT_REACHED');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Songs').get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM Member_Playlists WHERE kind='regular'").get().n, 50);
  } finally { f.sqlite.close(); }
});

test('500 new references use 13 bounded JSON statements and invalid resolver DTOs are rejected without writes', async () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 500 }, (_, n) => yt(n));
    const plan = await prepareExternalSongs(f.db, 'a', ids, Date.now(), f.deps);
    assert.equal(plan.statements.length, 13);
    await plan.assertCurrent(); await f.db.batch(plan.statements);
    assert.equal((await loadExternalSongs(f.db, 'a', ids)).length, 500);
    await assert.rejects(prepareExternalSongs(f.db, 'b', [yt(1)], Date.now(), { ...f.deps, resolveExternalSongs: async () => [{ ...dto(yt(2)), id: yt(1) }] }), { code: 'EXTERNAL_SONG_INVALID' });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM Member_External_Songs WHERE account_id='b'").get().n, 0);
  } finally { f.sqlite.close(); }
});

test('binding retired during the quota read leaves new YT events pending while local and existing snapshots still commit', async () => {
  const f = fixture();
  try {
    await f.create([yt(1)]);
    let active = true;
    const deps = { ...f.deps, async assertExternalCurrent() { if (!active) throw new Error('retired binding'); } };
    f.db.beforeRead = sql => { if (/^SELECT receipt_count AS count/.test(sql)) active = false; };
    const result = await f.call('/api/account/play-stats', { method: 'POST', dependencies: deps, body: { events: [
      { event_id: 'new', song_id: yt(2), played_at: 100 }, { event_id: 'known', song_id: yt(1), played_at: 100 }, { event_id: 'local', song_id: 'local1', played_at: 100 },
    ] } });
    assert.equal(result.status, 200); assert.equal(result.data.recorded, 2); assert.deepEqual(result.data.acceptedEventIds, ['known', 'local']);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Songs WHERE song_id=?').get(yt(2)).n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM Member_All_Play_Events WHERE event_id='new'").get().n, 0);
  } finally { f.sqlite.close(); }
});

test('25 cold YT events share one partial resolver and bounded metadata writes instead of per-event round trips', async () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 25 }, (_, n) => yt(n)); let calls = 0, checks = 0;
    const deps = { externalReferences: true, async resolveExternalSongs(requested, options) {
      calls++; assert.deepEqual(requested, ids); assert.equal(options.partial, true);
      return requested.slice(0, -1).map(dto); // A single unavailable item stays pending.
    }, async assertExternalCurrent() { checks++; } };
    const result = await f.call('/api/account/play-stats', { method: 'POST', dependencies: deps,
      body: { events: ids.map((id, i) => ({ event_id: 'cold-' + i, song_id: id, played_at: 100 })) } });
    assert.equal(result.status, 200); assert.equal(result.data.recorded, 24); assert.equal(result.data.acceptedEventIds.length, 24);
    assert.ok(!result.data.acceptedEventIds.includes('cold-24'));
    assert.equal(calls, 1); assert.equal(checks, 2);
    assert.ok(f.db.queries.length < 40, `cold batch ran ${f.db.queries.length} statements`);
    assert.equal(f.db.queries.filter(sql => /^INSERT INTO Member_External_Songs/.test(sql)).length, 1);
  } finally { f.sqlite.close(); }
});

test('a local song removed after mixed-statistics preflight is acknowledged as the established missing-song noop', async () => {
  const f = fixture();
  try {
    f.db.beforeBatch = () => { f.db.beforeBatch = () => { f.db.beforeBatch = null; f.sqlite.exec("DELETE FROM Songs WHERE id='local1'"); }; };
    const result = await f.call('/api/account/play-stats', { method: 'POST', body: { events: [{ event_id: 'deleted', song_id: 'local1', played_at: 100 }] } });
    assert.equal(result.status, 200); assert.equal(result.data.recorded, 0); assert.deepEqual(result.data.acceptedEventIds, ['deleted']);
  } finally { f.sqlite.close(); }
});

test('partially damaged 0014 never returns an apparently empty local-only library or accepts writes', async () => {
  const f = fixture();
  try {
    const p = await f.create([yt(1), 'local1']);
    f.sqlite.exec('DROP TRIGGER ft_external_playlist_insert_count');
    invalidateSchemaInventory(f.db);
    for (const path of ['/api/account/playlists', `/api/account/playlists/${p.id}`, '/api/account/play-stats']) {
      const result = await f.call(path);
      assert.equal(result.status, 503, path); assert.equal(result.error, 'EXTERNAL_MUSIC_SCHEMA_INCOMPLETE');
    }
    const write = await f.call(`/api/account/playlists/${p.id}/songs`, { method: 'PUT', body: { expectedRevision: 0, songIds: ['local1'] } });
    assert.equal(write.status, 503);
    await assert.rejects(readAccountPlaylistSongs(f.db, 'a', p.id), { code: 'EXTERNAL_MUSIC_SCHEMA_INCOMPLETE' });
    await assert.rejects(readAccountTopSongs(f.db, 'a', 20), { code: 'EXTERNAL_MUSIC_SCHEMA_INCOMPLETE' });
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM Member_External_Playlist_Songs').get().n, 1);
  } finally { f.sqlite.close(); }
});
