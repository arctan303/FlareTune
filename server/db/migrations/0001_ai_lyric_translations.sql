CREATE TABLE IF NOT EXISTS Lyric_Translations (
    song_id TEXT NOT NULL,
    source TEXT NOT NULL,
    target_lang TEXT NOT NULL DEFAULT 'zh-CN',
    raw_hash TEXT NOT NULL,
    source_language TEXT,
    chinese_ratio REAL,
    translation_lrc TEXT,
    status TEXT NOT NULL,
    generation_token TEXT,
    provider TEXT,
    model TEXT,
    prompt_version TEXT NOT NULL,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (song_id, source, target_lang, raw_hash, prompt_version),
    FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE,
    CHECK (source IN ('kugou', 'lrclib')),
    CHECK (status IN ('generating', 'cached', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_lyric_translations_lookup
ON Lyric_Translations (song_id, source, target_lang, raw_hash, prompt_version, status);

CREATE INDEX IF NOT EXISTS idx_lyric_translations_latest_cached
ON Lyric_Translations (
    song_id, source, target_lang, prompt_version, status, updated_at DESC
);

CREATE TABLE IF NOT EXISTS AI_Daily_Usage (
    usage_date TEXT NOT NULL,
    action TEXT NOT NULL,
    generation_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (usage_date, action)
);
