-- Migration number: 0017 2026-09-02T00:00:00.000Z
-- Music-site account chat is intentionally isolated from ACCOUNT_DB shared threads.
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
    status TEXT NOT NULL CHECK (status IN ('running', 'awaiting_client', 'completed', 'failed')),
    assistant_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_sub) REFERENCES music_chat_threads(user_sub) ON DELETE CASCADE,
    UNIQUE (user_sub, client_message_id)
);

CREATE INDEX IF NOT EXISTS idx_music_chat_turns_status
ON music_chat_turns(user_sub, status, updated_at DESC);
