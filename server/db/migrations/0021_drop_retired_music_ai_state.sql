-- Remove music-database state that has no current runtime producer or consumer.
-- Public XiaoA configuration lives in ACCOUNT_DB; AI_Assistants remains for lyric_translator.
DROP TABLE IF EXISTS Song_Reviews;
DROP TABLE IF EXISTS rate_limits;
DELETE FROM AI_Assistants WHERE id = 'xiaoa';
