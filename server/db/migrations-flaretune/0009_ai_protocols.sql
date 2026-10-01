-- Additive metadata: preserve profile IDs, encrypted keys and assignments.
-- A missing metadata row means the original protocol, never a new default.
CREATE TABLE ai_profile_protocols (
  profile_id TEXT PRIMARY KEY REFERENCES ai_model_profiles(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('deepseek', 'openai', 'anthropic', 'gemini', 'custom')),
  protocol TEXT NOT NULL CHECK (protocol IN ('chat_completions', 'responses', 'anthropic_messages', 'gemini_native')),
  options_json TEXT NOT NULL DEFAULT '{}'
);
