-- Migration number: 0016 2026-08-26T00:00:00.000Z
CREATE TABLE IF NOT EXISTS Member_Playlists (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('favorite', 'regular')),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_playlists_owner_favorite
ON Member_Playlists(user_sub) WHERE kind = 'favorite';

CREATE INDEX IF NOT EXISTS idx_member_playlists_owner_created
ON Member_Playlists(user_sub, created_at, id);

CREATE TABLE IF NOT EXISTS Member_Playlist_Songs (
    playlist_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id),
    FOREIGN KEY (playlist_id) REFERENCES Member_Playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_playlist_songs_order
ON Member_Playlist_Songs(playlist_id, sort_order, song_id);

CREATE INDEX IF NOT EXISTS idx_member_playlist_songs_song
ON Member_Playlist_Songs(song_id, playlist_id);

CREATE TABLE IF NOT EXISTS Member_Playlist_Shelf (
    user_sub TEXT PRIMARY KEY,
    items_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at INTEGER NOT NULL
);
