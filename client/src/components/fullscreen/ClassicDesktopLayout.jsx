import React from 'react';
import PlayerSkinEntry from '../PlayerSkinEntry';
import { DesktopLyricsPane, MobileSongPane } from './MobileClassicPanes.jsx';
import ClassicCloseChevron from './ClassicCloseChevron.jsx';

export default function ClassicDesktopLayout({
  recordColumnRef,
  handleClose,
  handleTouchStart,
  handleTouchEnd,
  handleTouchCancel,
  songPaneProps,
  lyricsScrollerProps,
  controlsBottomOffset,
  desktopLyricsSurfaceVisible,
}) {
  return (
    <>
      <div className="absolute top-6 left-6 z-30 hidden lg:flex">
        <div className="classic-player__toolbar flex items-center">
          <button
            type="button"
            aria-label="退出全屏"
            onClick={handleClose}
            className="flex h-11 w-11 items-center justify-center text-white/70 transition-all duration-200 hover:text-white hover:scale-110 active:scale-95 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white"
          >
            <ClassicCloseChevron size={22} />
          </button>
          <PlayerSkinEntry variant="classic" />
        </div>
      </div>
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
            <MobileSongPane {...songPaneProps} isMobile={false} surfaceVisible={false} />
          </div>
          <DesktopLyricsPane
            lyricsScrollerProps={lyricsScrollerProps}
            controlsBottomOffset={controlsBottomOffset}
            surfaceVisible={desktopLyricsSurfaceVisible}
          />
        </div>
      </div>
    </>
  );
}
