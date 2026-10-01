-- Optional Google login. Existing local credentials and account IDs stay intact.
CREATE TABLE google_login_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  client_id TEXT NOT NULL DEFAULT '',
  callback_origin TEXT NOT NULL DEFAULT '',
  encrypted_secret TEXT NOT NULL DEFAULT '',
  secret_iv TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  auth_epoch INTEGER NOT NULL DEFAULT 0
);
INSERT INTO google_login_config (id) VALUES (1);
CREATE TABLE account_google_bindings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL UNIQUE,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE google_login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'bind')),
  config_revision INTEGER NOT NULL,
  auth_epoch INTEGER NOT NULL,
  account_id TEXT REFERENCES accounts(account_id) ON DELETE CASCADE,
  session_hash TEXT,
  password_hash TEXT,
  salt TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_google_transactions_expiry ON google_login_transactions(expires_at);

-- The Google identity is unknown at login start. Any credential/binding change
-- invalidates pending Google logins instance-wide, without revoking other users'
-- established sessions. This also covers disable/re-enable and unlink/relink.
CREATE TRIGGER google_credentials_changed AFTER UPDATE OF password_hash, salt, must_change_password ON account_credentials
BEGIN
  UPDATE google_login_config SET auth_epoch=auth_epoch+1 WHERE id=1;
END;
CREATE TRIGGER google_account_changed AFTER UPDATE OF status ON accounts
BEGIN
  UPDATE google_login_config SET auth_epoch=auth_epoch+1 WHERE id=1;
END;
CREATE TRIGGER google_binding_added AFTER INSERT ON account_google_bindings
BEGIN
  UPDATE google_login_config SET auth_epoch=auth_epoch+1 WHERE id=1;
END;
CREATE TRIGGER google_binding_removed AFTER DELETE ON account_google_bindings
BEGIN
  UPDATE google_login_config SET auth_epoch=auth_epoch+1 WHERE id=1;
END;
