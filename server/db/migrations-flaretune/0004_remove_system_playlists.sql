-- The legacy shared playlist model has no account owner. Keep only personal
-- playlist references in each account's ordering before removing its tables.
UPDATE Member_Playlist_Shelf
SET items_json = (
  SELECT COALESCE(json_group_array(json_object('kind', 'member', 'id', json_extract(item.value, '$.id'))), '[]')
  FROM json_each(Member_Playlist_Shelf.items_json) AS item
  WHERE CASE WHEN item.type = 'object'
    THEN json_extract(item.value, '$.kind') = 'member' AND json_type(item.value, '$.id') = 'text'
    ELSE 0 END
), revision = revision + 1
WHERE EXISTS (
  SELECT 1 FROM json_each(Member_Playlist_Shelf.items_json) AS item
  WHERE CASE WHEN item.type = 'object'
    THEN json_extract(item.value, '$.kind') IS NOT 'member'
      OR json_type(item.value, '$.id') IS NOT 'text'
      OR json_type(item.value, '$.hidden') IS NOT NULL
    ELSE 1 END
);

DROP TABLE IF EXISTS Playlist_Songs;
DROP TABLE IF EXISTS Playlists;
