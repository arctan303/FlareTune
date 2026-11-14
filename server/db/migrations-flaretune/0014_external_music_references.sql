-- Account-owned external references only. Never import YouTube media or tracks
-- into Songs; the base v2 schema and migration ledger remain unchanged.
CREATE TABLE IF NOT EXISTS Member_External_Songs (
    account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    song_id TEXT NOT NULL CHECK (length(song_id) = 14 AND substr(song_id,1,3) = 'yt:'),
    source TEXT NOT NULL CHECK (source = 'youtube'),
    source_id TEXT NOT NULL CHECK (length(source_id) = 11 AND song_id = 'yt:' || source_id),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, song_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_playlist_identity ON Member_Playlists(id, account_id);
CREATE TABLE IF NOT EXISTS Member_External_Playlist_Songs (
    playlist_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id),
    FOREIGN KEY (playlist_id, account_id) REFERENCES Member_Playlists(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, song_id) REFERENCES Member_External_Songs(account_id, song_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_external_playlist_order ON Member_External_Playlist_Songs(playlist_id, sort_order, song_id);
CREATE INDEX IF NOT EXISTS idx_external_playlist_preview ON Member_External_Playlist_Songs(playlist_id, added_at DESC, sort_order DESC, song_id);
CREATE TABLE IF NOT EXISTS Member_External_Song_Plays (
    account_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 1 CHECK (play_count >= 1),
    last_played_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, song_id),
    FOREIGN KEY (account_id, song_id) REFERENCES Member_External_Songs(account_id, song_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_external_song_plays_rank ON Member_External_Song_Plays(account_id, play_count DESC, last_played_at DESC);
CREATE TABLE IF NOT EXISTS Member_External_Play_Events (
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, event_id),
    FOREIGN KEY (account_id, song_id) REFERENCES Member_External_Songs(account_id, song_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_external_play_events_received ON Member_External_Play_Events(account_id, received_at);
CREATE VIEW IF NOT EXISTS Member_All_Playlist_Songs AS
    SELECT ps.playlist_id,p.account_id,ps.song_id,ps.sort_order,ps.added_at,'local' AS source
    FROM Member_Playlist_Songs ps JOIN Member_Playlists p ON p.id=ps.playlist_id
    UNION ALL
    SELECT playlist_id,account_id,song_id,sort_order,added_at,'youtube' AS source FROM Member_External_Playlist_Songs;
CREATE VIEW IF NOT EXISTS Member_All_Song_Plays AS
    SELECT account_id,song_id,play_count,last_played_at,'local' AS source FROM Member_Song_Plays
    UNION ALL SELECT account_id,song_id,play_count,last_played_at,'youtube' AS source FROM Member_External_Song_Plays;
CREATE VIEW IF NOT EXISTS Member_All_Play_Events AS
    SELECT account_id,event_id,song_id,played_at,received_at,'local' AS source FROM Member_Play_Events
    UNION ALL SELECT account_id,event_id,song_id,played_at,received_at,'youtube' AS source FROM Member_External_Play_Events;
CREATE TRIGGER IF NOT EXISTS ft_external_playlist_insert_count AFTER INSERT ON Member_External_Playlist_Songs BEGIN
    UPDATE Member_Playlists SET cached_song_count=cached_song_count+1 WHERE id=NEW.playlist_id;
END;
CREATE TRIGGER IF NOT EXISTS ft_external_playlist_delete_count AFTER DELETE ON Member_External_Playlist_Songs BEGIN
    UPDATE Member_Playlists SET cached_song_count=cached_song_count-1 WHERE id=OLD.playlist_id;
END;
CREATE TRIGGER IF NOT EXISTS ft_external_playlist_move_count AFTER UPDATE OF playlist_id ON Member_External_Playlist_Songs
WHEN OLD.playlist_id<>NEW.playlist_id BEGIN
    UPDATE Member_Playlists SET cached_song_count=cached_song_count-1 WHERE id=OLD.playlist_id;
    UPDATE Member_Playlists SET cached_song_count=cached_song_count+1 WHERE id=NEW.playlist_id;
END;
CREATE TRIGGER IF NOT EXISTS ft_music_local_event_unique BEFORE INSERT ON Member_Play_Events
WHEN EXISTS(SELECT 1 FROM Member_External_Play_Events WHERE account_id=NEW.account_id AND event_id=NEW.event_id) BEGIN
    SELECT RAISE(IGNORE);
END;
CREATE TRIGGER IF NOT EXISTS ft_music_external_event_unique BEFORE INSERT ON Member_External_Play_Events
WHEN EXISTS(SELECT 1 FROM Member_Play_Events WHERE account_id=NEW.account_id AND event_id=NEW.event_id) BEGIN
    SELECT RAISE(IGNORE);
END;
CREATE TRIGGER IF NOT EXISTS ft_external_play_apply AFTER INSERT ON Member_External_Play_Events BEGIN
    INSERT INTO Member_External_Song_Plays(account_id,song_id,play_count,last_played_at)
    VALUES(NEW.account_id,NEW.song_id,1,NEW.played_at)
    ON CONFLICT(account_id,song_id) DO UPDATE SET play_count=play_count+1,
      last_played_at=MAX(last_played_at,excluded.last_played_at);
END;
CREATE TRIGGER IF NOT EXISTS ft_external_receipts_insert_count AFTER INSERT ON Member_External_Play_Events BEGIN
    INSERT INTO Member_Play_Receipt_Counts(account_id,receipt_count) VALUES(NEW.account_id,1)
    ON CONFLICT(account_id) DO UPDATE SET receipt_count=receipt_count+1;
END;
CREATE TRIGGER IF NOT EXISTS ft_external_receipts_delete_count AFTER DELETE ON Member_External_Play_Events BEGIN
    UPDATE Member_Play_Receipt_Counts SET receipt_count=receipt_count-1 WHERE account_id=OLD.account_id;
END;
CREATE TRIGGER IF NOT EXISTS ft_external_receipts_move_count AFTER UPDATE OF account_id ON Member_External_Play_Events
WHEN OLD.account_id<>NEW.account_id BEGIN
    UPDATE Member_Play_Receipt_Counts SET receipt_count=receipt_count-1 WHERE account_id=OLD.account_id;
    INSERT INTO Member_Play_Receipt_Counts(account_id,receipt_count) VALUES(NEW.account_id,1)
    ON CONFLICT(account_id) DO UPDATE SET receipt_count=receipt_count+1;
END;
-- Idempotent repair also restores totals when 0013 needs reinstallation.
UPDATE Member_Playlists SET cached_song_count=(SELECT COUNT(*) FROM Member_All_Playlist_Songs WHERE playlist_id=Member_Playlists.id);
INSERT INTO Member_Play_Receipt_Counts(account_id,receipt_count)
SELECT a.account_id,COUNT(e.event_id) FROM accounts a LEFT JOIN Member_All_Play_Events e ON e.account_id=a.account_id GROUP BY a.account_id
ON CONFLICT(account_id) DO UPDATE SET receipt_count=excluded.receipt_count;
