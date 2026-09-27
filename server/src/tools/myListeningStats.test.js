import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { myListeningStatsTool } from './myListeningStats.js';
import { executeTool } from './index.js';

const createDb = () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE Songs (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration INTEGER, audio_url TEXT, cover_url TEXT,
      language TEXT DEFAULT NULL
    );
    CREATE TABLE Member_Song_Plays (
      user_sub TEXT, song_id TEXT, play_count INTEGER, last_played_at INTEGER
    );
    INSERT INTO Songs (id, title, artist, album, duration, audio_url, cover_url, language) VALUES
      ('s-1', 'Favourite One', 'Artist A', 'Album A', 200, 'audio/s-1.mp3', 'cover/s-1.jpg', 'zh'),
      ('s-2', 'Favourite Two', 'Artist B', 'Album B', 210, 'audio/s-2.mp3', 'cover/s-2.jpg', 'en'),
      ('s-3', 'Favourite Three', 'Artist C', 'Album C', 220, 'audio/s-3.mp3', NULL, NULL);
    INSERT INTO Member_Song_Plays (user_sub, song_id, play_count, last_played_at) VALUES
      ('member-test', 's-1', 9, 300),
      ('member-test', 's-2', 4, 200),
      ('member-test', 's-3', 1, 100),
      ('other-member', 's-2', 77, 999);
  `);
  return {
    sqlite,
    db: {
      prepare: (statement) => {
        const prepared = sqlite.prepare(statement);
        return {
          bind: (...values) => ({
            all: async () => ({ results: prepared.all(...values) }),
            first: async () => prepared.get(...values),
          }),
        };
      },
      batch: async () => [],
    },
  };
};

test('my_listening_stats returns the signed-in listener top songs as tool data', async () => {
  const { sqlite, db } = createDb();
  const res = await executeTool('my_listening_stats', {}, { db, user: { subject: 'member-test' } });

  assert.equal(res.eventData.ok, true);
  assert.equal(res.eventData.type, 'music_cards');
  assert.deepEqual(Object.keys(res.eventData.songs[0]), [
    'id', 'title', 'artist', 'album', 'duration', 'audio_url', 'cover_url', 'language',
  ]);
  assert.deepEqual(res.eventData.songs.map((song) => song.id), ['s-1', 's-2', 's-3']);
  assert.equal(res.eventData.songs.length, 3);
  assert.equal(res.eventData.total_plays, 14);
  assert.equal(res.eventData.total_unique_songs, 3);
  assert.equal(res.playerAction, null);
  assert.match(res.modelText, /《Favourite One》 - Artist A（播放 9 次）/);
  assert.match(res.modelText, /累计播放 14 次，共 3 首曲目/);
  // 其他账号的播放次数绝不出现
  assert.doesNotMatch(res.modelText, /77/);
  assert.doesNotMatch(JSON.stringify(res.eventData.songs), /s-2.*77/);
  sqlite.close();
});

test('my_listening_stats honours the limit bounds and never reads another member history', async () => {
  const { sqlite, db } = createDb();
  const limited = await executeTool('my_listening_stats', { limit: 2 }, { db, user: { subject: 'member-test' } });
  assert.equal(limited.eventData.songs.length, 2);

  const clamped = await executeTool('my_listening_stats', { limit: 999 }, { db, user: { subject: 'member-test' } });
  assert.equal(clamped.eventData.songs.length, 3);

  const other = await executeTool('my_listening_stats', { limit: 5 }, { db, user: { subject: 'other-member' } });
  assert.deepEqual(other.eventData.songs.map((song) => song.id), ['s-2']);
  assert.match(other.modelText, /（播放 77 次）/);
  sqlite.close();
});

test('my_listening_stats reports an empty history without failing', async () => {
  const { sqlite, db } = createDb();
  const res = await executeTool('my_listening_stats', {}, { db, user: { subject: 'silent-member' } });
  assert.equal(res.eventData.ok, true);
  assert.deepEqual(res.eventData.songs, []);
  assert.match(res.modelText, /还没有可用的收听记录/);
  sqlite.close();
});

test('my_listening_stats fails closed without a login identity or a database', async () => {
  const anonymous = await executeTool('my_listening_stats', {}, { db: { prepare: () => {} }, user: null });
  assert.equal(anonymous.eventData.ok, false);
  assert.equal(anonymous.eventData.error.code, 'authentication_required');
  assert.equal(anonymous.eventData.songs?.length ?? 0, 0);

  const noDb = await executeTool('my_listening_stats', {}, { user: { subject: 'member-test' } });
  assert.equal(noDb.eventData.ok, false);
  assert.equal(noDb.eventData.error.code, 'database_unavailable');

  const brokenDb = await executeTool('my_listening_stats', {}, { db: { prepare: () => { throw new Error('boom'); } }, user: { subject: 'member-test' } });
  assert.equal(brokenDb.eventData.ok, false);
  assert.equal(brokenDb.eventData.error.code, 'database_query_failed');
});

test('my_listening_stats parameter contract stays within 1..50 with a default of 20', () => {
  assert.deepEqual(Object.keys(myListeningStatsTool.parameters.properties), ['limit']);
  assert.equal(myListeningStatsTool.parameters.properties.limit.type, 'integer');
  assert.equal(myListeningStatsTool.parameters.properties.limit.minimum, 1);
  assert.equal(myListeningStatsTool.parameters.properties.limit.maximum, 50);
  assert.equal(myListeningStatsTool.name, 'my_listening_stats');
});
