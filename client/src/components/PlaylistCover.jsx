import { t } from '../i18n/index.js';
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
                    ? t("我的收藏歌单封面")
                    : (playlist?.name ? t("{p0} 歌单封面", { p0: (playlist.name) }) : t("歌单封面"))}
                className="h-full w-full object-cover" />
        </div>
    );
}
