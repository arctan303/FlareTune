import { hydrateSong, resolveCoverUrl } from '../utils.js';

export const PLAYLIST_COVER_FALLBACK = '/placeholder-album.svg';
export const COLLECTION_COVER = '/collection-star.svg';

// Favorites keep their fixed artwork; ordinary personal art has priority.
export const getPlaylistCoverUrls = (playlist, songsMap) => {
    if (!playlist) return [PLAYLIST_COVER_FALLBACK];
    if (playlist.kind === 'favorite' || playlist.type === 'favorite') return [COLLECTION_COVER];
    if (playlist.customCoverUrl?.startsWith('/api/account/images/')) return [playlist.customCoverUrl];
    const preview = playlist.previewCovers || playlist.preview_covers;
    const entries = [
        ...(Array.isArray(preview) ? preview : []),
        ...(playlist.preloadedSongs || playlist.songs || []).map((entry) => {
            const song = typeof entry === 'object' && entry !== null ? entry : songsMap?.get(String(entry));
            return song ? hydrateSong(song)?.cover_url : null;
        }),
    ];
    const first = entries.find((url) => typeof url === 'string' && url && url !== PLAYLIST_COVER_FALLBACK);
    return [first ? resolveCoverUrl(first) : PLAYLIST_COVER_FALLBACK];
};
