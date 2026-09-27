import React from 'react';
import { MobileLyricsPane } from './MobileClassicPanes.jsx';
import ClassicCloseChevron from './ClassicCloseChevron.jsx';

export default function MobilePlayerLayout({
  recordColumnRef,
  handleClose,
  handleTouchStart,
  handleTouchEnd,
  handleTouchCancel,
  fullScreenMobileView,
  coverUrl,
  currentSong,
  isExitingLyrics,
  controlsVisible,
  handleExitLyricsView,
  resetAutoHideTimer,
  lyricsScrollerProps,
  playerControlsProps,
  mobileLyricsSurfaceVisible,
  songPane,
}) {
  return (
    <div
      className="classic-player__layout relative z-10 flex flex-col lg:flex-row h-full w-full overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div className="flex flex-col lg:flex-row w-full h-full min-h-0 flex-1 max-w-[1440px] mx-auto">
        <div
          ref={recordColumnRef}
          className="classic-player__record-column relative w-full lg:w-[48%] xl:w-[46%] flex-shrink-0 flex flex-col min-h-0 h-full lg:pl-10 xl:pl-16 2xl:pl-20 lg:pr-3 xl:pr-5 pt-12 sm:pt-14 pb-5 sm:pb-6 lg:py-0 lg:justify-center px-6 sm:px-10"
        >
          <div className="absolute top-4 sm:top-5 left-1/2 -translate-x-1/2 z-40 lg:hidden flex items-center justify-center pointer-events-auto">
            <button
              type="button"
              aria-label="退出全屏"
              onClick={handleClose}
              className="w-12 h-7 rounded-full bg-white/[0.08] hover:bg-white/[0.18] active:scale-90 text-white/75 hover:text-white transition-all flex items-center justify-center backdrop-blur-md focus:outline-none cursor-pointer group shadow-[0_2px_10px_rgba(0,0,0,0.15)]"
              title="退出全屏"
            >
              <ClassicCloseChevron size={18} className="transition-transform group-hover:translate-y-0.5" />
            </button>
          </div>
          {fullScreenMobileView === 'lyrics' ? (
            <MobileLyricsPane
              coverUrl={coverUrl}
              currentSong={currentSong}
              isExitingLyrics={isExitingLyrics}
              controlsVisible={controlsVisible}
              onExit={handleExitLyricsView}
              onWakeControls={resetAutoHideTimer}
              lyricsScrollerProps={lyricsScrollerProps}
              playerControlsProps={playerControlsProps}
              surfaceVisible={mobileLyricsSurfaceVisible}
            />
          ) : songPane}
        </div>
      </div>
    </div>
  );
}
