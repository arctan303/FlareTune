-- Songs.language is the sole current lyric-language contract.
ALTER TABLE Songs DROP COLUMN has_lyrics;
ALTER TABLE Songs DROP COLUMN needs_translation;
