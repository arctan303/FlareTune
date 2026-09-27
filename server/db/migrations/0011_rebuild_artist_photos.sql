-- Migration: 0011_rebuild_artist_photos.sql
-- 重做歌手写真缓存表：淘汰旧 scheme 的脏数据（专辑封面 1200x1200 / QQ 404 死链 / source 标签混乱）
-- 新 schema 增加 photos(JSON 元数据) 与 data_version 版本列，方便未来一次升级。

DROP TABLE IF EXISTS Artist_Photos;

CREATE TABLE Artist_Photos (
    artist_name TEXT PRIMARY KEY,
    photo_url TEXT NOT NULL,
    photos TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'multi',
    width INTEGER,
    height INTEGER,
    data_version INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artist_photos_lookup
ON Artist_Photos (artist_name);
