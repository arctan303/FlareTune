-- The former deepseek-chat name forces non-thinking mode. Preserve custom model choices.
UPDATE music_assistant_configs
SET model = 'deepseek-flash',
    revision = revision + 1,
    updated_at = CAST(unixepoch() * 1000 AS INTEGER),
    updated_by = 'migration-0003'
WHERE id = 'xiaoa' AND provider = 'deepseek' AND model = 'deepseek-chat';
