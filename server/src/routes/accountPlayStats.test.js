import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleAccountPlayStatsRoute } from './accountPlayStats.js';

class Statement {
  constructor(owner, sql, values = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new Statement(this.owner, this.sql, values);
  }
  async first() {
    this.owner.queryCount += 1;
    return this.owner.database.prepare(this.sql).get(...this.values) || null;
  }
  async all() {
    this.owner.queryCount += 1;
    return { results: this.owner.database.prepare(this.sql).all(...this.values) };
  }
  async run() {
    this.owner.queryCount += 1;
    const result = this.owner.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

function createDb() {
  const db = {
    database: new DatabaseSync(':memory:'),
    queryCount: 0,
    prepare(sql) {
      return new Statement(this, sql);
    },
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
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration REAL,
      audio_url TEXT,
      cover_url TEXT,
      language TEXT DEFAULT NULL,
      created_at INTEGER
    );
  `);
  db.database.exec(readFileSync(new URL('../../db/migrations/0023_member_song_plays.sql', import.meta.url), 'utf8'));
  db.database.exec(readFileSync(new URL('../../db/migrations/0024_member_play_events.sql', import.meta.url), 'utf8'));
  db.database.exec(`
    INSERT INTO Songs(id, title, artist, duration) VALUES
      ('song-1', 'Track One', 'Artist A', 180),
      ('song-2', 'Track Two', 'Artist B', 210),
      ('song-3', 'Track Three', 'Artist C', 150);
  `);
  return db;
}

function post(db, user, events) {
  const request = new Request('https://example.com/api/account/play-stats', {
    method: 'POST',
    headers: { 'X-Arc-Account-Subject': user?.subject || '' },
    body: JSON.stringify({ events }),
  });
  return handleAccountPlayStatsRoute(request, new URL(request.url), db, {}, user);
}

function event(sequence, songId, playedAt = sequence * 1000) {
  return { event_id: `event_${sequence}`, song_id: songId, played_at: playedAt };
}

test('accountPlayStats: requires authentication', async () => {
  const db = createDb();
  const request = new Request('https://example.com/api/account/play-stats', { method: 'GET' });
  const response = await handleAccountPlayStatsRoute(request, new URL(request.url), db, {}, null);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'AUTH_REQUIRED');
});

test('accountPlayStats: rejects a stale client owner when the authenticated cookie changed', async () => {
  const db = createDb();
  const request = new Request('https://example.com/api/account/play-stats', {
    method: 'POST',
    headers: { 'X-Arc-Account-Subject': 'account-a' },
    body: JSON.stringify({ events: [event(1, 'song-1')] }),
  });
  const response = await handleAccountPlayStatsRoute(
    request,
    new URL(request.url),
    db,
    {},
    { subject: 'account-b' },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'IDENTITY_CHANGED');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM Member_Play_Events').get().count, 0);
});

test('accountPlayStats: records ordered events and ignores missing songs without poisoning retries', async () => {
  const db = createDb();
  const user = { subject: 'user-1' };
  const response = await post(db, user, [
    event(1, 'song-1'),
    event(2, 'song-2'),
    event(3, 'song-2'),
    event(4, 'missing-song'),
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    recorded: 3,
    acceptedEventIds: ['event_1', 'event_2', 'event_3', 'event_4'],
  });

  const getRequest = new Request('https://example.com/api/account/play-stats?limit=10', {
    headers: { 'X-Arc-Account-Subject': user.subject },
  });
  const getResponse = await handleAccountPlayStatsRoute(getRequest, new URL(getRequest.url), db, {}, user);
  const stats = (await getResponse.json()).data;
  assert.equal(stats.totalPlays, 3);
  assert.equal(stats.totalUniqueSongs, 2);
  assert.deepEqual(stats.songs.map((song) => [song.id, song.play_count]), [
    ['song-2', 2],
    ['song-1', 1],
  ]);
  assert.ok(stats.songs.every((song) => !Object.hasOwn(song, 'requires_login')));
});

test('accountPlayStats: a maximum batch stays below the D1 Free per-invocation query budget', async () => {
  const db = createDb();
  const response = await post(
    db,
    { subject: 'query-budget-user' },
    Array.from({ length: 25 }, (_, index) => event(index + 1, 'song-1')),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.recorded, 25);
  assert.equal(db.queryCount, 28);
  assert.ok(db.queryCount <= 50);
});

test('accountPlayStats: retrying or overlapping event IDs never double-counts', async () => {
  const db = createDb();
  const user = { subject: 'user-2' };
  const first = [event(1, 'song-1'), event(2, 'song-1'), event(3, 'song-2')];
  assert.equal((await (await post(db, user, first)).json()).data.recorded, 3);
  assert.equal((await (await post(db, user, first)).json()).data.recorded, 0);

  const overlap = [event(2, 'song-1'), event(3, 'song-2'), event(4, 'song-3')];
  assert.equal((await (await post(db, user, overlap)).json()).data.recorded, 1);

  const getRequest = new Request('https://example.com/api/account/play-stats', {
    headers: { 'X-Arc-Account-Subject': user.subject },
  });
  const stats = (await (await handleAccountPlayStatsRoute(
    getRequest,
    new URL(getRequest.url),
    db,
    {},
    user,
  )).json()).data;
  assert.equal(stats.totalPlays, 4);
  assert.equal(stats.totalUniqueSongs, 3);
});

test('accountPlayStats: event receipts are isolated by account', async () => {
  const db = createDb();
  await post(db, { subject: 'account-a' }, [event(1, 'song-1')]);
  await post(db, { subject: 'account-b' }, [event(1, 'song-2')]);

  const rows = db.database.prepare(`
    SELECT user_sub, song_id, play_count FROM Member_Song_Plays ORDER BY user_sub
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { user_sub: 'account-a', song_id: 'song-1', play_count: 1 },
    { user_sub: 'account-b', song_id: 'song-2', play_count: 1 },
  ]);
});

test('accountPlayStats: rejects malformed and oversized event batches', async () => {
  const db = createDb();
  const user = { subject: 'user-3' };
  assert.equal((await post(db, user, [{ event_id: '', song_id: 'song-1', played_at: 1000 }])).status, 400);
  assert.equal((await post(db, user, [{ event_id: 'bad event id', song_id: 'song-1', played_at: 1000 }])).status, 400);
  assert.equal((await post(
    db,
    user,
    Array.from({ length: 26 }, (_, index) => event(index + 1, 'song-1')),
  )).status, 400);
});

test('accountPlayStats: receipts are bounded per account and missing songs consume no storage', async () => {
  const db = createDb();
  const user = { subject: 'bounded-user' };
  const missingResponse = await post(db, user, [event(1, 'missing-song')]);
  assert.equal(missingResponse.status, 200);
  assert.equal(db.database.prepare(`
    SELECT COUNT(*) AS count FROM Member_Play_Events WHERE user_sub = ?
  `).get(user.subject).count, 0);

  const insert = db.database.prepare(`
    INSERT INTO Member_Play_Events (user_sub, event_id, song_id, played_at, received_at)
    VALUES (?, ?, 'song-1', ?, ?)
  `);
  const now = Date.now();
  db.database.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < 10_000; index += 1) {
      insert.run(user.subject, `budget_${index}`, now + index, now);
    }
    db.database.exec('COMMIT');
  } catch (error) {
    db.database.exec('ROLLBACK');
    throw error;
  }

  const limitedResponse = await post(db, user, [event(2, 'song-2', now)]);
  assert.equal(limitedResponse.status, 429);
  assert.equal((await limitedResponse.json()).error, 'PLAY_EVENT_BUDGET_EXCEEDED');
  assert.equal(db.database.prepare(`
    SELECT COUNT(*) AS count FROM Member_Play_Events WHERE user_sub = ?
  `).get(user.subject).count, 10_000);
});

test('accountPlayStats: expired receipts are cleaned within the documented idempotency window', async () => {
  const db = createDb();
  const user = { subject: 'retention-user' };
  const expiredAt = Date.now() - (31 * 24 * 60 * 60 * 1000);
  db.database.prepare(`
    INSERT INTO Member_Play_Events (user_sub, event_id, song_id, played_at, received_at)
    VALUES (?, 'event_1', 'song-1', 1000, ?)
  `).run(user.subject, expiredAt);

  const response = await post(db, user, [event(1, 'song-1', 2000)]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.recorded, 1);
  assert.equal(db.database.prepare(`
    SELECT COUNT(*) AS count FROM Member_Play_Events WHERE user_sub = ?
  `).get(user.subject).count, 1);
  assert.equal(db.database.prepare(`
    SELECT play_count FROM Member_Song_Plays WHERE user_sub = ? AND song_id = 'song-1'
  `).get(user.subject).play_count, 2);
});
