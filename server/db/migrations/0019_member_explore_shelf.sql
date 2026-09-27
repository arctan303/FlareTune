-- 建立用户个性化曲库探索外显与排序表
CREATE TABLE IF NOT EXISTS Member_Explore_Shelf (
    user_sub TEXT PRIMARY KEY,
    items_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at INTEGER NOT NULL
);
