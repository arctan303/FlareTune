-- Migration: 0010_create_artist_photos.sql
-- 歌手写真元数据与 D1 边缘缓存表

CREATE TABLE IF NOT EXISTS Artist_Photos (
    artist_name TEXT PRIMARY KEY,
    photo_url TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'netease',
    width INTEGER DEFAULT 1000,
    height INTEGER DEFAULT 1000,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artist_photos_lookup
ON Artist_Photos (artist_name);
