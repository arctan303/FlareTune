-- Migration number: 0014 2026-08-24T00:00:00.000Z
-- Playlist-level visitor visibility gate. Default: public (0).
-- Admin API may mark a playlist requires_login=1; then anonymous callers
-- must not see it in /api/init lists nor /api/playlists/:id details.
ALTER TABLE Playlists ADD COLUMN requires_login INTEGER NOT NULL DEFAULT 0;
