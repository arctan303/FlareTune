import { localizeUnknownArtist, t } from '../i18n/index.js';
import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Loader2 } from 'lucide-react';
import LazyImage from './LazyImage';
import SongActionsMenu from './catalog/SongActionsMenu.jsx';
import { usePlayerStore } from '../store/usePlayerStore';
import { usePageActivity } from '../hooks/usePageActivity.js';

const LazyItem = ({ children, height = 80 }) => {
    const [isVisible, setIsVisible] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                setIsVisible(true);
                observer.disconnect();
            }
        }, { rootMargin: '200px' });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    return <div ref={ref} style={{ minHeight: height }}>{isVisible ? children : null}</div>;
};

export default function TrackRow({
    song,
    songs,
    index,
    variant = 'featured',
    showPlayCount = true,
    currentSong,
    isPlaying,
    playSong,
    isLiked,
    onToggleLiked,
    onInsertNext,
    onRemove,
    onAddToPlaylist,
}) {
    const isDetail = variant === 'detail';
    const active = usePageActivity();
    const isCurrent = currentSong?.id === song.id;
    const isBuffering = usePlayerStore((state) => state.isBuffering);
    const [isMoreOpen, setIsMoreOpen] = useState(false);
    const moreButtonRef = useRef(null);
    const [isPendingLiked, setIsPendingLiked] = useState(false);
    const [isExiting, setIsExiting] = useState(false);
    useEffect(() => {
        if (!active) setIsMoreOpen(false);
    }, [active]);

    const handleRemove = () => {
        setIsMoreOpen(false);
        setIsExiting(true);
        setTimeout(() => {
            onRemove?.(song);
        }, 260);
    };

    const toggleLiked = async (targetSong, event) => {
        if (isPendingLiked) return;
        setIsPendingLiked(true);
        try { await onToggleLiked?.(targetSong, event); }
        finally { setIsPendingLiked(false); }
    };

    const row = (
        <div
            style={isExiting ? { maxHeight: 0, opacity: 0, transform: 'translateX(-24px)', overflow: 'hidden', transition: 'all 260ms cubic-bezier(0.16, 1, 0.3, 1)' } : undefined}
            className={`track-row group relative flex cursor-pointer items-center gap-4 ${isCurrent ? 'is-current' : ''} ${isMoreOpen ? 'is-menu-open z-30' : ''}`}
        >
            <button
                type="button"
                className="track-row__main-action"
                onClick={() => playSong(song, songs)}
                aria-label={t("播放 {p0} - {p1}", { p0: (song.title), p1: (song.artist) })}
            />
            <div className="track-row__state" aria-hidden="true"></div>
            {isDetail && <span className="track-row__number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>}
            <div className={`track-row__cover relative ${isDetail ? 'h-[52px] w-[52px]' : 'h-14 w-14'} flex-shrink-0 overflow-hidden`}>
                <LazyImage
                    src={song.cover_url || '/placeholder-album.svg'}
                    alt={song.title ? t("{p0} - {p1} 专辑封面", { p0: song.title, p1: localizeUnknownArtist(song.artist) }) : t("专辑封面")}
                    className="h-full w-full object-cover"
                />
                {isCurrent && isBuffering ? (
                    <div className="absolute inset-0 z-[3] flex items-center justify-center bg-black/40 backdrop-blur-[1px]" aria-label={t("正在缓冲")}>
                        <Loader2 size={18} className="animate-spin text-white drop-shadow-sm" />
                    </div>
                ) : isCurrent && isPlaying ? (
                    <div className="playing-bars" aria-label={t("正在播放")}>
                        <div></div><div></div><div></div>
                    </div>
                ) : null}
            </div>
            <div className="flex-1 min-w-0">
                <h4 className="track-row__title truncate text-sm font-semibold">{song.title}</h4>
                {isDetail ? (
                    <div className="track-row__meta flex items-center truncate text-sm">
                        <span className="truncate max-w-[50%]">{song.artist}</span>
                        {song.album && (
                            <>
                                <span className="mx-2 opacity-50 text-[10px]">•</span>
                                <span className="track-row__album truncate">{song.album}</span>
                            </>
                        )}
                        {song.play_count != null && song.play_count > 0 && (
                            <>
                                <span className="mx-2 opacity-50 text-[10px]">•</span>
                                <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded-full bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_20%,transparent)]">
                                    {song.play_count}{t("次")}</span>
                            </>
                        )}
                    </div>
                ) : (
                    <div className="flex items-center gap-1.5 mt-1 truncate">
                        <p className="track-row__meta truncate text-xs">{song.artist}</p>
                        {showPlayCount && song.play_count != null && song.play_count > 0 && (
                            <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded-full bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_20%,transparent)]">
                                {song.play_count}{t("次")}</span>
                        )}
                    </div>
                )}
            </div>
            <div className={`track-row__actions ${isDetail ? '' : 'relative z-10'} flex items-center justify-end`}>
                <div className="relative">
                    <button
                        ref={moreButtonRef}
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsMoreOpen((prev) => !prev);
                        }}
                        aria-haspopup="menu"
                        aria-expanded={isMoreOpen}
                        className={`track-row__action opacity-40 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity ${isMoreOpen ? 'text-[var(--accent-strong)] !opacity-100' : ''}`}
                        title={t("歌曲选项")}
                        aria-label={t("歌曲选项：{p0}", { p0: (song.title) })}
                    >
                        <MoreHorizontal size={18} />
                    </button>
                    {isMoreOpen && active && (
                        <SongActionsMenu song={song} anchorRef={moreButtonRef} onClose={() => setIsMoreOpen(false)}
                            isLiked={isLiked} isLikePending={isPendingLiked} onToggleLiked={onToggleLiked ? toggleLiked : undefined}
                            onInsertNext={onInsertNext}
                            onAddToPlaylist={onAddToPlaylist} onRemove={onRemove ? handleRemove : undefined}
                            removeLabel={t("从歌单删除")} />
                    )}
                </div>
            </div>
        </div>
    );

    return <LazyItem height={isDetail ? 64 : 72}>{row}</LazyItem>;
}
