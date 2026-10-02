import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixture, PASSWORD } from './test-support.js';
import { md5 } from './md5.js';
import { ownStatus, setEnabled, settingKey } from './credentials.js';
import { changePassword } from '../auth/local/index.js';
import { resetAccountPassword } from '../instanceAdmin/accounts.js';
import { buildReadyLyricArtifact } from '../services/lyricAssetWorkflow.js';
import { parseLrcDocument } from '../utils/lyricDocument.js';
import packageMetadata from '../../../package.json' with { type: 'json' };

const body = async (response) => {
  if (!response.headers.get('content-type')?.startsWith('text/xml')) return (await response.json())['subsonic-response'];
  const xml = await response.text();
  const code = /<error code="(\d+)"/.exec(xml);
  assert.ok(code, 'expected a protocol error document');
  return { status: 'failed', error: { code: Number(code[1]) } };
};

test('protocol reports the package version in JSON and XML', async () => {
  const f = await fixture();
  try {
    await f.enable();
    assert.equal((await body(await f.rest('ping'))).serverVersion, packageMetadata.version);
    assert.ok((await (await f.rest('ping', { f: 'xml' })).text()).includes('serverVersion="' + packageMetadata.version + '"'));
  } finally { await f.close(); }
});

test('GET mutations reject a damaged schema after read cache warmup without changing data', async () => {
  for (const method of ['createPlaylist', 'updatePlaylist', 'deletePlaylist', 'star', 'unstar']) {
    const f = await fixture();
    try {
      await f.enable();
      const created = await body(await f.rest('createPlaylist', { name: 'existing', songId: 's1' }));
      const playlistId = created.playlist.id;
      await f.rest('star', { id: 's1' });
      assert.equal((await body(await f.rest('ping'))).status, 'ok');
      f.sqlite.exec('DROP TRIGGER ft_member_playlist_songs_insert_count');
      const snapshot = () => JSON.stringify([
        f.sqlite.prepare('SELECT * FROM Member_Playlists ORDER BY id').all(),
        f.sqlite.prepare('SELECT * FROM Member_Playlist_Songs ORDER BY playlist_id, song_id').all(),
      ]);
      const before = snapshot();
      const response = await f.rest(method, {
        name: 'must-not-write', playlistId, songId: 's2', songIdToAdd: 's2',
        id: method === 'deletePlaylist' ? playlistId : 's1',
      });
      assert.equal(response.status, 503, method);
      assert.equal((await body(response)).status, 'failed', method);
      assert.equal(snapshot(), before, method);
    } finally { await f.close(); }
  }
});
test('legacy MD5 boundary matches independent implementation including Unicode and block boundaries', () => {
  for (const value of ['', 'abc', '密码🔒test-salt', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(1024)]) {
    assert.equal(md5(value), createHash('md5').update(value).digest('hex'));
  }
});
test('opt-in requires current password and CSRF, is encrypted and never returned, disable rejects new requests', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await body(await f.rest('ping'))).error.code, 40);
  assert.deepEqual(await (await f.api('account/subsonic')).json(), { enabled: false, revision: 0 });
  assert.equal((await f.api('account/subsonic', 'PUT', { enabled: true, currentPassword: PASSWORD, expectedRevision: 0 }, f.signed,
    { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.enable(f.signed, 'wrong-password')).status, 401);
  assert.equal((await f.enable()).status, 200);
  const saved = f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(settingKey(f.owner)).value_json;
  assert.ok(!saved.includes(PASSWORD)); assert.ok(JSON.parse(saved).encrypted);
  assert.deepEqual(await (await f.api('account/subsonic')).json(), { enabled: true, revision: 1 });
  assert.equal((await body(await f.rest('ping'))).status, 'ok');
  assert.equal((await f.api('account/subsonic', 'PUT', { enabled: false, expectedRevision: 0 })).status, 409);
  assert.equal((await f.api('account/subsonic', 'PUT', { enabled: false, expectedRevision: 1 })).status, 200);
  assert.equal((await body(await f.rest('ping'))).error.code, 40);
  assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(settingKey(f.owner)).value_json), { enabled: false });
});
test('own password change closes compatibility and requires validation with the new password', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const password = 'new-current-password-2026';
  await changePassword({ db: f.db, session: f.signed.session, currentPassword: PASSWORD, newPassword: password });
  assert.equal((await ownStatus(f.db, f.owner, f.env)).enabled, false);
  assert.equal((await body(await f.rest('ping'))).error.code, 40);
  assert.equal((await body(await f.rest('ping', {}, { password }))).error.code, 40);
  const auth = await f.signIn('owner', password);
  assert.equal((await f.enable(auth, PASSWORD)).status, 401);
  assert.equal((await f.enable(auth, password)).status, 200);
  assert.equal((await body(await f.rest('ping', {}, { password }))).status, 'ok');
  assert.equal((await body(await f.rest('ping'))).error.code, 40);
});
test('password change rollback preserves both existing password and encrypted compatibility state', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  f.db.fail = /UPDATE instance_settings/;
  await assert.rejects(changePassword({ db: f.db, session: f.signed.session, currentPassword: PASSWORD, newPassword: 'different-new-password' }));
  f.db.fail = null;
  assert.equal((await body(await f.rest('ping'))).status, 'ok');
});
test('reset deletes compatibility material; disabled and must-change accounts cannot connect', async (t) => {
  const f = await fixture(); t.after(f.close);
  const auth = await f.signIn('member'); await f.enable(auth);
  f.sqlite.exec("UPDATE accounts SET status='disabled' WHERE account_id='member'");
  assert.equal((await body(await f.rest('ping', {}, { username: 'member' }))).error.code, 40);
  f.sqlite.exec("UPDATE accounts SET status='active' WHERE account_id='member'");
  await resetAccountPassword({ db: f.db, actorAccountId: f.owner, accountId: 'member', temporaryPassword: 'reset-password-temporary' });
  assert.equal((await body(await f.rest('ping', {}, { username: 'member', password: 'reset-password-temporary' }))).error.code, 40);
  assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(settingKey('member')).value_json), { enabled: false });
});
test('rotation and encrypted-record transplantation fail closed; switched-account writes are rejected', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  assert.equal((await body(await f.rest('ping', {}, { env: { ...f.env, SETUP_SECRET: 'a-completely-different-setup-secret-123' } }))).error.code, 40);
  const auth = await f.signIn('member'); await f.enable(auth);
  const saved = JSON.parse(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(settingKey(f.owner)).value_json);
  saved.salt = f.sqlite.prepare("SELECT salt FROM account_credentials WHERE account_id='member'").get().salt;
  f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify(saved), settingKey('member'));
  assert.equal((await body(await f.rest('ping', {}, { username: 'member' }))).error.code, 40);
  assert.equal((await f.api('account/subsonic', 'PUT', { enabled: false, expectedRevision: 1 }, auth,
    { 'X-FlareTune-Expected-Account': f.owner })).status, 409);
});
test('concurrent enable cannot resurrect access after password or session changed', async (t) => {
  const f = await fixture(); t.after(f.close);
  f.db.beforeWrite = (sql) => { if (/INSERT INTO instance_settings/.test(sql)) {
    f.db.beforeWrite = null; f.sqlite.exec('UPDATE account_sessions SET revoked_at=1');
  } };
  await assert.rejects(setEnabled(f.db, f.signed.session, { enabled: true, currentPassword: PASSWORD, expectedRevision: 0 }, f.env), { code: 'revision_conflict' });
  assert.equal((await ownStatus(f.db, f.owner, f.env)).enabled, false);
});
test('library, empty-query sync pagination, XML, discovery and authorization envelope', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const artists = (await body(await f.rest('getArtists.view'))).artists.index[0].artist;
  assert.equal(artists.length, 2);
  const artist = (await body(await f.rest('getArtist', { id: artists.find((a) => a.name === 'Artist').id }))).artist;
  const album = (await body(await f.rest('getAlbum', { id: artist.album[0].id }))).album;
  assert.deepEqual(album.song.map((s) => s.id), ['s1','s2']);
  const warmStart = f.db.rowsRead;
  const search = await body(await f.rest('search3', { query: '', artistCount: 0, albumCount: 0, songOffset: 1, songCount: 1 }));
  assert.deepEqual(search.searchResult3.song.map((s) => s.id), ['s2']);
  assert.ok(f.db.rowsRead - warmStart < 15); // Warm catalog avoids reading Songs again.
  assert.ok(!f.db.queries.slice(-10).some((q) => /FROM Songs WHERE audio_url/.test(q)));
  assert.equal((await body(await f.rest('search3', { query: 'night' }))).searchResult3.song[0].id, 's2');
  const xml = await (await f.rest('getSong', { id: 's1', f: 'xml' })).text();
  assert.match(xml, /One &amp; &lt;two&gt;/);
  const indexes = (await body(await f.rest('getIndexes'))).indexes;
  assert.ok(Number.isSafeInteger(indexes.lastModified) && indexes.lastModified > 0);
  assert.equal((await body(await f.rest('getIndexes'))).indexes.lastModified, indexes.lastModified);
  assert.match(await (await f.rest('getIndexes', { f: 'xml' })).text(), new RegExp(`<indexes lastModified="${indexes.lastModified}"`));
  assert.equal((await body(await f.rest('getOpenSubsonicExtensions'))).openSubsonicExtensions[0].name, 'songLyrics');
  assert.equal((await body(await f.rest('getOpenSubsonicExtensions', { u: null, t: null, s: null }))).status, 'ok');
  assert.equal((await body(await f.rest('getUser', { username: 'member' }))).error.code, 50);
  assert.equal((await body(await f.rest('ping', { t: null, s: null }))).error.code, 10);
  assert.equal((await body(await f.rest('ping', { p: PASSWORD }))).error.code, 43);
  assert.equal((await body(await f.rest('ping', { v: '1.17.0' }))).error.code, 30);
  assert.equal((await body(await f.rest('ping', {}, { origin: 'http://test.example' }))).status, 'failed');
});
test('playlist CRUD and favorites are shared with native data and isolated between accounts', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const member = await f.signIn('member'); await f.enable(member);
  const made = await body(await f.rest('createPlaylist', { name: 'Test', songId: ['s1','s2'] }));
  assert.equal(made.status, 'ok'); const id = made.playlist.id;
  assert.deepEqual(made.playlist.entry.map((s) => s.id), ['s1','s2']);
  assert.equal((await body(await f.rest('getPlaylist', { id }, { username: 'member' }))).error.code, 70);
  assert.equal((await body(await f.rest('deletePlaylist', { id }, { username: 'member' }))).error.code, 70);
  const native = await (await f.api(`account/playlists/${id}`)).json();
  assert.equal(native.data.playlist.name, 'Test');
  assert.equal((await body(await f.rest('updatePlaylist', { playlistId: id, name: 'Changed', songIndexToRemove: 0, songIdToAdd: 's3' }))).status, 'ok');
  assert.deepEqual((await body(await f.rest('getPlaylist2', { id }))).playlist.entry.map((s) => s.id), ['s2','s3']);
  assert.equal((await body(await f.rest('star', { id: ['s1','s2'] }))).status, 'ok');
  assert.deepEqual((await body(await f.rest('getStarred2'))).starred2.song.map((s) => s.id), ['s1','s2']);
  assert.equal((await body(await f.rest('getStarred2', {}, { username: 'member' }))).starred2.song.length, 0);
  assert.equal((await body(await f.rest('unstar', { id: 's1' }))).status, 'ok');
  assert.equal((await body(await f.rest('deletePlaylist', { id }))).status, 'ok');
  assert.equal((await body(await f.rest('getPlaylist', { id }))).error.code, 70);
});
test('50 playlist summaries keep a fixed query budget and account-scoped counts, duration and covers', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const add = f.sqlite.prepare(`INSERT INTO Member_Playlists
    (id, account_id, kind, name, created_at, updated_at) VALUES (?, ?, 'regular', ?, 1, 1)`);
  for (let i = 0; i < 50; i++) add.run(`pl_${i}`, f.owner, `List ${i}`);
  add.run('other', 'member', 'Other account');
  f.sqlite.exec(`INSERT INTO Member_Playlist_Songs (playlist_id,song_id,sort_order,added_at)
    VALUES ('pl_0','s1',0,1),('pl_0','s2',1,1),('other','s3',0,1)`);
  const before = f.db.queries.length;
  const response = await body(await f.rest('getPlaylists'));
  const queries = f.db.queries.length - before;
  assert.equal(response.status, 'ok');
  assert.equal(response.playlists.playlist.length, 50);
  assert.ok(queries <= 15, `getPlaylists issued ${queries} queries`);
  const first = response.playlists.playlist.find((p) => p.id === 'pl_0');
  assert.equal(first.songCount, 2); assert.equal(first.duration, 45); assert.equal(first.coverArt, 'cover_s1');
  const empty = response.playlists.playlist.find((p) => p.id === 'pl_1');
  assert.equal(empty.songCount, 0); assert.equal(empty.duration, 0); assert.equal(empty.coverArt, undefined);
  assert.ok(response.playlists.playlist.every((p) => p.owner === 'owner' && p.id !== 'other'));
});

test('500-song playlist creation and replacement fit the D1 query budget without losing order or counts', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const insert = f.sqlite.prepare('INSERT INTO Songs (id,title,audio_url) VALUES (?,?,?)');
  const ids = Array.from({ length: 500 }, (_, i) => `bulk_${i}`);
  for (const id of ids) insert.run(id, id, '/media/audio/bulk.mp3');
  let before = f.db.queries.length;
  const made = await body(await f.rest('createPlaylist', { name: 'Full list', songId: ids }));
  assert.equal(made.status, 'ok');
  assert.ok(f.db.queries.length - before <= 30);
  assert.equal(made.playlist.songCount, 500);
  assert.deepEqual(made.playlist.entry.map((s) => s.id), ids);
  before = f.db.queries.length;
  const reversed = [...ids].reverse();
  const replaced = await body(await f.rest('createPlaylist', { playlistId: made.playlist.id, songId: reversed }));
  assert.equal(replaced.status, 'ok');
  assert.ok(f.db.queries.length - before <= 30);
  assert.equal(replaced.playlist.songCount, 500);
  assert.deepEqual(replaced.playlist.entry.map((s) => s.id), reversed);
  assert.equal((await body(await f.rest('updatePlaylist', { playlistId: made.playlist.id, songIdToAdd: 's1' }))).status, 'failed');
  assert.equal(f.sqlite.prepare('SELECT cached_song_count AS n FROM Member_Playlists WHERE id=?').get(made.playlist.id).n, 500);
});

test('invalid or failed playlist mutation cannot partially rename or leave an orphan playlist', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const made = await body(await f.rest('createPlaylist', { name: 'Original', songId: 's1' }));
  const id = made.playlist.id;
  await f.rest('updatePlaylist', { playlistId: id, name: 'Wrong', songIdToAdd: 'missing' });
  assert.equal((await body(await f.rest('getPlaylist', { id }))).playlist.name, 'Original');
  f.db.fail = /INSERT INTO Member_Playlist_Songs/;
  assert.equal((await f.rest('updatePlaylist', { playlistId: id, name: 'Wrong', songIdToAdd: 's2' })).status, 503);
  assert.equal((await f.rest('createPlaylist', { name: 'Orphan', songId: 's2' })).status, 503);
  f.db.fail = null;
  assert.equal((await body(await f.rest('getPlaylist', { id }))).playlist.name, 'Original');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE name='Orphan'").get().n, 0);
});
test('private media supports bytes, Range and HEAD; no-cookie protocol requests cannot bypass opt-in', async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.rest('stream', { id: 's1' }); assert.equal(f.mediaReads(), 0);
  await f.enable();
  const stream = await f.rest('stream', { id: 's1', format: 'raw' }, { headers: { Range: 'bytes=1-3' } });
  assert.equal(stream.status, 206); assert.equal(stream.headers.get('Content-Range'), 'bytes 1-3/5');
  assert.deepEqual([...new Uint8Array(await stream.arrayBuffer())], [2,3,4]);
  assert.match(stream.headers.get('Cache-Control'), /private/);
  assert.equal((await f.rest('download', { id: 's1' }, { method: 'HEAD' })).headers.get('Content-Length'), '5');
  const album = (await body(await f.rest('getAlbumList2', { type: 'newest' }))).albumList2.album.find((a) => a.name === 'Album');
  assert.equal((await f.rest('getCoverArt', { id: `al-${album.id}` })).headers.get('Content-Type'), 'image/png');
  f.sqlite.prepare('UPDATE Songs SET audio_url=? WHERE id=?').run('/media/../secrets', 's1');
  assert.equal((await body(await f.rest('stream', { id: 's1' }))).error.code, 70);
  assert.equal((await body(await f.rest('scrobble', { id: 's2' }))).status, 'failed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM Member_Play_Events').get().n, 0);
});
test('stored canonical lyrics preserve synchronization and XML text; absent lyrics are an empty result', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const { artifact } = await buildReadyLyricArtifact({ id: 's1', title: 'One', artist: 'Artist' }, parseLrcDocument('[00:01.00]Hello & world\n[00:02.00]Second line', { source: 'manual' }), { offsetMs: 500 });
  f.objects.set('media/lyrics/s1.json', { bytes: new TextEncoder().encode(JSON.stringify(artifact)), type: 'application/json' });
  const lyrics = await body(await f.rest('getLyricsBySongId', { id: 's1' }));
  assert.equal(lyrics.status, 'ok');
  assert.equal(lyrics.lyricsList.structuredLyrics[0].line[0].start, 1500);
  assert.match(await (await f.rest('getLyricsBySongId', { id: 's1', f: 'xml' })).text(), /<line start="1500">Hello &amp; world<\/line>/);
  assert.deepEqual((await body(await f.rest('getLyricsBySongId', { id: 's2' }))).lyricsList.structuredLyrics, []);
});

test('existing relative catalog media plays and displays covers through the same private objects', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  f.sqlite.prepare('UPDATE Songs SET audio_url=?, cover_url=? WHERE id=?')
    .run('audio/one.mp3', 'cover/one.png', 's1');
  for (const method of ['stream', 'download']) {
    const r = await f.rest(method, { id: 's1', format: 'raw' }, { headers: { Range: 'bytes=1-3' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(r.headers.get('Content-Range'), 'bytes 1-3/5');
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [2, 3, 4]);
    const head = await f.rest(method, { id: 's1' }, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Length'), '5');
    assert.equal(await head.text(), '');
  }
  const searched = await body(await f.rest('search3', { query: 'One' }));
  const starred = await f.rest('star', { id: 's1' });
  assert.equal((await body(starred)).status, 'ok');
  const favorite = (await body(await f.rest('getStarred2'))).starred2.song[0];
  const album = (await body(await f.rest('getAlbumList2', { type: 'newest' }))).albumList2.album.find(a => a.name === 'Album');
  const artist = (await body(await f.rest('getArtists'))).artists.index[0].artist.find(a => a.name === 'Artist');
  for (const id of [searched.searchResult3.song[0].coverArt, favorite.coverArt, album.coverArt,
    album.id, `al-${album.id}`, artist.id, `ar-${artist.id}`]) {
    const r = await f.rest('getCoverArt', { id, size: 300 });
    assert.equal(r.headers.get('Content-Type'), 'image/png', id);
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [6, 7, 8], id);
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  }
  assert.equal((await f.rest('getCoverArt2', { id: 'cover_s1' }, { method: 'HEAD' })).headers.get('Content-Length'), '3');
  const reads = f.mediaReads();
  assert.equal((await body(await f.rest('stream', { id: 's1', u: null, t: null, s: null }))).status, 'failed');
  assert.equal(f.mediaReads(), reads);
});

test('relative catalog normalization still rejects external and escaping media references before storage reads', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  for (const path of ['https://other.example/audio/one.mp3', '//other.example/audio/one.mp3',
    'users/private.png', 'audio/../secret', 'audio/%2e%2e/secret', 'audio/a%2fb.mp3',
    'audio/a%5cb.mp3', 'audio/one.mp3?token=x', 'cover/one.png#fragment',
    '/media/../secret', '/media/users/../../secret', 'audio/%00.mp3', 'audio//one.mp3']) {
    f.sqlite.prepare('UPDATE Songs SET audio_url=?, cover_url=? WHERE id=?').run(path, path, 's1');
    const reads = f.mediaReads();
    for (const [method, id] of [['stream', 's1'], ['download', 's1'], ['getCoverArt', 'cover_s1']]) {
      assert.equal((await body(await f.rest(method, { id }))).error.code, 70, `${method}: ${path}`);
    }
    assert.equal(f.mediaReads(), reads, path);
  }
});

test('opt-in diagnostics identify failures without logging authentication, queries or storage exception text', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const messages = [];
  t.mock.method(console, 'warn', value => messages.push(value));
  await f.rest('stream', { id: 's1', maxBitRate: 320 });
  assert.equal(messages.length, 0);
  const env = { ...f.env, SUBSONIC_DIAGNOSTICS: 'true' };
  await f.rest('stream', { id: 's1', maxBitRate: 320 }, { env });
  assert.deepEqual(JSON.parse(messages.pop()), { event: 'subsonic_failure', endpoint: 'stream', code: 0, reason: 'bitrate_limit_requested' });
  await f.rest('getSong', { id: 'private-song-reference', t: 'f'.repeat(32), s: 'private-salt' }, { env });
  assert.deepEqual(JSON.parse(messages.pop()), { event: 'subsonic_failure', endpoint: 'getSong', code: 40, reason: 'authentication_rejected' });
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    if (sql.includes('FROM Songs WHERE id = ?')) throw new Error('private SQL or token details');
    return prepare(sql);
  };
  await f.rest('getSong', { id: 's1' }, { env });
  assert.deepEqual(JSON.parse(messages.pop()), { event: 'subsonic_failure', endpoint: 'getSong', code: 0, reason: 'service_unavailable' });
  assert.deepEqual(messages, []);
});

test('binary endpoints report failures as text/xml independent of f, with empty HEAD bodies', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  for (const [method, params, code] of [
    ['stream', { id: 's1', t: 'f'.repeat(32) }, 40],
    ['stream.view', { id: 'missing' }, 70],
    ['stream', { id: 's1', maxBitRate: 320 }, 0],
    ['stream', {}, 10],
    ['download', { id: 'missing' }, 70],
    ['getCoverArt', { id: 'missing' }, 70],
    ['getCoverArt2', { id: 'missing' }, 70],
    ['download.view', { id: 's1', maxBitRate: 320 }, 0],
  ]) {
    for (const format of ['json', 'xml']) {
      const response = await f.rest(method, { ...params, f: format });
      assert.equal(response.status, code === 70 ? 404 : code === 40 ? 403 : 400);
      assert.equal(response.headers.get('content-type'), 'text/xml; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(await response.text(), new RegExp(`<error code="${code}"`));
    }
    const head = await f.rest(method, params, { method: 'HEAD' });
    assert.equal(head.status, code === 70 ? 404 : code === 40 ? 403 : 400);
    assert.equal(head.headers.get('content-type'), 'text/xml; charset=utf-8');
    assert.equal(await head.text(), '');
  }
  const head = await f.rest('stream', { id: 'missing' }, { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(head.headers.get('content-type'), 'text/xml; charset=utf-8');
  assert.equal(await head.text(), '');
  const metadata = await f.rest('getSong', { id: 'missing' });
  assert.equal(metadata.status, 200);
  assert.match(metadata.headers.get('content-type'), /^application\/json/);
  assert.equal((await body(metadata)).error.code, 70);
  const invalidFormat = await f.rest('download.view', { id: 's1', f: 'invalid' });
  assert.equal(invalidFormat.status, 400);
  assert.equal(invalidFormat.headers.get('content-type'), 'text/xml; charset=utf-8');
  assert.match(await invalidFormat.text(), /<error code="0"/);
});

test('failed media can be retried as original bytes, without changing Range or metadata errors', async (t) => {
  const f = await fixture(); t.after(f.close); await f.enable();
  const object = f.objects.get('media/audio/one.mp3');
  f.objects.delete('media/audio/one.mp3');
  const missing = await f.rest('download', { id: 's1' });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /<error code="70"/);
  f.objects.set('media/audio/one.mp3', object);
  for (const method of ['stream', 'download']) {
    const retried = await f.rest(method, { id: 's1', maxBitRate: 0 });
    assert.equal(retried.status, 200);
    assert.equal(retried.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual([...new Uint8Array(await retried.arrayBuffer())], [1, 2, 3, 4, 5]);
    const range = await f.rest(method, { id: 's1' }, { headers: { Range: 'bytes=1-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 1-3/5');
    assert.deepEqual([...new Uint8Array(await range.arrayBuffer())], [2, 3, 4]);
  }
  const noStorage = await f.rest('stream', { id: 's1' }, { env: { ...f.env, MEDIA_BUCKET: null } });
  assert.equal(noStorage.status, 503);
  assert.equal(noStorage.headers.get('content-type'), 'text/xml; charset=utf-8');
  assert.match(await noStorage.text(), /<error code="0"/);
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    if (sql.includes('FROM Songs WHERE id = ?')) throw new Error('storage unavailable');
    return prepare(sql);
  };
  const unavailable = await f.rest('stream', { id: 's1' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('content-type'), 'text/xml; charset=utf-8');
  assert.match(await unavailable.text(), /<error code="0"/);
});
