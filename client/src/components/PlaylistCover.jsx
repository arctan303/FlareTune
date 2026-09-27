import React from 'react';
import LazyImage from './LazyImage.jsx';
import { getPlaylistCoverUrls, PLAYLIST_COVER_FALLBACK } from '../utils/playlistCover.js';

export { getPlaylistCoverUrls, PLAYLIST_COVER_FALLBACK };

export default function PlaylistCover({ playlist, songsMap }) {
    const coverUrl = getPlaylistCoverUrls(playlist, songsMap)[0];
    return (
        <div className="playlist-cover playlist-cover--single relative aspect-square overflow-hidden rounded-xl bg-[var(--surface-raised)]">
            <LazyImage src={coverUrl} fallback={PLAYLIST_COVER_FALLBACK}
                alt={playlist?.kind === 'favorite' || playlist?.type === 'favorite'
                    ? '我的收藏歌单封面'
                    : (playlist?.name ? `${playlist.name} 歌单封面` : '歌单封面')}
                className="h-full w-full object-cover" />
        </div>
    );
}
