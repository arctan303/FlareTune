-- Separate reusable credential connections from each feature's model settings.
-- Preserve profile IDs, encrypted credentials, assignment revisions and old rows.
CREATE TABLE ai_feature_models (
  feature TEXT PRIMARY KEY REFERENCES ai_feature_assignments(feature) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES ai_model_profiles(id) ON DELETE RESTRICT,
  model TEXT NOT NULL,
  supports_images INTEGER NOT NULL DEFAULT 0 CHECK (supports_images IN (0, 1)),
  options_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO ai_feature_models (feature, provider_id, model, supports_images, options_json)
SELECT a.feature, p.id, p.model,
  CASE WHEN v.value_json = 'true' THEN 1 ELSE 0 END, COALESCE(c.options_json, '{}')
FROM ai_feature_assignments a JOIN ai_model_profiles p ON p.id = a.profile_id
LEFT JOIN ai_profile_protocols c ON c.profile_id = p.id
LEFT JOIN instance_settings v ON v.key = 'ai.images.' || p.id;
