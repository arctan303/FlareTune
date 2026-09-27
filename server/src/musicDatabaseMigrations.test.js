import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migration = (name) => readFileSync(
  new URL(`../db/migrations-v5/${name}`, import.meta.url),
  'utf8',
);

test('0026 creates music-owned OAuth and assistant state without overwriting administrator edits', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const sql = migration('0026_music_assistant_configuration.sql');
    sqlite.exec(sql);

    const tables = sqlite.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'oauth_client_transactions','oauth_client_sessions','oauth_client_session_claims',
        'oauth_client_session_profiles','music_assistant_configs'
      ) ORDER BY name`).all().map((row) => row.name);
    assert.deepEqual(tables, [
      'music_assistant_configs',
      'oauth_client_session_claims',
      'oauth_client_session_profiles',
      'oauth_client_sessions',
      'oauth_client_transactions',
    ]);

    sqlite.prepare(`INSERT INTO oauth_client_sessions
      (token_hash, provider_sub, email, audience, created_at, expires_at)
      VALUES ('session-1', 'provider-user-1', 'listener@example.test', 'music', 10, 20)`).run();
    sqlite.prepare("INSERT INTO oauth_client_session_claims (token_hash, role) VALUES ('session-1', 'member')").run();
    sqlite.prepare("INSERT INTO oauth_client_session_profiles (token_hash, name) VALUES ('session-1', 'Listener')").run();
    sqlite.prepare("DELETE FROM oauth_client_sessions WHERE token_hash = 'session-1'").run();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM oauth_client_session_claims WHERE token_hash = 'session-1'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM oauth_client_session_profiles WHERE token_hash = 'session-1'").get().count, 0);

    const seeded = sqlite.prepare("SELECT * FROM music_assistant_configs WHERE id = 'xiaoa'").get();
    assert.equal(seeded.provider, 'deepseek');
    assert.equal(seeded.model, 'deepseek-v4-flash');
    assert.equal(seeded.revision, 1);
    assert.ok(seeded.persona.length > 20);
    assert.ok(seeded.system_rules.length > 20);

    sqlite.prepare(`UPDATE music_assistant_configs
      SET description = ?, revision = 2, updated_by = 'admin-test'
      WHERE id = 'xiaoa'`).run('管理员保存的描述');
    sqlite.exec(sql);
    const preserved = sqlite.prepare("SELECT description, revision, updated_by FROM music_assistant_configs WHERE id = 'xiaoa'").get();
    assert.deepEqual({ ...preserved }, { description: '管理员保存的描述', revision: 2, updated_by: 'admin-test' });
  } finally {
    sqlite.close();
  }
});

test('0027 removes retired visibility columns while preserving data, relations, indexes, and foreign keys', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE Songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        audio_url TEXT,
        requires_login INTEGER NOT NULL DEFAULT 0,
        language TEXT,
        created_at INTEGER
      );
      CREATE TABLE Playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        requires_login INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER
      );
      CREATE TABLE Playlist_Songs (
        playlist_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        sort_order INTEGER,
        PRIMARY KEY (playlist_id, song_id),
        FOREIGN KEY (playlist_id) REFERENCES Playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE
      );
      CREATE TABLE Member_Playlists (
        id TEXT PRIMARY KEY,
        owner_sub TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE Member_Playlist_Songs (
        playlist_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, song_id),
        FOREIGN KEY (playlist_id) REFERENCES Member_Playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_songs_language ON Songs(language);
      CREATE INDEX idx_playlists_created ON Playlists(created_at);
      CREATE INDEX idx_playlist_songs_song_id ON Playlist_Songs(song_id);
      CREATE INDEX idx_member_playlists_owner ON Member_Playlists(owner_sub);
      CREATE INDEX idx_member_playlist_songs_song_id ON Member_Playlist_Songs(song_id);
      INSERT INTO Songs VALUES ('song-1', 'Song', 'audio/song-1.mp3', 1, 'en', 10);
      INSERT INTO Playlists VALUES ('playlist-1', 'Playlist', 1, 20);
      INSERT INTO Playlist_Songs VALUES ('playlist-1', 'song-1', 0);
      INSERT INTO Member_Playlists VALUES ('member-playlist-1', 'provider-user-1', 'Private Playlist', 30);
      INSERT INTO Member_Playlist_Songs VALUES ('member-playlist-1', 'song-1', 0);
    `);

    sqlite.exec(migration('0027_drop_retired_visibility_columns.sql'));

    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('Songs') WHERE name = 'requires_login'").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('Playlists') WHERE name = 'requires_login'").get().count, 0);
    assert.deepEqual({ ...sqlite.prepare("SELECT id,title,audio_url,language,created_at FROM Songs WHERE id='song-1'").get() }, {
      id: 'song-1', title: 'Song', audio_url: 'audio/song-1.mp3', language: 'en', created_at: 10,
    });
    assert.deepEqual({ ...sqlite.prepare("SELECT * FROM Playlist_Songs").get() }, {
      playlist_id: 'playlist-1', song_id: 'song-1', sort_order: 0,
    });
    assert.deepEqual({ ...sqlite.prepare("SELECT * FROM Member_Playlists").get() }, {
      id: 'member-playlist-1', owner_sub: 'provider-user-1', name: 'Private Playlist', created_at: 30,
    });
    assert.deepEqual({ ...sqlite.prepare("SELECT * FROM Member_Playlist_Songs").get() }, {
      playlist_id: 'member-playlist-1', song_id: 'song-1', sort_order: 0,
    });
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);

    const indexes = sqlite.prepare(`SELECT name FROM sqlite_master
      WHERE type='index' AND name IN (
        'idx_songs_language','idx_playlists_created','idx_playlist_songs_song_id',
        'idx_member_playlists_owner','idx_member_playlist_songs_song_id'
      )
      ORDER BY name`).all().map((row) => row.name);
    assert.deepEqual(indexes, [
      'idx_member_playlist_songs_song_id',
      'idx_member_playlists_owner',
      'idx_playlist_songs_song_id',
      'idx_playlists_created',
      'idx_songs_language',
    ]);
  } finally {
    sqlite.close();
  }
});
