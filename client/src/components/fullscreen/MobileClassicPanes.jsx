import { localizeUnknownArtist, t } from '../../i18n/index.js';
import React from 'react';
import { Star } from 'lucide-react';
import LazyImage from '../LazyImage.jsx';
import LyricsScroller from '../LyricsScroller.jsx';
import PlayerControls from '../PlayerControls.jsx';
import PlayerMoreMenu from '../PlayerMoreMenu.jsx';
import { useFavoriteSongAction } from '../../hooks/useFavoriteSongAction.js';
import { getPrimaryLyricLine, getTranslationLyricLine } from './mobileLyricPreview.js';
import SyncedLyricText from '../lyrics/SyncedLyricText.jsx';
import { useLyricSurfacePresentation } from '../lyrics/lyricSurfacePresentation.js';
import ClassicArtwork from './ClassicArtwork.jsx';

export function MobileLyricsPane({
  coverUrl,
  currentSong,
  isExitingLyrics,
  controlsVisible,
  onExit,
  onWakeControls,
  lyricsScrollerProps,
  playerControlsProps,
  surfaceVisible = true,
}) {
  const wakeUnlessTool = (event) => {
    if (event.target?.closest?.('.classic-lyrics__tools-wrapper, .classic-lyrics__tool')) return;
    if (!controlsVisible) onWakeControls();
  };

  const {
    isFavorite,
    pendingSongIds: pendingFavoriteSongIds,
    justAddedSongIds,
    toggleFavorite,
    clearAddedAnimation,
  } = useFavoriteSongAction();
  const currentSongId = String(currentSong?.id);
  const isInFavorite = isFavorite(currentSong);
  const isPendingFavorite = pendingFavoriteSongIds.has(currentSongId);
  const animateHeart = justAddedSongIds.has(currentSongId);

  return (
    <div className="lg:hidden flex flex-col w-full h-full min-h-0">
      <div className="flex items-center gap-3 w-full pb-2 pt-1 shrink-0 relative">
        <button type="button" onClick={onExit} className="relative w-12 h-12 sm:w-14 sm:h-14 min-w-[48px] min-h-[48px] sm:min-w-[56px] sm:min-h-[56px] rounded-xl overflow-hidden shadow-md flex-shrink-0 active:scale-95 transition-transform group focus:outline-none bg-white/10 animate-mini-cover-pop" title={t("点击返回大封面视图")}>
          <LazyImage src={coverUrl} fallback="/placeholder-album.svg" className="w-full h-full object-cover" />
          <div className="absolute inset-0 ring-1 ring-inset ring-white/15 rounded-xl pointer-events-none" />
        </button>
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="flex items-center justify-between gap-2">
            <div onClick={onExit} className="truncate font-bold text-white text-base sm:text-lg tracking-tight cursor-pointer" title={t("点击返回大封面视图")}>{currentSong?.title || t("未知歌曲")}</div>
            <div className="flex items-center gap-2 shrink-0 relative">
              <button
                type="button"
                aria-label={isInFavorite ? t("移出我的收藏") : t("加入我的收藏")}
                title={isInFavorite ? t("移出我的收藏") : t("加入我的收藏")}
                onClick={(event) => toggleFavorite(currentSong, event)}
                aria-busy={isPendingFavorite}
                className={`h-6 w-6 inline-flex items-center justify-center transition-all hover:scale-110 active:scale-90 focus:outline-none cursor-pointer shrink-0 ${
                  isInFavorite
                    ? 'text-rose-400'
                    : 'text-white/60 hover:text-white'
                } ${isPendingFavorite ? 'animate-heart-pending' : animateHeart ? 'animate-heart-pop' : ''}`}
                onAnimationEnd={() => clearAddedAnimation(currentSong)}
              >
                <Star size={22} fill={isInFavorite && !isPendingFavorite ? 'currentColor' : 'none'} strokeWidth={1.75} />
              </button>
              <PlayerMoreMenu direction="down" showPlayerModes />
            </div>
          </div>
          <div className="truncate text-xs sm:text-sm text-gray-400 font-medium mt-0.5">
            {currentSong?.artist && currentSong?.album ? `${localizeUnknownArtist(currentSong.artist)} — ${currentSong.album}` : (currentSong?.artist ? localizeUnknownArtist(currentSong.artist) : currentSong?.album || t("未知艺术家"))}
          </div>
        </div>
      </div>
      <div className={`classic-lyrics__pane-motion flex-1 min-h-0 w-full overflow-hidden flex flex-col my-0 ${isExitingLyrics ? 'animate-lyrics-slide-out' : 'animate-lyrics-slide-in'}`} onClick={wakeUnlessTool} onTouchStart={wakeUnlessTool}>
        <LyricsScroller {...lyricsScrollerProps} controlsBottomOffset={0} isControlsHidden={!controlsVisible} onWakeControls={onWakeControls} surfaceVisible={surfaceVisible} />
      </div>
      <div className={`mobile-lyrics-controls-container w-full pb-1 sm:pb-1.5 shrink-0 ${!controlsVisible ? 'is-hidden' : ''}`}>
        <PlayerControls {...playerControlsProps} hideMetadata showPlayerModes />
      </div>
    </div>
  );
}

export function MobileSongPane({
  canShowLyrics,
  coverUrl,
  currentLyricIndex,
  hasValidLyrics,
  isBuffering,
  isExpandingToSong,
  isMobile,
  isPlaying,
  lyrics,
  onEnterLyrics,
  playerControlsProps,
  artwork,
  translationEnabled,
  lyricIntro = null,
  lyricSyncMode = 'line',
  surfaceVisible = true,
}) {
  const enterWithKeyboard = (event) => {
    if (isMobile && canShowLyrics && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onEnterLyrics();
    }
  };
  const lyricPresentation = useLyricSurfacePresentation({
    lyrics,
    currentLyricIndex,
    lyricIntro,
    lyricSyncMode,
    surfaceVisible,
  });
  const hasAnyTranslation = translationEnabled && lyrics.some((lyric) => Boolean(getTranslationLyricLine(lyric)));
  const rowHeight = hasAnyTranslation ? 62 : 40;
  const viewportHeight = hasAnyTranslation ? 96 : 68;
  const centerOffset = (viewportHeight - rowHeight) / 2;
  const safeLyricIndex = Math.max(0, Math.min(lyricPresentation.index, lyrics.length - 1));

  return (
    <>
      <div role={isMobile && canShowLyrics ? 'button' : undefined} tabIndex={isMobile && canShowLyrics ? 0 : undefined} aria-label={isMobile && canShowLyrics ? t("点击进入多行歌词模式") : undefined} onClick={() => { if (isMobile && canShowLyrics) onEnterLyrics(); }} onKeyDown={enterWithKeyboard} className={`w-full flex-1 lg:flex-initial flex flex-col items-center justify-center min-h-0 relative mb-3 lg:mb-6 select-none ${isMobile && canShowLyrics ? 'cursor-pointer focus:outline-none' : ''}`} title={isMobile && canShowLyrics ? t("点击切换多行歌词") : undefined}>
        {artwork || <ClassicArtwork coverUrl={coverUrl} isPlaying={isPlaying} isBuffering={isBuffering} isExpandingToSong={isExpandingToSong} />}
        {canShowLyrics && hasValidLyrics && (
          <div className={`paper-mobile-lyric-preview lg:hidden cursor-pointer hover:opacity-95 transition-all select-none mt-5 sm:mt-7 mb-1 ${isExpandingToSong ? 'animate-large-cover-expand' : ''}`} title={t("点击展开完整多行歌词")}>
            <div className="paper-mobile-lyric-preview__viewport" style={{ height: `${viewportHeight}px` }}>
              <div className="paper-mobile-lyric-preview__roller" style={{ transform: `translateY(${-(safeLyricIndex * rowHeight - centerOffset)}px)` }}>
                {lyrics.map((lyric, index) => {
                  const isActive = index === safeLyricIndex;
                  const isIntroRow = lyricPresentation.kind === 'intro' && index === 0;
                  const displayLine = isIntroRow ? lyricPresentation.line : lyric;
                  const primaryText = getPrimaryLyricLine(displayLine);
                  const displayText = primaryText
                    ? (typeof displayLine?.text === 'string' && !displayLine.text.includes('\n')
                      ? displayLine.text
                      : primaryText)
                    : '…';
                  const translation = !isIntroRow && translationEnabled ? getTranslationLyricLine(lyric) : '';
                  return <div key={index} className={`paper-mobile-lyric-preview__row${isActive ? ' is-active' : ''}`} style={{ height: `${rowHeight}px` }}><div className="paper-mobile-lyric-preview__primary truncate"><SyncedLyricText line={displayLine} text={displayText} active={isActive} visible={surfaceVisible} syncMode={lyricSyncMode} surface="mobile-preview" /></div>{translation && <div className="paper-mobile-lyric-preview__translation truncate">{translation}</div>}</div>;
                })}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="w-full pb-1 sm:pb-1.5 shrink-0"><PlayerControls {...playerControlsProps} hideMetadata={false} showPlayerModes={isMobile} /></div>
    </>
  );
}

export function DesktopLyricsPane({ lyricsScrollerProps, controlsBottomOffset, surfaceVisible = true }) {
  return <div className="hidden lg:flex flex-1 lg:w-[52%] xl:w-[54%] min-h-0 h-full lg:pl-6 xl:pl-8 lg:pr-16 xl:pr-24 2xl:pr-28"><LyricsScroller {...lyricsScrollerProps} controlsBottomOffset={controlsBottomOffset} surfaceVisible={surfaceVisible} /></div>;
}
