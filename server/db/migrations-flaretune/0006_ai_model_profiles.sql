CREATE TABLE ai_model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'openai', 'gemini', 'compatible')),
  model TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  encrypted_key TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE ai_feature_assignments (
  feature TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES ai_model_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
