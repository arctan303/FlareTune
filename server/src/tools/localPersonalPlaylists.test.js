import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { localPersonalPlaylistsTool } from './localPersonalPlaylists.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES
      ('account-A','listener-a','member',1,1),
      ('account-B','listener-b','member',1,1);
    INSERT INTO Member_Playlists
      (id,account_id,kind,name,description,revision,created_at,updated_at) VALUES
      ('playlist-A','account-A','regular','A 的歌单','简介',3,1,1),
      ('playlist-B','account-B','regular','B 的歌单','',4,1,1);
    INSERT INTO Songs(id,title,artist,audio_url) VALUES
      ('song-A','A 的歌','甲','/media/audio/a.mp3'),
      ('song-B','B 的歌','乙','/media/audio/b.mp3');
    INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at) VALUES
      ('playlist-A','song-A',0,1),('playlist-B','song-B',0,1);
  `);
  const db = {
    prepare(sql) {
      // The test fails immediately if the supposed read-only tool issues any DML.
      assert.match(sql.trimStart(), /^SELECT\b/i);
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            all: async () => ({ results: statement.all(...values) }),
            first: async () => statement.get(...values) ?? null,
          };
        },
      };
    },
  };
  return { sqlite, db };
}

test('personal playlist tool is SELECT-only and scopes list/read to authenticated account', async () => {
  const { sqlite, db } = fixture();
  try {
    const context = { db, accountId: 'account-A', user_sub: 'account-B' };
    const list = await localPersonalPlaylistsTool.execute({ action: 'list' }, context);
    assert.equal(list.eventData.ok, true);
    assert.deepEqual(list.eventData.playlists.map((item) => item.id), ['playlist-A']);
    assert.deepEqual(list.eventData.songs, []);
    const read = await localPersonalPlaylistsTool.execute({ action: 'read', playlist_id: 'playlist-A' }, context);
    assert.equal(read.eventData.ok, true);
    assert.deepEqual(read.eventData.songs.map((song) => song.id), ['song-A']);
    assert.equal(read.eventData.playlist.songCount, 1);
    assert.equal(read.eventData.playlist.revision, 3);
    assert.equal(read.playerAction, null);
    const other = await localPersonalPlaylistsTool.execute({ action: 'read', playlist_id: 'playlist-B' }, context);
    assert.equal(other.eventData.error.code, 'playlist_not_found');
    assert.doesNotMatch(JSON.stringify(other), /B 的歌单|B 的歌/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM Member_Playlists').get().count, 2);
  } finally { sqlite.close(); }
});

test('personal playlist tool pages exact IDs, rejects identity args and does not create favorite', async () => {
  const { sqlite, db } = fixture();
  try {
    const addSong = sqlite.prepare('INSERT INTO Songs(id,title) VALUES (?,?)');
    const addToPlaylist = sqlite.prepare(`INSERT INTO Member_Playlist_Songs
      (playlist_id,song_id,sort_order,added_at) VALUES ('playlist-A',?,?,1)`);
    for (let index = 1; index <= 55; index += 1) {
      const id = `more-${String(index).padStart(2, '0')}`;
      addSong.run(id, id);
      addToPlaylist.run(id, index);
    }
    const context = { db, accountId: 'account-A' };
    const page = await localPersonalPlaylistsTool.execute({ action: 'read', playlist_id: 'playlist-A',
      limit: 50, offset: 1 }, context);
    assert.equal(page.eventData.playlist.songCount, 56);
    assert.equal(page.eventData.songs.length, 50);
    assert.equal(page.eventData.songs[0].id, 'more-01');
    const last = await localPersonalPlaylistsTool.execute({ action: 'read', playlist_id: 'playlist-A',
      limit: 50, offset: 51 }, context);
    assert.deepEqual(last.eventData.songs.map((song) => song.id),
      ['more-51', 'more-52', 'more-53', 'more-54', 'more-55']);
    for (const args of [
      { action: 'list', account_id: 'account-B' },
      { action: 'read', playlist_id: 'playlist-B', user_sub: 'account-B' },
      { action: 'read', playlist_id: 'playlist-B', limit: 51 },
      { action: 'read', playlist_id: 'playlist-B', offset: -1 },
      { action: 'read', playlist_id: ' playlist-B' },
    ]) {
      assert.equal((await localPersonalPlaylistsTool.execute(args, context)).eventData.error.code,
        'invalid_arguments');
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE kind='favorite'").get().count, 0);
    const empty = await localPersonalPlaylistsTool.execute({}, { db, accountId: 'absent-account' });
    assert.equal(empty.eventData.ok, true);
    assert.deepEqual(empty.eventData.playlists, []);
  } finally { sqlite.close(); }
});

test('personal playlist tool requires session identity and masks database errors', async () => {
  const noSession = await localPersonalPlaylistsTool.execute({}, {
    db: { prepare() { throw new Error('should_not_query'); } }, user_sub: 'account-A',
  });
  assert.equal(noSession.eventData.error.code, 'authentication_required');
  const noDb = await localPersonalPlaylistsTool.execute({}, { accountId: 'account-A' });
  assert.equal(noDb.eventData.error.code, 'database_unavailable');
  const failed = await localPersonalPlaylistsTool.execute({}, {
    accountId: 'account-A', db: { prepare() { throw new Error('sensitive_sql_detail'); } },
  });
  assert.equal(failed.eventData.error.code, 'database_query_failed');
  assert.doesNotMatch(JSON.stringify(failed), /sensitive_sql_detail/);
});

test('personal playlist tool projects the fixed collection identity from legacy rows', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Member_Playlists
      (id,account_id,kind,name,description,revision,created_at,updated_at)
      VALUES ('favorite-A','account-A','favorite','我喜欢','旧简介',0,1,1)`).run();
    const context = { db, accountId: 'account-A' };
    const list = await localPersonalPlaylistsTool.execute({ action: 'list' }, context);
    assert.equal(list.eventData.playlists[0].name, '我的收藏');
    assert.equal(list.eventData.playlists[0].description, '');
    const read = await localPersonalPlaylistsTool.execute({ action: 'read', playlist_id: 'favorite-A' }, context);
    assert.equal(read.eventData.playlist.name, '我的收藏');
    assert.equal(read.eventData.playlist.description, '');
  } finally { sqlite.close(); }
});
