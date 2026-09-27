-- Migration number: 0020 2026-09-05T00:00:00.000Z
-- Current-only chat state machine: discard retired awaiting_client turns while
-- preserving the music_chat_turns columns, constraints, foreign key, and index.
CREATE TABLE music_chat_turns_current (
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

INSERT INTO music_chat_turns_current (
    id,
    user_sub,
    client_message_id,
    base_revision,
    reserved_revision,
    assistant_id,
    site,
    status,
    assistant_message_id,
    created_at,
    updated_at
)
SELECT
    id,
    user_sub,
    client_message_id,
    base_revision,
    reserved_revision,
    assistant_id,
    site,
    status,
    assistant_message_id,
    created_at,
    updated_at
FROM music_chat_turns
WHERE status IN ('running', 'completed', 'failed');

DROP TABLE music_chat_turns;
ALTER TABLE music_chat_turns_current RENAME TO music_chat_turns;

CREATE INDEX idx_music_chat_turns_status
ON music_chat_turns(user_sub, status, updated_at DESC);
