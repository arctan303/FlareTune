-- Keep the collection identity consistent for accounts created before the UI change.
-- Song membership and sort order are untouched.
UPDATE Member_Playlists
SET name = '我的收藏', description = '', revision = revision + 1,
    updated_at = CAST(unixepoch() * 1000 AS INTEGER)
WHERE kind = 'favorite' AND (name <> '我的收藏' OR description <> '');
