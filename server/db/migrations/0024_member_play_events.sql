-- 为播放统计增加账号级幂等事件回执，支持断网重试与多标签并发
CREATE TABLE IF NOT EXISTS Member_Play_Events (
    user_sub TEXT NOT NULL,
    event_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, event_id)
);

CREATE INDEX IF NOT EXISTS idx_member_play_events_received
ON Member_Play_Events(user_sub, received_at);

CREATE TRIGGER IF NOT EXISTS trg_member_play_events_apply
AFTER INSERT ON Member_Play_Events
BEGIN
    INSERT INTO Member_Song_Plays (user_sub, song_id, play_count, last_played_at)
    VALUES (NEW.user_sub, NEW.song_id, 1, NEW.played_at)
    ON CONFLICT(user_sub, song_id) DO UPDATE SET
        play_count = Member_Song_Plays.play_count + 1,
        last_played_at = MAX(Member_Song_Plays.last_played_at, excluded.last_played_at);
END;
