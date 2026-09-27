-- Migration number: 0015 2026-08-24T00:00:00.000Z
CREATE INDEX IF NOT EXISTS idx_playlist_songs_song_id ON Playlist_Songs(song_id);
