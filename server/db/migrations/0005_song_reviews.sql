-- Create Song_Reviews table for caching AI song reviews
CREATE TABLE IF NOT EXISTS Song_Reviews (
    song_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    model_version TEXT,
    created_at INTEGER NOT NULL
);
