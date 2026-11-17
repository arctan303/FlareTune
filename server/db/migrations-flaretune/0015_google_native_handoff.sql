-- Native client one-time handoff for Google sign-in; base v2 schema remains unchanged.
CREATE TABLE IF NOT EXISTS google_native_handoffs (
    handoff_id TEXT PRIMARY KEY,
    state_hash TEXT NOT NULL UNIQUE,
    code_hash TEXT UNIQUE,
    code_challenge TEXT NOT NULL,
    config_revision INTEGER NOT NULL,
    auth_epoch INTEGER NOT NULL,
    account_id TEXT REFERENCES accounts(account_id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_google_native_handoffs_expiry ON google_native_handoffs(expires_at);
