import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { localListeningStatsTool } from './localListeningStats.js';

function baselineDb(extraSongs = 0) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO accounts(account_id, username, role, created_at, updated_at) VALUES
      ('account-a', 'listener-a', 'admin', 1, 1),
      ('account-b', 'listener-b', 'member', 1, 1);
    INSERT INTO Songs(id,title,artist,album,duration,audio_url,cover_url,language) VALUES
      ('song-1','Favourite One','Artist A','Album A',200,'audio/song-1.mp3','cover/song-1.jpg','zh'),
      ('song-2','Shared Song','Artist B','Album B',210,'audio/song-2.mp3','cover/song-2.jpg','en'),
      ('song-3','Another One','Artist C','Album C',220,'audio/song-3.mp3',NULL,NULL);
    INSERT INTO Member_Song_Plays(account_id,song_id,play_count,last_played_at) VALUES
      ('account-a','song-1',9,300),
      ('account-a','song-2',4,200),
      ('account-a','song-3',1,100),
      ('account-b','song-2',77,999);
  `);
  const song = sqlite.prepare('INSERT INTO Songs(id,title) VALUES (?,?)');
  const play = sqlite.prepare(`INSERT INTO Member_Song_Plays(account_id,song_id,play_count,last_played_at)
    VALUES ('account-a',?,1,1)`);
  for (let index = 0; index < extraSongs; index += 1) {
    const id = `extra-${String(index).padStart(2, '0')}`;
    song.run(id, id);
    play.run(id);
  }
  return {
    sqlite,
    db: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        return {
          bind(...values) {
            return {
              all: async () => ({ results: statement.all(...values) }),
              first: async () => statement.get(...values) || null,
            };
          },
        };
      },
    },
  };
}

test('local stats uses session-derived account_id and never includes another account history', async () => {
  const { sqlite, db } = baselineDb();
  try {
    const result = await localListeningStatsTool.execute({}, {
      db, accountId: 'account-a', user: { subject: 'account-b' }, subject: 'account-b',
    });
    assert.equal(result.eventData.ok, true);
    assert.equal(result.eventData.type, 'music_cards');
    assert.equal(Object.hasOwn(result.eventData, 'present'), false);
    assert.deepEqual(result.eventData.songs.map((song) => song.id), ['song-1', 'song-2', 'song-3']);
    assert.equal(result.eventData.total_plays, 14);
    assert.equal(result.eventData.total_unique_songs, 3);
    assert.equal(result.playerAction, null);
    assert.deepEqual(Object.keys(result.eventData.songs[0]), [
      'id', 'title', 'artist', 'album', 'duration', 'audio_url', 'cover_url', 'language',
    ]);
    assert.match(result.modelText, /Favourite One.*播放 9 次/);
    assert.doesNotMatch(result.modelText, /77/);

    const other = await localListeningStatsTool.execute({}, { db, accountId: 'account-b' });
    assert.deepEqual(other.eventData.songs.map((song) => song.id), ['song-2']);
    assert.equal(other.eventData.total_plays, 77);
    assert.equal(other.eventData.total_unique_songs, 1);
  } finally { sqlite.close(); }
});

test('local stats defaults to 20, accepts 1..50, and rejects caller identity and invalid limits', async () => {
  const { sqlite, db } = baselineDb(55);
  try {
    const context = { db, accountId: 'account-a' };
    assert.equal((await localListeningStatsTool.execute({}, context)).eventData.songs.length, 20);
    assert.equal((await localListeningStatsTool.execute({ limit: 1 }, context)).eventData.songs.length, 1);
    const max = await localListeningStatsTool.execute({ limit: 50 }, context);
    assert.equal(max.eventData.songs.length, 50);
    assert.equal(max.eventData.total_unique_songs, 58);
    assert.equal(max.eventData.total_plays, 69);
    for (const args of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: '2' },
      { limit: Number.NaN }, { account_id: 'account-b' }, { user_sub: 'account-b' }, []]) {
      const invalid = await localListeningStatsTool.execute(args, context);
      assert.equal(invalid.eventData.ok, false);
      assert.equal(invalid.eventData.error.code, 'invalid_arguments');
      assert.equal(invalid.eventData.songs?.length ?? 0, 0);
    }
    assert.equal(localListeningStatsTool.parameters.properties.limit.minimum, 1);
    assert.equal(localListeningStatsTool.parameters.properties.limit.maximum, 50);
  } finally { sqlite.close(); }
});

test('local stats handles an empty account and refuses absent session identity', async () => {
  const { sqlite, db } = baselineDb();
  try {
    const empty = await localListeningStatsTool.execute({}, { db, accountId: 'account-c' });
    assert.equal(empty.eventData.ok, true);
    assert.equal(empty.eventData.total_plays, 0);
    assert.equal(empty.eventData.total_unique_songs, 0);
    assert.deepEqual(empty.eventData.songs, []);
    assert.match(empty.modelText, /没有可用的收听记录/);

    const spoofed = await localListeningStatsTool.execute({ limit: 1 }, {
      db, user: { subject: 'account-a' }, subject: 'account-a',
    });
    assert.equal(spoofed.eventData.ok, false);
    assert.equal(spoofed.eventData.error.code, 'authentication_required');
  } finally { sqlite.close(); }
});

test('local stats hides database errors from the model and event payload', async () => {
  const unavailable = await localListeningStatsTool.execute({}, { accountId: 'account-a' });
  assert.equal(unavailable.eventData.error.code, 'database_unavailable');
  const broken = await localListeningStatsTool.execute({}, {
    accountId: 'account-a', db: { prepare() { throw new Error('secret_database_detail'); } },
  });
  assert.equal(broken.eventData.error.code, 'database_query_failed');
  assert.doesNotMatch(JSON.stringify(broken), /secret_database_detail/);
});
