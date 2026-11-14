import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalAccountMusicRoute } from './localAccountMusic.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const YT = 'yt:abcdefghijk';
const metadata = title => ({ id: YT, source: 'youtube', sourceId: YT.slice(3), title, artist: 'YT singer',
  album: 'YT album', albumId: 'yt:album:MPREb_album', duration: 180,
  audio_url: 'https://private.googlevideo.com/do-not-expose', cover_url: null });

function fixture(t, { external = false, hotpaths = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  t.mock.method(Date, 'now', () => NOW);
  sqlite.exec('PRAGMA foreign_keys=ON');
  const names = ['0001_baseline.sql', '0002_expand_playlist_count.sql'];
  if (hotpaths || external) names.push('0013_hotpath_indexes_and_counts.sql');
  if (external) names.push('0014_external_music_references.sql');
  for (const name of names) sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/' + name, import.meta.url), 'utf8'));
  sqlite.exec(`INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES
    ('A','user-a','admin',1,1),('B','user-b','member',1,1);
    INSERT INTO Songs(id,title,artist,album,duration,audio_url,language) VALUES
    ('one','One','Artist','Album',180,'/media/one.mp3','en'),
    ('two','Two','Artist','Album',180,'/media/two.mp3','en'),
    ('three','Three','Artist','Album',180,'/media/three.mp3','en');`);
  if (external) {
    const insert = sqlite.prepare(`INSERT INTO Member_External_Songs
      (account_id,song_id,source,source_id,metadata_json,updated_at) VALUES (?,?,'youtube',?,?,?)`);
    insert.run('A', YT, YT.slice(3), JSON.stringify(metadata('Private A version')), NOW);
    insert.run('B', YT, YT.slice(3), JSON.stringify(metadata('Private B version')), NOW);
  }
  let sequence = 0;
  const event = (songId, time, accountId = 'A', receivedAt = NOW) => {
    sqlite.prepare(`INSERT INTO ${songId.startsWith('yt:') ? 'Member_External_Play_Events' : 'Member_Play_Events'}
      (account_id,event_id,song_id,played_at,received_at) VALUES (?,?,?,?,?)`)
      .run(accountId, `event-${++sequence}`, songId, time, receivedAt);
  };
  const statements = [];
  const db = { readOnly: false, prepare(sql) {
    if (db.readOnly) assert.match(sql.trimStart(), /^(?:SELECT|WITH)\b/i);
    statements.push(sql);
    const statement = values => ({ bind: (...next) => statement(next),
      first: async () => sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
    });
    return statement([]);
  }, async batch(items) {
    if (db.readOnly) throw new Error('GET attempted a transaction');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = [];
      for (const item of items) result.push(await item.run());
      sqlite.exec('COMMIT');
      return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  async function call(query = '', { accountId = 'A', session, headers = {}, deps } = {}) {
    const request = new Request('https://tune.test/api/account/play-stats' + query, { headers });
    const response = await handleLocalAccountMusicRoute(request, new URL(request.url), db, {},
      session === undefined ? { accountId, mode: 'normal' } : session,
      deps ?? (external ? { externalReferences: true } : {}));
    return { response, body: await response.json() };
  }
  return { sqlite, db, event, call, statements };
}

test('window full counts use inclusive event boundaries and exclude future/older events without changing lifetime', async t => {
  const { sqlite, db, event, call } = fixture(t);
  event('one', NOW - 7 * DAY - 1);
  event('one', NOW - 7 * DAY);
  event('one', NOW - 7 * DAY + 1);
  event('one', NOW);
  event('one', NOW + 1);
  event('two', NOW - 2 * DAY);
  db.readOnly = true;
  const before = sqlite.prepare('SELECT * FROM Member_Song_Plays ORDER BY song_id').all();
  const result = await call('?days=7&limit=1');
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(result.body.data.window, { days: 7, from: NOW - 7 * DAY, to: NOW });
  assert.deepEqual(result.body.data.songs.map(s => [s.id, s.play_count, s.last_played_at]), [['one', 3, NOW]]);
  assert.deepEqual(result.body.data.playCounts, { one: 3, two: 1 });
  assert.equal(result.body.data.totalPlays, 4);
  assert.equal(result.body.data.totalUniqueSongs, 2);
  assert.deepEqual(sqlite.prepare('SELECT * FROM Member_Song_Plays ORDER BY song_id').all(), before);
  const lifetime = await call('?limit=1');
  assert.equal(lifetime.body.data.window, undefined);
  assert.equal(lifetime.body.data.songs[0].play_count, 5);
  assert.equal(lifetime.body.data.totalPlays, 6);
});

test('one-day, seven-day and lifetime rankings are distinct real event aggregates', async t => {
  const { event, call } = fixture(t);
  for (let i = 0; i < 8; i++) event('one', NOW - 20 * DAY + i);
  for (let i = 0; i < 4; i++) event('two', NOW - 3 * DAY + i);
  for (let i = 0; i < 2; i++) event('three', NOW - 1000 + i);
  assert.equal((await call('?limit=1')).body.data.songs[0].id, 'one');
  const week = (await call('?days=7&view=summary')).body.data;
  const day = (await call('?days=1&view=summary')).body.data;
  assert.deepEqual(week.songs.map(s => [s.id, s.play_count]), [['two', 4], ['three', 2]]);
  assert.deepEqual(day.songs.map(s => [s.id, s.play_count]), [['three', 2]]);
  assert.equal(week.playCounts, undefined);
  assert.equal(week.totalPlays, undefined);
  assert.equal(week.view, 'summary');
});

test('summary stays bounded and does not read the unlimited count map; full counts still cover all window songs', async t => {
  const { sqlite, event, call, statements } = fixture(t);
  const insert = sqlite.prepare('INSERT INTO Songs(id,title,audio_url) VALUES (?,?,?)');
  for (let i = 0; i < 55; i++) {
    const id = `many-${String(i).padStart(2, '0')}`;
    insert.run(id, id, '/media/' + id);
    event(id, NOW - i);
  }
  statements.length = 0;
  const summary = (await call('?days=30&view=summary&limit=999')).body.data;
  assert.equal(summary.songs.length, 50);
  assert.equal(summary.playCounts, undefined);
  assert.equal(statements.filter(sql => /WITH window_plays/.test(sql)).length, 1);
  const full = (await call('?days=30&limit=1')).body.data;
  assert.equal(full.songs.length, 1);
  assert.equal(Object.keys(full.playCounts).length, 55);
  assert.equal(full.totalPlays, 55);
  assert.equal(full.totalUniqueSongs, 55);
});

test('days accepts only one canonical integer in 1..30 and keeps normal error envelopes', async t => {
  const { call } = fixture(t);
  for (const value of ['', '0', '31', '-1', '1.0', '01', '7e0', 'Infinity', '7%20', '%207', '7&days=1', '7&days=7']) {
    const result = await call('?days=' + value);
    assert.equal(result.response.status, 400, value);
    assert.equal(result.body.error, 'INVALID_QUERY', value);
    assert.equal(result.body.ok, false, value);
  }
  for (const days of [1, 7, 30]) {
    const result = await call('?days=' + days);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.window.days, days);
    assert.equal(result.body.data.totalPlays, 0);
  }
});

test('window reads use the verified account and retain auth/context protections', async t => {
  const { db, event, call } = fixture(t);
  event('one', NOW - 1, 'A');
  for (let i = 0; i < 9; i++) event('two', NOW - i, 'B');
  db.readOnly = true;
  const a = await call('?days=7&accountId=B');
  assert.deepEqual(a.body.data.playCounts, { one: 1 });
  const b = await call('?days=7', { accountId: 'B' });
  assert.deepEqual(b.body.data.playCounts, { two: 9 });
  assert.equal((await call('?days=7', { session: null })).response.status, 401);
  assert.equal((await call('?days=7', { session: { accountId: 'A', mode: 'must_change_password' } })).response.status, 401);
  assert.equal((await call('?days=7', { headers: { 'X-FlareTune-Expected-Account': 'B' } })).response.status, 409);
});

test('window statistics merge local and external events using each accounts own metadata and no signed URLs', async t => {
  const { db, event, call } = fixture(t, { external: true });
  event('one', NOW - 500);
  event(YT, NOW - 400);
  event(YT, NOW - 300);
  event(YT, NOW - 10 * DAY);
  for (let i = 0; i < 9; i++) event(YT, NOW - i, 'B');
  db.readOnly = true;
  const a = await call('?days=7');
  assert.equal(a.response.status, 200);
  assert.deepEqual(a.body.data.songs.map(s => [s.id, s.title, s.play_count]), [[YT, 'Private A version', 2], ['one', 'One', 1]]);
  assert.deepEqual(a.body.data.playCounts, { one: 1, [YT]: 2 });
  assert.equal(a.body.data.totalPlays, 3);
  assert.equal(a.body.data.songs[0].audio_url, '/media/youtube/audio/' + YT.slice(3));
  assert.doesNotMatch(JSON.stringify(a.body), /Private B|private\.googlevideo/);
  const b = await call('?days=1', { accountId: 'B' });
  assert.deepEqual(b.body.data.songs.map(s => [s.id, s.title, s.play_count]), [[YT, 'Private B version', 9]]);
  const summary = await call('?days=7&view=summary&limit=1');
  assert.equal(summary.body.data.songs.length, 1);
  assert.equal(summary.body.data.playCounts, undefined);
  assert.equal((await call()).body.data.playCounts[YT], 3);
});

test('local-only legacy schema and external-disabled gate retain their existing behavior', async t => {
  const { db, event, call } = fixture(t, { hotpaths: false });
  event('one', NOW - 1);
  db.readOnly = true;
  assert.deepEqual((await call('?days=7')).body.data.playCounts, { one: 1 });
  assert.deepEqual((await call()).body.data.playCounts, { one: 1 });
});

test('external references remain excluded when the existing external capability gate is disabled', async t => {
  const { event, call } = fixture(t, { external: true });
  event('one', NOW - 1);
  event(YT, NOW - 1);
  const result = await call('?days=7', { deps: {} });
  assert.deepEqual(result.body.data.playCounts, { one: 1 });
  assert.equal(result.body.data.songs[0].id, 'one');
});

test('partial external schemas fail explicitly rather than silently dropping the external bucket', async t => {
  const { sqlite, event, call } = fixture(t, { external: true });
  event('one', NOW - 1);
  sqlite.exec('DROP VIEW Member_All_Play_Events');
  const result = await call('?days=7');
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, 'EXTERNAL_MUSIC_SCHEMA_INCOMPLETE');
});

test('ties have stable song identity ordering and empty windows stay genuinely empty', async t => {
  const { event, call } = fixture(t);
  event('two', NOW - 2 * DAY);
  event('one', NOW - 2 * DAY);
  assert.deepEqual((await call('?days=7')).body.data.songs.map(s => s.id), ['one', 'two']);
  const empty = (await call('?days=1')).body.data;
  assert.deepEqual(empty.songs, []);
  assert.deepEqual(empty.playCounts, {});
  assert.equal(empty.totalUniqueSongs, 0);
  assert.equal(empty.totalPlays, 0);
});
