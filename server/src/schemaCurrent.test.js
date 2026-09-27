import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('canonical music schema and forward cleanup exclude retired AI state', () => {
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../db/migrations/0021_drop_retired_music_ai_state.sql', import.meta.url), 'utf8');
  const songMigration = readFileSync(new URL('../db/migrations/0022_drop_retired_song_lyric_flags.sql', import.meta.url), 'utf8');

  assert.doesNotMatch(schema, /\bSong_Reviews\b/);
  assert.doesNotMatch(schema, /\brate_limits\b/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS AI_Assistants/);
  assert.match(migration, /DROP TABLE IF EXISTS Song_Reviews/);
  assert.match(migration, /DROP TABLE IF EXISTS rate_limits/);
  assert.match(migration, /DELETE FROM AI_Assistants WHERE id = 'xiaoa'/);
  assert.doesNotMatch(schema, /\bhas_lyrics\b|\bneeds_translation\b/);
  assert.match(songMigration, /DROP COLUMN has_lyrics/);
  assert.match(songMigration, /DROP COLUMN needs_translation/);
});

test('retired song lyric flag migration preserves current song data', () => {
  const migration = readFileSync(new URL('../db/migrations/0022_drop_retired_song_lyric_flags.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE Songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        has_lyrics INTEGER DEFAULT 1,
        needs_translation INTEGER NOT NULL DEFAULT 0,
        requires_login INTEGER NOT NULL DEFAULT 0,
        language TEXT DEFAULT NULL
      );
      INSERT INTO Songs VALUES ('song-1', 'Current Song', 1, 1, 1, 'ja');
    `);
    db.exec(migration);
    assert.deepEqual(
      db.prepare('PRAGMA table_info(Songs)').all().map((column) => column.name),
      ['id', 'title', 'requires_login', 'language'],
    );
    assert.deepEqual({ ...db.prepare('SELECT * FROM Songs').get() }, {
      id: 'song-1',
      title: 'Current Song',
      requires_login: 1,
      language: 'ja',
    });
  } finally {
    db.close();
  }
});

test('canonical schema and seed bootstrap without retired song or playlist visibility fields', () => {
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const seed = readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema);
    db.exec(seed);
    const columns = db.prepare('PRAGMA table_info(Songs)').all().map((column) => column.name);
    assert.deepEqual(columns, [
      'id', 'title', 'artist', 'album', 'duration', 'audio_url', 'cover_url',
      'language', 'created_at',
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('Playlists') WHERE name='requires_login'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM music_assistant_configs WHERE id='xiaoa'").get().count, 1);
    assert.equal(db.prepare("SELECT model FROM music_assistant_configs WHERE id='xiaoa'").get().model, 'deepseek-v4-flash');
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM Songs').get().count > 0);
  } finally {
    db.close();
  }
});

test('play statistics event receipt migration matches the canonical schema', () => {
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../db/migrations/0024_member_play_events.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE Songs (id TEXT PRIMARY KEY);
      CREATE TABLE Member_Song_Plays (
        user_sub TEXT NOT NULL,
        song_id TEXT NOT NULL,
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at INTEGER NOT NULL,
        PRIMARY KEY (user_sub, song_id)
      );
      INSERT INTO Songs(id) VALUES ('song-1');
    `);
    db.exec(migration);
    const columns = db.prepare('PRAGMA table_info(Member_Play_Events)').all();
    assert.deepEqual(columns.map((column) => column.name), [
      'user_sub', 'event_id', 'song_id', 'played_at', 'received_at',
    ]);
    assert.deepEqual(
      columns.filter((column) => column.pk > 0).map((column) => column.name),
      ['user_sub', 'event_id'],
    );
    assert.match(schema, /CREATE TABLE IF NOT EXISTS Member_Play_Events/);
    assert.match(schema, /PRIMARY KEY \(user_sub, event_id\)/);
    assert.match(schema, /idx_member_play_events_received/);
    assert.match(schema, /CREATE TRIGGER IF NOT EXISTS trg_member_play_events_apply/);

    db.prepare(`
      INSERT INTO Member_Play_Events(user_sub, event_id, song_id, played_at, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('account-a', 'event-1', 'song-1', 1234, 1234);
    assert.deepEqual({ ...db.prepare(`
      SELECT user_sub, song_id, play_count, last_played_at FROM Member_Song_Plays
    `).get() }, {
      user_sub: 'account-a',
      song_id: 'song-1',
      play_count: 1,
      last_played_at: 1234,
    });
  } finally {
    db.close();
  }
});

test('canonical schema does not create the withdrawn lyric override patch', () => {
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(schema, /\bLyric_Overrides\b/);
  assert.throws(
    () => readFileSync(new URL('../migrations/0025_lyric_overrides.sql', import.meta.url), 'utf8'),
    { code: 'ENOENT' },
  );
});

test('retired AI state migration drops only retired tables and the source-catalog XiaoA row', () => {
  const migration = readFileSync(new URL('../db/migrations/0021_drop_retired_music_ai_state.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE Song_Reviews (song_id TEXT PRIMARY KEY);
      CREATE TABLE rate_limits (ip TEXT, action TEXT);
      CREATE TABLE AI_Assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO Song_Reviews VALUES ('song-1');
      INSERT INTO rate_limits VALUES ('127.0.0.1', 'xiaoa_continuation_nonce');
      INSERT INTO AI_Assistants VALUES ('xiaoa', '旧小A');
      INSERT INTO AI_Assistants VALUES ('lyric_translator', '歌词翻译助手');
    `);
    db.exec(migration);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('Song_Reviews','rate_limits')").get().count, 0);
    assert.deepEqual(db.prepare('SELECT id FROM AI_Assistants ORDER BY id').all().map((row) => row.id), ['lyric_translator']);
  } finally {
    db.close();
  }
});
