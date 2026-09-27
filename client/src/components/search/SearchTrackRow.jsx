import React, { useRef, useState, useEffect } from 'react';
import { MoreHorizontal, Check } from 'lucide-react';
import LazyImage from '../LazyImage';
import SongActionsMenu from '../catalog/SongActionsMenu.jsx';
import { HighlightText } from './HighlightText';
import { getLanguageShortLabel } from '../../constants/language';
import { resolveSongLanguage } from '../../utils/songType';

const LazyItem = ({ children, height = 72 }) => {
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
    }, { rootMargin: '300px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} style={{ minHeight: height }}>{isVisible ? children : null}</div>;
};

export function SearchTrackRow({
  song,
  songs,
  query,
  currentSong,
  isPlaying,
  isActiveNav,
  liked,
  isPendingLiked,
  isPopAnimating,
  isMenuOpen,
  isBulkSelecting,
  isBulkSelected,
  onPlay,
  onToggleLiked,
  onAnimationEnd,
  onAddToPlaylist,
  onToggleBulkSelection,
  onInsertNext,
  onToggleMenu,
  onCloseMenu,
  onFilterArtist,
}) {
  const isCurrent = currentSong?.id === song.id;
  const songLang = resolveSongLanguage(song);
  const moreButtonRef = useRef(null);

  return (
    <LazyItem height={72}>
      <div
        className={`track-row group relative flex cursor-pointer items-center gap-4 ${isCurrent ? 'is-current' : ''} ${isMenuOpen ? 'is-menu-open z-30' : ''} ${isActiveNav ? 'is-active-nav' : ''}`}
      >
        <button
          type="button"
          className="track-row__main-action"
          onClick={(event) => (isBulkSelecting ? onToggleBulkSelection(song, event) : onPlay(song, songs))}
          aria-label={isBulkSelecting
            ? `${isBulkSelected ? '取消选择' : '选择'} ${song.title}`
            : `播放 ${song.title} - ${song.artist}`}
        />
        <div className="track-row__state" aria-hidden="true"></div>
        <div className="track-row__cover relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg">
          <LazyImage
            src={song.cover_url || '/placeholder-album.svg'}
            className="h-full w-full object-cover"
            alt={song.title ? `${song.title} - ${song.artist} 专辑封面` : '专辑封面'}
          />
          {isCurrent && isPlaying ? (
            <div className="playing-bars" aria-label="正在播放">
              <div></div><div></div><div></div>
            </div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <h4 className="track-row__title truncate text-sm font-semibold">
              <HighlightText text={song.title} query={query} />
            </h4>
            {(() => {
              const label = getLanguageShortLabel(songLang);
              let badgeClass = 'search-type-badge search-type-badge--other';
              if (songLang === 'zh') badgeClass = 'search-type-badge search-type-badge--native';
              else if (songLang === 'instrumental') badgeClass = 'search-type-badge search-type-badge--pure';
              else if (songLang === 'en') badgeClass = 'search-type-badge search-type-badge--en';
              else if (songLang === 'ja') badgeClass = 'search-type-badge search-type-badge--ja';
              else if (songLang === 'ko') badgeClass = 'search-type-badge search-type-badge--ko';
              else if (songLang) badgeClass = 'search-type-badge search-type-badge--foreign';

              return (
                <span className={badgeClass}>
                  {label}
                </span>
              );
            })()}
          </div>
          <p className="track-row__meta mt-1 truncate text-xs">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFilterArtist(song.artist);
              }}
              className="hover:text-[var(--accent-strong)] hover:underline transition-colors font-normal"
              title={`按歌手 ${song.artist} 筛选`}
            >
              <HighlightText text={song.artist} query={query} />
            </button>
            {song.album ? (
              <span>
                {' · '}
                <HighlightText text={song.album} query={query} />
              </span>
            ) : null}
          </p>
        </div>
        <div className="track-row__actions relative z-10 flex items-center justify-end gap-1">
          {isBulkSelecting && (
            <button
              type="button"
              onClick={(event) => onToggleBulkSelection(song, event)}
              aria-pressed={isBulkSelected}
              aria-label={`${isBulkSelected ? '取消选择' : '选择'} ${song.title}`}
              className={`track-row__action rounded-full border ${isBulkSelected ? 'border-[var(--accent)] bg-[var(--accent)] text-white opacity-100' : 'border-[var(--line)]'}`}
            >
              {isBulkSelected ? <Check size={16} /> : <span className="h-4 w-4" aria-hidden="true" />}
            </button>
          )}
          <div className="relative">
            <button
              ref={moreButtonRef}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleMenu(song.id);
              }}
              className={`track-row__action ${isMenuOpen ? 'text-[var(--accent-strong)] opacity-100' : ''}`}
              title="更多操作"
              aria-label={`更多操作：${song.title}`}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
            >
              <MoreHorizontal size={18} />
            </button>
            {isMenuOpen && (
              <SongActionsMenu song={song} anchorRef={moreButtonRef} onClose={onCloseMenu}
                isLiked={liked} isLikePending={isPendingLiked} onToggleLiked={onToggleLiked}
                onInsertNext={onInsertNext} onAddToPlaylist={onAddToPlaylist} />
            )}
          </div>
        </div>
      </div>
    </LazyItem>
  );
}

export default SearchTrackRow;
