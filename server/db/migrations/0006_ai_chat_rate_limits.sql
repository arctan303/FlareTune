CREATE TABLE IF NOT EXISTS rate_limits (
    ip TEXT NOT NULL,
    action TEXT NOT NULL,
    minute_count INTEGER NOT NULL DEFAULT 0,
    minute_reset_at INTEGER NOT NULL,
    daily_count INTEGER NOT NULL DEFAULT 0,
    daily_reset_at INTEGER NOT NULL,
    PRIMARY KEY (ip, action)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_daily_reset
ON rate_limits(daily_reset_at);
