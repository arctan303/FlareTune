-- FlareTune 5.0 empty-instance baseline. Apply before exposing a new Worker.
-- Never apply this file to the source project's database.

CREATE TABLE ft_instance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    min_worker_schema INTEGER NOT NULL DEFAULT 1 CHECK (min_worker_schema >= 1 AND min_worker_schema <= schema_version),
    initialized_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
INSERT INTO ft_instance (id, schema_version, initialized_at, created_at, updated_at)
VALUES (1, 1, NULL, CAST(unixepoch() * 1000 AS INTEGER), CAST(unixepoch() * 1000 AS INTEGER));

CREATE TABLE ft_migrations (
    version INTEGER PRIMARY KEY CHECK (version >= 1),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    stage TEXT NOT NULL CHECK (stage IN ('baseline', 'expand', 'migrate', 'contract')),
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error_code TEXT,
    CHECK ((state = 'completed' AND completed_at IS NOT NULL AND error_code IS NULL)
        OR (state = 'running' AND completed_at IS NULL AND error_code IS NULL)
        OR (state = 'failed' AND completed_at IS NULL AND error_code IS NOT NULL))
);
-- Checksum is SHA-256 of this file after replacing the 64 hex digits below with zeroes.
INSERT INTO ft_migrations (version, name, checksum, stage, state, started_at, completed_at)
VALUES (1, '0001_baseline.sql', 'b7e91ab45df5adc1389afb58b53bd87e23af85b7d45e7a06e6c931f586737481',
    'baseline', 'completed', CAST(unixepoch() * 1000 AS INTEGER), CAST(unixepoch() * 1000 AS INTEGER));

CREATE TABLE ft_migration_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_token TEXT,
    lease_expires_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    CHECK ((owner_token IS NULL AND lease_expires_at = 0) OR
        (owner_token IS NOT NULL AND length(owner_token) >= 32 AND lease_expires_at > 0))
);
INSERT INTO ft_migration_lock (id) VALUES (1);

CREATE TABLE ft_recovery_audit (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('started', 'succeeded', 'failed')),
    error_code TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
    account_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 64),
    display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 80),
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    disabled_at INTEGER
);
CREATE INDEX idx_accounts_usable_admin ON accounts(role, status);

CREATE TABLE account_credentials (
    account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    kdf TEXT NOT NULL,
    kdf_version INTEGER NOT NULL CHECK (kdf_version >= 1),
    kdf_params_json TEXT NOT NULL CHECK (json_valid(kdf_params_json)),
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    updated_at INTEGER NOT NULL
);
CREATE TABLE account_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('normal', 'must_change_password')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    CHECK (expires_at > created_at)
);
CREATE INDEX idx_account_sessions_owner ON account_sessions(account_id, expires_at);
CREATE INDEX idx_account_sessions_expiry ON account_sessions(expires_at);

CREATE TABLE instance_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
);
CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    actor_account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
    detail_code TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_events_created ON audit_events(created_at DESC);

CREATE TABLE Songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration REAL,
    audio_url TEXT,
    cover_url TEXT,
    language TEXT,
    created_at INTEGER
);
CREATE TABLE Playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    author TEXT NOT NULL DEFAULT 'FlareTune',
    type TEXT,
    has_cover INTEGER NOT NULL DEFAULT 0 CHECK (has_cover IN (0, 1)),
    cover_url TEXT,
    preview_covers TEXT,
    order_index INTEGER,
    created_at INTEGER
);
CREATE TABLE Playlist_Songs (
    playlist_id TEXT NOT NULL REFERENCES Playlists(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES Songs(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id)
);
CREATE INDEX idx_playlist_songs_song_id ON Playlist_Songs(song_id);

CREATE TABLE Member_Playlists (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('favorite', 'regular')),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_member_playlists_favorite ON Member_Playlists(account_id) WHERE kind = 'favorite';
CREATE INDEX idx_member_playlists_owner_created ON Member_Playlists(account_id, created_at, id);
CREATE TABLE Member_Playlist_Songs (
    playlist_id TEXT NOT NULL REFERENCES Member_Playlists(id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES Songs(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id)
);
CREATE INDEX idx_member_playlist_songs_order ON Member_Playlist_Songs(playlist_id, sort_order, song_id);
CREATE INDEX idx_member_playlist_songs_song ON Member_Playlist_Songs(song_id, playlist_id);
CREATE TABLE Member_Playlist_Shelf (
    account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    items_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(items_json)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at INTEGER NOT NULL
);

CREATE TABLE Member_Song_Plays (
    account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    song_id TEXT NOT NULL REFERENCES Songs(id) ON DELETE CASCADE,
    play_count INTEGER NOT NULL DEFAULT 1 CHECK (play_count >= 1),
    last_played_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, song_id)
);
CREATE INDEX idx_member_song_plays_rank ON Member_Song_Plays(account_id, play_count DESC, last_played_at DESC);
CREATE TABLE Member_Play_Events (
    account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    song_id TEXT NOT NULL REFERENCES Songs(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, event_id)
);
CREATE INDEX idx_member_play_events_received ON Member_Play_Events(account_id, received_at);
CREATE TRIGGER trg_member_play_events_apply AFTER INSERT ON Member_Play_Events BEGIN
    INSERT INTO Member_Song_Plays (account_id, song_id, play_count, last_played_at)
    VALUES (NEW.account_id, NEW.song_id, 1, NEW.played_at)
    ON CONFLICT(account_id, song_id) DO UPDATE SET
        play_count = Member_Song_Plays.play_count + 1,
        last_played_at = MAX(Member_Song_Plays.last_played_at, excluded.last_played_at);
END;

CREATE TABLE Lyric_Translations (
    song_id TEXT NOT NULL REFERENCES Songs(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('kugou', 'lrclib')),
    target_lang TEXT NOT NULL DEFAULT 'zh-CN',
    raw_hash TEXT NOT NULL,
    source_language TEXT,
    chinese_ratio REAL,
    translation_lrc TEXT,
    status TEXT NOT NULL CHECK (status IN ('generating', 'cached', 'failed')),
    generation_token TEXT,
    provider TEXT,
    model TEXT,
    prompt_version TEXT NOT NULL,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (song_id, source, target_lang, raw_hash, prompt_version)
);
CREATE INDEX idx_lyric_translations_lookup ON Lyric_Translations(song_id, source, target_lang, raw_hash, prompt_version, status);
CREATE INDEX idx_lyric_translations_latest_cached ON Lyric_Translations(song_id, source, target_lang, prompt_version, status, updated_at DESC);
CREATE TABLE AI_Daily_Usage (
    usage_date TEXT NOT NULL,
    action TEXT NOT NULL,
    generation_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (usage_date, action)
);

CREATE TABLE music_chat_threads (
    account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE music_chat_thread_messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES music_chat_threads(account_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    extra_json TEXT,
    client_message_id TEXT,
    turn_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, sequence)
);
CREATE UNIQUE INDEX idx_music_chat_messages_client_id ON music_chat_thread_messages(account_id, client_message_id)
    WHERE client_message_id IS NOT NULL;
CREATE INDEX idx_music_chat_messages_latest ON music_chat_thread_messages(account_id, sequence DESC);
CREATE TABLE music_chat_turns (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES music_chat_threads(account_id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    reserved_revision INTEGER NOT NULL CHECK (reserved_revision >= 1),
    assistant_id TEXT NOT NULL DEFAULT 'xiaoa',
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    assistant_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (account_id, client_message_id)
);
CREATE INDEX idx_music_chat_turns_status ON music_chat_turns(account_id, status, updated_at DESC);

CREATE TABLE music_assistant_configs (
    id TEXT PRIMARY KEY CHECK (id = 'xiaoa'),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
    avatar_icon TEXT NOT NULL DEFAULT 'bot',
    persona TEXT NOT NULL CHECK (length(trim(persona)) BETWEEN 1 AND 12000),
    welcome_message TEXT NOT NULL CHECK (length(trim(welcome_message)) BETWEEN 1 AND 1000),
    system_rules TEXT NOT NULL CHECK (length(trim(system_rules)) BETWEEN 1 AND 24000),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    temperature REAL NOT NULL DEFAULT 0.7 CHECK (temperature BETWEEN 0 AND 2),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
);
INSERT INTO music_assistant_configs
    (id, name, description, persona, welcome_message, system_rules, provider, model, created_at, updated_at, updated_by)
VALUES
    ('xiaoa', '小A', 'FlareTune 音乐助手', '你是 FlareTune 的音乐助手小A，回答自然、清楚；事实以可信现场和工具结果为准。',
     '你好，我是小A。想听什么？', '不得编造数据库、工具或播放结果；只有实际成功的操作才能声称完成。',
     'deepseek', 'deepseek-chat', CAST(unixepoch() * 1000 AS INTEGER), CAST(unixepoch() * 1000 AS INTEGER), 'baseline');

CREATE TABLE AI_Assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    temperature REAL DEFAULT 0.2,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
INSERT INTO AI_Assistants
    (id, name, provider, model, system_prompt, temperature, created_at, updated_at)
VALUES
    ('lyric_translator', '歌词翻译助手', 'deepseek', 'deepseek-chat',
     '你是一位精通多国语言的音乐歌词翻译专家。将外语歌词译为准确、自然的简体中文，并严格按照请求所需的 JSON 格式输出。',
     0.2, CAST(unixepoch() * 1000 AS INTEGER), CAST(unixepoch() * 1000 AS INTEGER));
CREATE TABLE Artist_Photos (
    artist_name TEXT PRIMARY KEY,
    photo_url TEXT NOT NULL,
    photos TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(photos)),
    source TEXT NOT NULL DEFAULT 'multi',
    width INTEGER,
    height INTEGER,
    data_version INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
