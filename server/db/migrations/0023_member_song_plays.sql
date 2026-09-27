-- Migration number: 0023 2026-09-05T00:00:00.000Z
CREATE TABLE IF NOT EXISTS Member_Song_Plays (
    user_sub TEXT NOT NULL,
    song_id TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 1 CHECK (play_count >= 1),
    last_played_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, song_id),
    FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_song_plays_rank
ON Member_Song_Plays(user_sub, play_count DESC, last_played_at DESC);
