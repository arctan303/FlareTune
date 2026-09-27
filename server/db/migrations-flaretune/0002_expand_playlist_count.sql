-- Expand only: the v1 Worker continues to use its computed song_count alias.
-- Existing playlists remain at zero until the new Worker backfills them.
ALTER TABLE Member_Playlists
ADD COLUMN cached_song_count INTEGER NOT NULL DEFAULT 0 CHECK (cached_song_count >= 0);

-- Only the new Worker writes migration progress. This step does not advance
-- ft_instance or ft_migrations; the controlled migration does that later.
CREATE TABLE ft_migration_progress (
    version INTEGER PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'backfill' CHECK (phase IN ('backfill', 'verify')),
    cursor TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TRIGGER ft_member_playlist_songs_insert_count
AFTER INSERT ON Member_Playlist_Songs
BEGIN
    UPDATE Member_Playlists
    SET cached_song_count = (
        SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = NEW.playlist_id
    )
    WHERE id = NEW.playlist_id;
END;

CREATE TRIGGER ft_member_playlist_songs_delete_count
AFTER DELETE ON Member_Playlist_Songs
BEGIN
    UPDATE Member_Playlists
    SET cached_song_count = (
        SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = OLD.playlist_id
    )
    WHERE id = OLD.playlist_id;
END;

CREATE TRIGGER ft_member_playlist_songs_move_count
AFTER UPDATE OF playlist_id, song_id ON Member_Playlist_Songs
BEGIN
    UPDATE Member_Playlists
    SET cached_song_count = (
        SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = OLD.playlist_id
    )
    WHERE id = OLD.playlist_id;
    UPDATE Member_Playlists
    SET cached_song_count = (
        SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = NEW.playlist_id
    )
    WHERE id = NEW.playlist_id;
END;

CREATE TRIGGER ft_member_playlist_owner_count
AFTER UPDATE OF account_id ON Member_Playlists
BEGIN
    UPDATE Member_Playlists
    SET cached_song_count = (
        SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = NEW.id
    )
    WHERE id = NEW.id;
END;
