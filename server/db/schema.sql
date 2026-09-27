DROP TABLE IF EXISTS Member_Playlist_Songs;
DROP TABLE IF EXISTS Member_Playlist_Shelf;
DROP TABLE IF EXISTS Member_Playlists;
DROP TABLE IF EXISTS Playlist_Songs;
DROP TABLE IF EXISTS Playlists;
DROP TABLE IF EXISTS Songs;

CREATE TABLE Songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration REAL,
    audio_url TEXT,
    cover_url TEXT,
    language TEXT DEFAULT NULL,
    created_at INTEGER
);

CREATE TABLE Playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    author TEXT NOT NULL DEFAULT '谭',
    type TEXT,
    has_cover INTEGER DEFAULT 0,
    cover_url TEXT,
    preview_covers TEXT,
    order_index INTEGER,
    created_at INTEGER
);

CREATE TABLE Playlist_Songs (
    playlist_id TEXT,
    song_id TEXT,
    sort_order INTEGER,
    PRIMARY KEY (playlist_id, song_id),
    FOREIGN KEY (playlist_id) REFERENCES Playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_songs_song_id ON Playlist_Songs(song_id);

CREATE TABLE IF NOT EXISTS Member_Playlists (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('favorite', 'regular')),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_playlists_owner_favorite
ON Member_Playlists(user_sub) WHERE kind = 'favorite';

CREATE INDEX IF NOT EXISTS idx_member_playlists_owner_created
ON Member_Playlists(user_sub, created_at, id);

CREATE TABLE IF NOT EXISTS Member_Playlist_Songs (
    playlist_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id),
    FOREIGN KEY (playlist_id) REFERENCES Member_Playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES Songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_playlist_songs_order
ON Member_Playlist_Songs(playlist_id, sort_order, song_id);

CREATE INDEX IF NOT EXISTS idx_member_playlist_songs_song
ON Member_Playlist_Songs(song_id, playlist_id);

CREATE TABLE IF NOT EXISTS Member_Playlist_Shelf (
    user_sub TEXT PRIMARY KEY,
    items_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_client_transactions (
    state_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_transactions_expires
ON oauth_client_transactions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_client_sessions (
    token_hash TEXT PRIMARY KEY,
    provider_sub TEXT NOT NULL,
    email TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'music' CHECK (audience = 'music'),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_sessions_subject
ON oauth_client_sessions(provider_sub, expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_client_sessions_expires
ON oauth_client_sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_client_session_claims (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    FOREIGN KEY (token_hash) REFERENCES oauth_client_sessions(token_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_client_session_claims_role
ON oauth_client_session_claims(role);

CREATE TABLE IF NOT EXISTS oauth_client_session_profiles (
    token_hash TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (token_hash) REFERENCES oauth_client_sessions(token_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS music_assistant_configs (
    id TEXT PRIMARY KEY CHECK (id = 'xiaoa'),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
    avatar_icon TEXT NOT NULL DEFAULT 'bot' CHECK (length(trim(avatar_icon)) BETWEEN 1 AND 80),
    persona TEXT NOT NULL CHECK (length(trim(persona)) BETWEEN 1 AND 12000),
    welcome_message TEXT NOT NULL CHECK (length(trim(welcome_message)) BETWEEN 1 AND 1000),
    system_rules TEXT NOT NULL CHECK (length(trim(system_rules)) BETWEEN 1 AND 24000),
    provider TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 80),
    model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 160),
    temperature REAL NOT NULL DEFAULT 0.7 CHECK (temperature >= 0 AND temperature <= 2),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT 'migration'
);

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

CREATE TABLE IF NOT EXISTS music_chat_threads (
    user_sub TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS music_chat_thread_messages (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    extra_json TEXT,
    client_message_id TEXT,
    turn_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_sub) REFERENCES music_chat_threads(user_sub) ON DELETE CASCADE,
    UNIQUE (user_sub, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_music_chat_messages_client_id
ON music_chat_thread_messages(user_sub, client_message_id)
WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_music_chat_messages_latest
ON music_chat_thread_messages(user_sub, sequence DESC);

CREATE TABLE IF NOT EXISTS music_chat_turns (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    reserved_revision INTEGER NOT NULL CHECK (reserved_revision >= 1),
    assistant_id TEXT NOT NULL DEFAULT 'xiaoa',
    site TEXT NOT NULL DEFAULT 'music' CHECK (site = 'music'),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    assistant_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_sub) REFERENCES music_chat_threads(user_sub) ON DELETE CASCADE,
    UNIQUE (user_sub, client_message_id)
);

CREATE INDEX IF NOT EXISTS idx_music_chat_turns_status
ON music_chat_turns(user_sub, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS AI_Assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    temperature REAL DEFAULT 0.2,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Artist_Photos (
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
