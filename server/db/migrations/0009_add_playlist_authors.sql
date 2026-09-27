-- Persist the real curator of each public playlist.
ALTER TABLE Playlists ADD COLUMN author TEXT NOT NULL DEFAULT '谭';

UPDATE Playlists
SET author = CASE
  WHEN id = 'playlist_003' THEN '司'
  ELSE '谭'
END;
