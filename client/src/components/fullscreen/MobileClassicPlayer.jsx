import { t } from '../../i18n/index.js';
import React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore, showToast } from '../../store/useUIStore';
import { extractAppleMusicPalette } from './AppleFluidCanvas';
import MobileClassicBackground from './MobileClassicBackground.jsx';
import ClassicDesktopLayout from './ClassicDesktopLayout.jsx';
import ClassicMobileLayout from './ClassicMobileLayout.jsx';
import ArtistMobileLayout from './ArtistMobileLayout.jsx';
import { useShallow } from 'zustand/react/shallow';
import { useMediaQuery } from './useMediaQuery';
import { getPrimaryLyricLine } from './mobileLyricPreview';
import { VISUAL_MOTION_PHASE } from '../../utils/motionPerformance';
import { useArtistPhotos } from '../../hooks/useArtistPhotos';
import { resolveCoverUrl } from '../../utils';
import { imageLoadRegistry } from '../../utils/imageLoadRegistry.js';
import { songLanguageHasLyrics } from '../../constants/language';
import { useFullscreenTransition } from '../../hooks/useFullscreenTransition.js';
import { usePlayerAutoHide } from '../../hooks/usePlayerAutoHide.js';
import { requestLyricsTranslationCompletion } from '../../hooks/useLyricsFetcher.js';
import './classic-player.css';
import './classic-mobile.css';

export default function MobileClassicPlayer({ instantEnter = false, mobileVisual = 'classic' }) {
    const {
        currentSong, isPlaying, isBuffering, togglePlay, playNext, playPrev,
        playMode, handleModeChange,
        lyrics, currentLyricIndex, audioRef,
        translationEnabled, translationAvailable, translationState, toggleTranslation,
        setTranslationEnabled,
        isLyricsLoading,
        lyricSyncMode, lyricIntro,
        volume, setVolume,
    } = usePlayerStore(useShallow((state) => ({
        currentSong: state.currentSong,
        isPlaying: state.isPlaying,
        isBuffering: state.isBuffering,
        togglePlay: state.togglePlay,
        playNext: state.playNext,
        playPrev: state.playPrev,
        playMode: state.playMode,
        handleModeChange: state.handleModeChange,
        lyrics: state.lyrics,
        currentLyricIndex: state.currentLyricIndex,
        audioRef: state.audioRef,
        translationEnabled: state.translationEnabled,
        translationAvailable: state.translationAvailable,
        translationState: state.translationState,
        toggleTranslation: state.toggleTranslation,
        setTranslationEnabled: state.setTranslationEnabled,
        isLyricsLoading: state.isLyricsLoading,
        lyricSyncMode: state.lyricSyncMode,
        lyricIntro: state.lyricIntro,
        volume: state.volume,
        setVolume: state.setVolume,
    })));

    const {
        isFullScreen, setIsFullScreen,
        isPlaylistOpen, setIsPlaylistOpen,
        setIsFullScreenClosing,
        fullScreenMobileView, setFullScreenMobileView,
        visualMotionPhase,
        setVisualMotionPhase,
        authenticated,
        canManageLyrics,
    } = useUIStore(useShallow((state) => ({
        isFullScreen: state.isFullScreen,
        setIsFullScreen: state.setIsFullScreen,
        isPlaylistOpen: state.isPlaylistOpen,
        setIsPlaylistOpen: state.setIsPlaylistOpen,
        setIsFullScreenClosing: state.setIsFullScreenClosing,
        fullScreenMobileView: state.fullScreenMobileView,
        setFullScreenMobileView: state.setFullScreenMobileView,
        visualMotionPhase: state.visualMotionPhase,
        setVisualMotionPhase: state.setVisualMotionPhase,
        authenticated: Boolean(state.authSession?.authenticated),
        canManageLyrics: state.authSession?.user?.role === 'admin',
    })));

    const coverUrl = resolveCoverUrl(currentSong?.cover_url || '');
    const touchStartRef = React.useRef(null);
    const contentRef = React.useRef(null);
    const recordColumnRef = React.useRef(null);
    const controlsRef = React.useRef(null);
    const exitLyricsTimerRef = React.useRef(null);
    const expandSongTimerRef = React.useRef(null);
    const [isExitingLyrics, setIsExitingLyrics] = React.useState(false);
    const [isExpandingToSong, setIsExpandingToSong] = React.useState(false);
    const [palette, setPalette] = React.useState({
        dominant: 'rgb(48, 44, 40)',
        secondary: 'rgb(76, 70, 64)',
        accent: 'rgb(96, 88, 80)',
        deep: 'rgb(12, 11, 10)'
    });
    const [controlsBottomOffset, setControlsBottomOffset] = React.useState(null);
    const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', false);
    const isMobile = useMediaQuery('(max-width: 1023px)', false);

    React.useLayoutEffect(() => {
        const updateOffset = () => {
            if (!contentRef.current || !controlsRef.current) return;
            const containerRect = contentRef.current.getBoundingClientRect();
            const controlsRect = controlsRef.current.getBoundingClientRect();
            const offset = Math.max(0, Math.round(containerRect.bottom - controlsRect.bottom));
            setControlsBottomOffset(offset);
        };

        updateOffset();
        const frame = requestAnimationFrame(updateOffset);

        let observer = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
                updateOffset();
            });
            if (contentRef.current) observer.observe(contentRef.current);
            if (controlsRef.current) observer.observe(controlsRef.current);
            if (recordColumnRef.current) observer.observe(recordColumnRef.current);
        }
        window.addEventListener('resize', updateOffset, { passive: true });

        return () => {
            cancelAnimationFrame(frame);
            if (observer) observer.disconnect();
            window.removeEventListener('resize', updateOffset);
        };
    }, [isFullScreen, isMobile, currentSong?.id]);

    const hasValidLyrics = React.useMemo(() => {
        if (isLyricsLoading || !lyrics || lyrics.length === 0) return false;
        return lyrics.some((lrc) => Boolean(getPrimaryLyricLine(lrc)));
    }, [isLyricsLoading, lyrics]);
    const canShowLyrics = songLanguageHasLyrics(currentSong?.language);

    const {
        hasMounted,
        hasEntered,
        isClosing,
        handleClose,
        handleStageTransitionEnd,
    } = useFullscreenTransition({
        instantEnter,
        isFullScreen,
        setIsFullScreen,
        setIsFullScreenClosing,
        setVisualMotionPhase,
        focusTargetRef: contentRef,
    });

    const suspendPlayerEffects = isClosing
        || isPlaylistOpen
        || visualMotionPhase === VISUAL_MOTION_PHASE.DRAWER;
    const isArtistMode = mobileVisual === 'artist' && isMobile;
    const {
        photoLayers,
        showPhotos,
    } = useArtistPhotos({
        artistName: currentSong?.artist || '',
        enabled: isMobile && isArtistMode && Boolean(currentSong?.artist?.trim()),
        isPlaying,
        isBuffering,
        suspendEffects: suspendPlayerEffects,
        prefersReducedMotion,
    });
    const showMobilePhotos = isMobile && showPhotos;

    const { visible: controlsVisible, reveal: resetAutoHideTimer } = usePlayerAutoHide({
        enabled: isMobile && fullScreenMobileView === 'lyrics' && isPlaying && !isBuffering && !isPlaylistOpen,
        delay: 4200,
        surfaceRef: contentRef,
    });

    // 进入多行歌词视图 (平滑入场动效)
    const handleEnterLyricsView = React.useCallback(() => {
        if (!isMobile || !canShowLyrics || fullScreenMobileView === 'lyrics') return;
        setFullScreenMobileView('lyrics');
        setIsExitingLyrics(false);
        setIsExpandingToSong(false);
        resetAutoHideTimer();
    }, [isMobile, canShowLyrics, fullScreenMobileView, setFullScreenMobileView, resetAutoHideTimer]);

    React.useEffect(() => {
        if (!canShowLyrics && fullScreenMobileView === 'lyrics') {
            setFullScreenMobileView('song');
            setIsExitingLyrics(false);
        }
    }, [canShowLyrics, fullScreenMobileView, setFullScreenMobileView]);

    // 退出多行歌词视图 (补全流畅的淡出与封面展开退出动效)
    const handleExitLyricsView = React.useCallback(() => {
        if (!isMobile || fullScreenMobileView !== 'lyrics' || isExitingLyrics) return;
        if (prefersReducedMotion) {
            setFullScreenMobileView('song');
            return;
        }
        setIsExitingLyrics(true);
        if (exitLyricsTimerRef.current) clearTimeout(exitLyricsTimerRef.current);
        exitLyricsTimerRef.current = setTimeout(() => {
            setFullScreenMobileView('song');
            setIsExitingLyrics(false);
            setIsExpandingToSong(true);
            if (expandSongTimerRef.current) clearTimeout(expandSongTimerRef.current);
            expandSongTimerRef.current = setTimeout(() => {
                setIsExpandingToSong(false);
            }, 460);
        }, 260);
    }, [isMobile, fullScreenMobileView, isExitingLyrics, prefersReducedMotion, setFullScreenMobileView]);

    React.useEffect(() => {
        if (!isMobile) {
            setFullScreenMobileView('song');
            setIsExitingLyrics(false);
            setIsExpandingToSong(false);
        }
    }, [isMobile, setFullScreenMobileView]);

    React.useEffect(() => {
        if (!coverUrl) return undefined;

        const img = new Image();
        let cancelled = false;
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            if (cancelled) return;
            const extracted = extractAppleMusicPalette(img);
            if (extracted) {
                setPalette(extracted);
            }
        };

        const tinyCoverUrl = coverUrl.replace('size=600', 'size=50');
        if (imageLoadRegistry.shouldLoadPrivately(coverUrl)) {
            void imageLoadRegistry.load(coverUrl).then(({ url }) => {
                if (!cancelled) img.src = url;
            }).catch(() => {});
        } else {
            img.src = tinyCoverUrl + (tinyCoverUrl.includes('?') ? '&' : '?') + '_c=1';
        }
        return () => {
            cancelled = true;
            img.onload = null;
        };
    }, [coverUrl]);

    React.useEffect(() => () => {
        if (exitLyricsTimerRef.current) clearTimeout(exitLyricsTimerRef.current);
        if (expandSongTimerRef.current) clearTimeout(expandSongTimerRef.current);
    }, []);
    const handleTouchStart = (event) => {
        const target = event.target;
        if (target?.closest?.('.classic-lyrics__tools-wrapper, .classic-lyrics__tool')) {
            touchStartRef.current = null;
            return;
        }
        if (target?.closest?.('button, input, a, [role="slider"], [data-no-swipe]')) {
            touchStartRef.current = null;
            resetAutoHideTimer();
            return;
        }
        resetAutoHideTimer();
        const touch = event.touches[0];
        touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    };

    const handleTouchEnd = (event) => {
        const target = event.target;
        if (target?.closest?.('.classic-lyrics__tools-wrapper, .classic-lyrics__tool')) {
            touchStartRef.current = null;
            return;
        }
        resetAutoHideTimer();
        if (!touchStartRef.current) return;

        const touch = event.changedTouches[0];
        const dx = touch.clientX - touchStartRef.current.x;
        const dy = touch.clientY - touchStartRef.current.y;
        
        // 左右轻扫：切换 唱片 / 歌词 视图 (仅限移动端，带进退平滑动效)
        if (isMobile && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            if (dx < 0 && fullScreenMobileView === 'song') handleEnterLyricsView();
            if (dx > 0 && fullScreenMobileView === 'lyrics') handleExitLyricsView();
        } 
        // 顶部或背景区域明显向下轻扫：下滑收起全屏播放器
        else if (dy > 70 && dy > Math.abs(dx) * 1.5) {
            handleClose();
        }
        touchStartRef.current = null;
    };

    const translationPending = translationState === 'pending';
    const translationReady = translationState === 'ready' && translationAvailable;
    const translationStatusMessage = translationPending
        ? '正在补全歌词翻译'
        : translationReady
            ? '歌词翻译已就绪'
            : translationState === 'failed'
                ? '歌词翻译补全失败，可以点击重试'
                : '';
    const handleTranslationAction = React.useCallback(() => {
        if (translationPending) return;
        if (translationReady) {
            toggleTranslation();
            return;
        }
        if (!canManageLyrics) return;
        setTranslationEnabled(true);
        void requestLyricsTranslationCompletion({
            songId: currentSong?.id,
            authenticated,
            notify: showToast,
        });
    }, [authenticated, canManageLyrics, currentSong?.id, setTranslationEnabled, toggleTranslation, translationPending, translationReady]);

    const lyricsScrollerProps = {
        lyrics,
        currentLyricIndex,
        audioRef,
        isLyricsLoading,
        translationEnabled,
        canTranslate: translationState !== 'unavailable' && (canManageLyrics || translationReady),
        translationState,
        toggleTranslation: handleTranslationAction,
        volume,
        setVolume,
        isFullScreen,
        currentSong,
        lyricSyncMode,
        lyricIntro,
    };
    const playerControlsProps = {
        currentSong,
        audioRef,
        playMode,
        handleModeChange,
        playPrev,
        togglePlay,
        isPlaying,
        playNext,
        setIsPlaylistOpen,
        layoutRef: controlsRef,
    };
    const playerSurfaceVisible = Boolean(isFullScreen && !isClosing);
    const mobileLyricsSurfaceVisible = playerSurfaceVisible
        && isMobile
        && fullScreenMobileView === 'lyrics';
    const mobileSongSurfaceVisible = playerSurfaceVisible
        && isMobile
        && fullScreenMobileView === 'song';
    const desktopLyricsSurfaceVisible = playerSurfaceVisible && !isMobile;

    const songPaneProps = {
        canShowLyrics,
        coverUrl,
        currentLyricIndex,
        hasValidLyrics,
        isBuffering,
        isExpandingToSong,
        isPlaying,
        lyrics,
        onEnterLyrics: handleEnterLyricsView,
        playerControlsProps,
        translationEnabled,
        lyricIntro,
        lyricSyncMode,
    };
    const layoutTouchProps = {
        recordColumnRef,
        handleClose,
        handleTouchStart,
        handleTouchEnd,
        handleTouchCancel: () => { touchStartRef.current = null; },
    };
    const MobileLayout = isArtistMode ? ArtistMobileLayout : ClassicMobileLayout;

    return (
        <div
            ref={contentRef}
            aria-label={isArtistMode ? t("歌手写真播放器画面") : t("经典播放器画面")}
            tabIndex={-1}
            data-player-theme={isArtistMode ? 'artist' : 'classic'}
            className={`fixed inset-0 z-50 text-white paper-classic-player ${(hasMounted && isFullScreen && !isClosing) ? 'translate-y-0' : 'translate-y-full'} ${instantEnter ? 'player-mode-fade-in' : ''}`}
            style={{
                backgroundColor: palette.deep,
                transitionProperty: hasMounted ? 'transform, background-color' : 'none',
                transitionDuration: prefersReducedMotion ? '150ms' : '620ms',
                transitionTimingFunction: 'cubic-bezier(0.22,1,0.36,1)',
                contain: 'layout style',
                paddingBottom: 'env(safe-area-inset-bottom)'
            }}
            onTransitionEnd={handleStageTransitionEnd}
        >
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {translationStatusMessage}
            </span>
            <div className={`classic-player__buffering absolute top-20 left-1/2 -translate-x-1/2 z-[60] bg-black/60 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 text-sm text-white/90 shadow-lg pointer-events-none transition-all duration-300 ${isBuffering && isPlaying ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'}`}>
                <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <span>{t("正在缓冲...")}</span>
            </div>

            <MobileClassicBackground
                showPhotos={showMobilePhotos}
                photoLayers={photoLayers}
                isLyricsView={isMobile && fullScreenMobileView === 'lyrics'}
                prefersReducedMotion={prefersReducedMotion}
                isPlaying={isPlaying}
                isBuffering={isBuffering}
                suspendPlayerEffects={suspendPlayerEffects}
                coverUrl={coverUrl}
                hasEntered={hasEntered}
                palette={palette}
            />
            {isMobile ? (
                <MobileLayout
                    {...layoutTouchProps}
                    fullScreenMobileView={fullScreenMobileView}
                    coverUrl={coverUrl}
                    currentSong={currentSong}
                    isExitingLyrics={isExitingLyrics}
                    controlsVisible={controlsVisible}
                    handleExitLyricsView={handleExitLyricsView}
                    resetAutoHideTimer={resetAutoHideTimer}
                    lyricsScrollerProps={lyricsScrollerProps}
                    playerControlsProps={playerControlsProps}
                    mobileLyricsSurfaceVisible={mobileLyricsSurfaceVisible}
                    mobileSongSurfaceVisible={mobileSongSurfaceVisible}
                    songPaneProps={songPaneProps}
                    showMobilePhotos={showMobilePhotos}
                />
            ) : (
                <ClassicDesktopLayout
                    {...layoutTouchProps}
                    songPaneProps={songPaneProps}
                    lyricsScrollerProps={lyricsScrollerProps}
                    controlsBottomOffset={controlsBottomOffset}
                    desktopLyricsSurfaceVisible={desktopLyricsSurfaceVisible}
                />
            )}
        </div>
    );
}
