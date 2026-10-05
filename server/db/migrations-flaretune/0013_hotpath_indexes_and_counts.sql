-- Compatible supplemental optimization; existing base schema/ledger stays v2.
CREATE INDEX IF NOT EXISTS idx_member_playlist_preview
ON Member_Playlist_Songs(playlist_id, added_at DESC, sort_order DESC, song_id);
CREATE INDEX IF NOT EXISTS idx_songs_title_artist_id ON Songs(title, artist, id);
CREATE INDEX IF NOT EXISTS idx_songs_title_id ON Songs(title, id, artist);
CREATE INDEX IF NOT EXISTS idx_songs_artist_id ON Songs(artist, id, title);
-- Presence ranks preserve SQLite's NULL-before-empty ordering during keyset paging.
CREATE INDEX IF NOT EXISTS idx_songs_search_order ON Songs(
    LOWER(title),
    CASE WHEN artist IS NULL THEN 0 ELSE 1 END, LOWER(COALESCE(artist, '')), id
) WHERE audio_url IS NOT NULL AND TRIM(audio_url) <> '';
CREATE INDEX IF NOT EXISTS idx_songs_romanized_order ON Songs(
    LOWER(title),
    CASE WHEN artist IS NULL THEN 0 ELSE 1 END, LOWER(COALESCE(artist, '')), id
) WHERE audio_url IS NOT NULL AND TRIM(audio_url) <> ''
    AND (title GLOB '*[ぁ-ゖァ-ヺ]*' OR artist GLOB '*[ぁ-ゖァ-ヺ]*'
      OR album GLOB '*[ぁ-ゖァ-ヺ]*');

-- Repair once before switching maintenance from full recounts to deltas.
UPDATE Member_Playlists SET cached_song_count = (
    SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = Member_Playlists.id
);
DROP TRIGGER IF EXISTS ft_member_playlist_songs_insert_count;
DROP TRIGGER IF EXISTS ft_member_playlist_songs_delete_count;
DROP TRIGGER IF EXISTS ft_member_playlist_songs_move_count;
DROP TRIGGER IF EXISTS ft_member_playlist_owner_count;
CREATE TRIGGER ft_member_playlist_songs_insert_count
AFTER INSERT ON Member_Playlist_Songs BEGIN
    UPDATE Member_Playlists SET cached_song_count = cached_song_count + 1 WHERE id = NEW.playlist_id;
END;
CREATE TRIGGER ft_member_playlist_songs_delete_count
AFTER DELETE ON Member_Playlist_Songs BEGIN
    UPDATE Member_Playlists SET cached_song_count = cached_song_count - 1 WHERE id = OLD.playlist_id;
END;
CREATE TRIGGER ft_member_playlist_songs_move_count
AFTER UPDATE OF playlist_id, song_id ON Member_Playlist_Songs
WHEN OLD.playlist_id <> NEW.playlist_id BEGIN
    UPDATE Member_Playlists SET cached_song_count = cached_song_count - 1 WHERE id = OLD.playlist_id;
    UPDATE Member_Playlists SET cached_song_count = cached_song_count + 1 WHERE id = NEW.playlist_id;
END;
-- Changing an owner never changes membership. Retain the required trigger name.
CREATE TRIGGER ft_member_playlist_owner_count
AFTER UPDATE OF account_id ON Member_Playlists BEGIN
    SELECT 1;
END;

CREATE TABLE IF NOT EXISTS Member_Play_Receipt_Counts (
    account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    receipt_count INTEGER NOT NULL DEFAULT 0 CHECK (receipt_count >= 0)
);
INSERT INTO Member_Play_Receipt_Counts(account_id, receipt_count)
SELECT a.account_id, COUNT(e.event_id) FROM accounts a
LEFT JOIN Member_Play_Events e ON e.account_id = a.account_id GROUP BY a.account_id
ON CONFLICT(account_id) DO UPDATE SET receipt_count = excluded.receipt_count;
DROP TRIGGER IF EXISTS ft_play_receipts_insert_count;
DROP TRIGGER IF EXISTS ft_play_receipts_delete_count;
DROP TRIGGER IF EXISTS ft_play_receipts_move_count;
CREATE TRIGGER ft_play_receipts_insert_count AFTER INSERT ON Member_Play_Events BEGIN
    INSERT INTO Member_Play_Receipt_Counts(account_id, receipt_count) VALUES (NEW.account_id, 1)
    ON CONFLICT(account_id) DO UPDATE SET receipt_count = receipt_count + 1;
END;
CREATE TRIGGER ft_play_receipts_delete_count AFTER DELETE ON Member_Play_Events BEGIN
    UPDATE Member_Play_Receipt_Counts SET receipt_count = receipt_count - 1 WHERE account_id = OLD.account_id;
END;
CREATE TRIGGER ft_play_receipts_move_count AFTER UPDATE OF account_id ON Member_Play_Events
WHEN OLD.account_id <> NEW.account_id BEGIN
    UPDATE Member_Play_Receipt_Counts SET receipt_count = receipt_count - 1 WHERE account_id = OLD.account_id;
    INSERT INTO Member_Play_Receipt_Counts(account_id, receipt_count) VALUES (NEW.account_id, 1)
    ON CONFLICT(account_id) DO UPDATE SET receipt_count = receipt_count + 1;
END;
