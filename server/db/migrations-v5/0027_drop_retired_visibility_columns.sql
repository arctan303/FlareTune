-- Tune 5.0 is authenticated globally. Per-song and per-playlist login flags are retired.
ALTER TABLE Songs DROP COLUMN requires_login;
ALTER TABLE Playlists DROP COLUMN requires_login;
