CREATE TABLE user_images (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('avatar','playlist','chat')),
  object_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 2048),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 2048),
  status TEXT NOT NULL CHECK (status IN ('pending','ready','deleting')),
  created_at INTEGER NOT NULL,
  UNIQUE (id, account_id, purpose)
);
CREATE INDEX idx_user_images_owner ON user_images(account_id, status, created_at);
CREATE TABLE user_image_refs (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('avatar','playlist','chat')),
  target_id TEXT NOT NULL,
  image_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  playlist_id TEXT REFERENCES Member_Playlists(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES music_chat_thread_messages(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, purpose, target_id),
  FOREIGN KEY (image_id, account_id, purpose) REFERENCES user_images(id, account_id, purpose),
  CHECK ((purpose = 'avatar' AND target_id = 'avatar' AND playlist_id IS NULL AND message_id IS NULL)
    OR (purpose = 'playlist' AND target_id = playlist_id AND message_id IS NULL)
    OR (purpose = 'chat' AND message_id IS NOT NULL AND playlist_id IS NULL))
);
CREATE INDEX idx_user_image_refs_image ON user_image_refs(image_id);
CREATE TRIGGER user_image_refs_owner BEFORE INSERT ON user_image_refs
WHEN (NEW.purpose = 'playlist' AND NOT EXISTS
  (SELECT 1 FROM Member_Playlists WHERE id = NEW.playlist_id AND account_id = NEW.account_id AND kind = 'regular'))
  OR (NEW.purpose = 'chat' AND NOT EXISTS
  (SELECT 1 FROM music_chat_thread_messages WHERE id = NEW.message_id AND account_id = NEW.account_id AND role = 'user'))
BEGIN SELECT RAISE(ABORT, 'image_owner_mismatch'); END;
CREATE TRIGGER user_image_refs_insert BEFORE INSERT ON user_image_refs
WHEN NEW.image_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM user_images WHERE id = NEW.image_id AND account_id = NEW.account_id
    AND purpose = NEW.purpose AND status = 'ready')
BEGIN SELECT RAISE(ABORT, 'image_unavailable'); END;
CREATE TRIGGER user_image_refs_update BEFORE UPDATE OF image_id ON user_image_refs
WHEN NEW.image_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM user_images WHERE id = NEW.image_id AND account_id = NEW.account_id
    AND purpose = NEW.purpose AND status = 'ready')
BEGIN SELECT RAISE(ABORT, 'image_unavailable'); END;
