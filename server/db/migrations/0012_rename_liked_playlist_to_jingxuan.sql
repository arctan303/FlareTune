-- Rename the public 'liked' playlist display name to '精选' (CHANGE-20260823-LIKED-PLAYLIST-SYNC).
-- Applied to the music DB binding (DB) at deploy.
UPDATE Playlists SET name = '精选' WHERE id = 'liked';
