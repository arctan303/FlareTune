import { localizeUnknownArtist, t } from '../i18n/index.js';
import React from 'react';
import { Play, Pause, Menu, PanelLeft } from 'lucide-react';
import { SolidRoundedSkipBack, SolidRoundedSkipForward } from './icons/SolidSkipIcons';
import { usePlayerStore } from '../store/usePlayerStore';
import { showToast, useUIStore } from '../store/useUIStore';
import { useThemeStore } from '../store/useThemeStore';
import LazyImage from './LazyImage';
import { useMediaQuery } from './fullscreen/useMediaQuery';
import { usePlaybackButtonAnimations } from '../hooks/usePlaybackButtonAnimations.js';
import { usePlayerBarThemeColors } from '../hooks/useCoverAccent.js';

import ProgressBar from './playerbar/ProgressBar';
import VolumeControl from './playerbar/VolumeControl';
import PlayModeToggle from './playerbar/PlayModeToggle';
import CoinFlipCover from './playerbar/CoinFlipCover';
import PlayerBarLyricPreview from './playerbar/PlayerBarLyricPreview.jsx';
import ScrollingText from './playerbar/ScrollingText.jsx';
import { useShallow } from 'zustand/react/shallow';
import { VISUAL_MOTION_PROFILE } from '../utils/motionPerformance';
import { requestLyricsTranslationCompletion } from '../hooks/useLyricsFetcher.js';
import { useCompactPlayerPlacement } from '../hooks/useCompactPlayerPlacement.js';

const formatTime = (time) => {
    if (!time || !Number.isFinite(time)) return '00:00';
    const m = Math.floor(time / 60);
    const s = Math.floor(time % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const PlayerBarTimeDisplay = React.memo(function PlayerBarTimeDisplay({ className = '' }) {
    const progress = usePlayerStore((state) => state.progress);
    const duration = usePlayerStore((state) => state.duration);
    return (
        <span className={className}>
            {formatTime(progress)} / {formatTime(duration)}
        </span>
    );
});

export default function PlayerBar({ motionProfile = 'full', activePage }) {
    const { placement, transition, canSwitchPlacement } = useCompactPlayerPlacement(activePage);
    const {
        currentSong,
        isPlaying,
        isBuffering,
        togglePlay,
        playPrev,
        playNext,
        lyrics,
        currentLyricIndex,
        lyricIntro,
        lyricSyncMode,
        translationEnabled,
        translationAvailable,
        translationState,
        toggleTranslation,
        setTranslationEnabled,
        switchDirection,
    } = usePlayerStore(useShallow((state) => ({
        currentSong: state.currentSong,
        isPlaying: state.isPlaying,
        isBuffering: state.isBuffering,
        togglePlay: state.togglePlay,
        playPrev: state.playPrev,
        playNext: state.playNext,
        lyrics: state.lyrics,
        currentLyricIndex: state.currentLyricIndex,
        lyricIntro: state.lyricIntro,
        lyricSyncMode: state.lyricSyncMode,
        translationEnabled: state.translationEnabled,
        translationAvailable: state.translationAvailable,
        translationState: state.translationState,
        toggleTranslation: state.toggleTranslation,
        setTranslationEnabled: state.setTranslationEnabled,
        switchDirection: state.switchDirection,
    })));
    
    const {
        isFullScreen,
        isFullScreenClosing,
        setIsFullScreen,
        setIsPlaylistOpen,
        playerMode,
        immersiveControlsPinned,
        immersiveControlsVisible,
        authenticated,
        canManageLyrics,
        setCompactPlayerPlacement,
    } = useUIStore(useShallow((state) => ({
        isFullScreen: state.isFullScreen,
        isFullScreenClosing: state.isFullScreenClosing,
        setIsFullScreen: state.setIsFullScreen,
        setIsPlaylistOpen: state.setIsPlaylistOpen,
        playerMode: state.playerMode,
        immersiveControlsPinned: state.immersiveControlsPinned,
        immersiveControlsVisible: state.immersiveControlsVisible,
        authenticated: Boolean(state.authSession?.authenticated),
        canManageLyrics: state.authSession?.user?.role === 'admin',
        setCompactPlayerPlacement: state.setCompactPlayerPlacement,
    })));
    const { glassMaterial } = useThemeStore(useShallow((state) => ({
        glassMaterial: state.glassMaterial,
    })));
    const {
        prevAnimNonce,
        nextAnimNonce,
        isPrevAnimating,
        isNextAnimating,
        handlePlayPrev,
        handlePlayNext,
    } = usePlaybackButtonAnimations({ playPrev, playNext });

    const [playlistBouncing, setPlaylistBouncing] = React.useState(false);
    const bounceTimerRef = React.useRef(null);

    React.useEffect(() => {
        const handleBounce = () => {
            if (bounceTimerRef.current) clearTimeout(bounceTimerRef.current);
            setPlaylistBouncing(true);
            bounceTimerRef.current = setTimeout(() => setPlaylistBouncing(false), 550);
        };
        window.addEventListener('arc-insert-next-bounced', handleBounce);
        return () => {
            if (bounceTimerRef.current) clearTimeout(bounceTimerRef.current);
            window.removeEventListener('arc-insert-next-bounced', handleBounce);
        };
    }, []);
    const playerColors = usePlayerBarThemeColors();
    const [showBuffering, setShowBuffering] = React.useState(false);

    React.useEffect(() => {
        let timer;
        if (isBuffering && isPlaying) {
            timer = setTimeout(() => setShowBuffering(true), 250);
        } else {
            setShowBuffering(false);
        }
        return () => clearTimeout(timer);
    }, [isBuffering, isPlaying]);

    const isDesktopViewport = useMediaQuery('(min-width: 1024px)', false);
    const isDesktop = isDesktopViewport && motionProfile !== VISUAL_MOTION_PROFILE.COMPACT_TOUCH;
    const activeFullScreen = isFullScreen && !isFullScreenClosing;
    const isImmersiveMode = playerMode === 'cinematic';
    // 沉浸形态全屏时保留沉浸式底部控制栏（PlayerBar 展开态）；经典形态全屏时由播放器内部控制栏接管
    const isExpanded = activeFullScreen && isDesktop && isImmersiveMode;
    const isSidebarPlayer = !activeFullScreen && placement === 'sidebar';
    const isPlacementExit = !activeFullScreen && transition?.from === 'dock' && transition.phase === 'exit';
    const isHidden = (activeFullScreen && (!isDesktop || !isImmersiveMode)) || isSidebarPlayer || isPlacementExit;
    const showTranslationButton = translationState !== 'unavailable'
        && (canManageLyrics || translationState === 'ready');
    const translationPending = translationState === 'pending';
    const translationReady = translationState === 'ready' && translationAvailable;
    const translationStatusMessage = translationPending
        ? '正在补全歌词翻译'
        : translationReady
            ? '歌词翻译已就绪'
            : translationState === 'failed'
                ? '歌词翻译补全失败，可以点击重试'
                : '';
    const handleTranslationAction = React.useCallback((event) => {
        event?.stopPropagation?.();
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
    
    if (!currentSong) return null;

    let pillLine1 = currentSong?.title || t('听你想听');
    let pillLine2 = localizeUnknownArtist(currentSong?.artist);

    if (showBuffering) {
        pillLine1 = t('正在缓冲...');
        pillLine2 = currentSong.title;
    }

    const coverUrl = currentSong?.cover_url || '/placeholder-album.svg';
    const immersiveControlsShown = !isExpanded || immersiveControlsPinned || immersiveControlsVisible;

    const getGlassClasses = () => {
        if (!isExpanded) return 'player-console';
        switch (glassMaterial) {
            case 'glass-dark':
                return 'player-glass-liquid bg-black/50 backdrop-blur-[16px] border border-white/10 hover:bg-black/60 shadow-[0_12px_40px_rgba(0,0,0,0.5)]';
            case 'glass-invisible':
                return 'player-glass-liquid player-console--invisible bg-transparent border border-transparent shadow-none';
            case 'glass-light':
            default:
                return 'player-glass-liquid bg-white/5 dark:bg-black/20 backdrop-blur-[12px] border border-white/20 dark:border-white/10 hover:bg-white/10 dark:hover:bg-black/30 shadow-[0_12px_40px_rgba(0,0,0,0.1)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.5)]';
        }
    };

    return (
        <>
            {isExpanded && (
                <div className={`fixed bottom-0 left-0 w-full z-[70] animate-[fade-in_0.4s_ease-out] transition-opacity duration-500 ${immersiveControlsShown ? 'opacity-100' : 'opacity-35'}`}>
                    <ProgressBar isImmersiveBottom={true} />
                </div>
            )}
            <div 
                aria-hidden={isHidden ? true : undefined}
                inert={isHidden ? '' : undefined}
                className={`player-dock ${isExpanded ? 'player-dock--immersive' : ''} fixed left-1/2 z-[60] flex -translate-x-1/2 justify-center transition-[transform,width,max-width] duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] ${
                    (isHidden || !immersiveControlsShown) ? 'translate-y-[180px] pointer-events-none' : 'translate-y-0'
                } ${isExpanded ? 'w-[92%] md:w-[88%] lg:w-[80%] max-w-[960px]' : 'w-[95%] md:w-[70%] max-w-3xl'}`}
                style={{
                    contain: 'layout style',
                    transitionDuration: activeFullScreen ? undefined : transition?.phase === 'exit' ? '220ms' : transition?.phase === 'enter' ? '320ms' : undefined,
                }}
            >
                <div
                    onClick={() => !isExpanded && currentSong && setIsFullScreen(true)}
                    data-playing={!isExpanded && isPlaying && !isBuffering ? 'true' : 'false'}
                    style={!isExpanded ? {
                        '--player-lyric-current': playerColors.lyricCurrent,
                        '--player-lyric-unheard': playerColors.lyricUnheard,
                        '--player-icon-color': playerColors.iconColor,
                        '--player-icon-hover': playerColors.iconHover,
                        '--player-play-color': playerColors.playColor,
                        '--player-text-shadow': playerColors.textShadow,
                    } : undefined}
                    className={`relative z-10 w-full transition-[height,padding,border-radius,background-color,box-shadow] duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] flex flex-col justify-center ${
                        isExpanded 
                            ? `rounded-[40px] px-6 md:px-8 py-3.5 cursor-default ${getGlassClasses()}`
                            : `group h-[74px] cursor-pointer p-2 pr-4 ${getGlassClasses()}`
                    }`}
                >
                    {!isExpanded && (
                        <div className="player-console__progress pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-[22px]">
                            <div className="pointer-events-auto w-full">
                                <ProgressBar />
                            </div>
                        </div>
                    )}

                {isExpanded ? (
                    <div className="relative flex items-center w-full grid grid-cols-[1fr_auto_1fr] gap-4">
                        {/* 左列：封面 + 歌曲信息 */}
                        <div className="flex items-center gap-3 min-w-0 col-span-1 justify-self-start w-full">
                            <CoinFlipCover
                                currentSong={currentSong}
                                isExpanded={true}
                                switchDirection={switchDirection}
                            />
                            <div className="flex-1 min-w-0 flex flex-col justify-center items-start text-left relative h-auto overflow-hidden pr-2">
                                <div key={currentSong?.id + '-meta'} className="flex flex-col items-start text-left w-full max-w-md animate-player-content-drift-in pointer-events-auto">
                                    <ScrollingText className="font-bold transition-colors text-white/95 text-[13px] tracking-wide text-left w-full" align="left">
                                        {pillLine1}
                                    </ScrollingText>
                                    <ScrollingText className="transition-colors text-[11px] mt-0.5 text-white/60 text-left w-full" align="left">
                                        {pillLine2}
                                    </ScrollingText>
                                </div>
                            </div>
                        </div>

                        {/* 中列：播放控制三大键 */}
                        <div className="relative z-20 flex items-center flex-shrink-0 col-span-1 justify-self-center gap-6" onClick={e => e.stopPropagation()}>
                            <button
                                aria-label={t("上一首")}
                                onClick={handlePlayPrev}
                                className={`skip-btn skip-btn--prev ${isPrevAnimating ? 'is-animating' : ''} p-1.5 transition-colors duration-200 block text-white/70 hover:text-white`}
                            >
                                <SolidRoundedSkipBack size={22} isAnimating={isPrevAnimating} animKey={prevAnimNonce} />
                            </button>
                            <button
                                aria-label={isPlaying ? t("暂停") : t("播放")}
                                onClick={togglePlay}
                                className="player-console__play relative flex items-center justify-center p-1.5 transition-all duration-300 active:scale-90 text-white/90 hover:text-white hover:scale-115"
                            >
                                {isPlaying ? (
                                    <Pause size={24} fill="currentColor" />
                                ) : (
                                    <Play size={24} fill="currentColor" className="ml-0.5" />
                                )}
                            </button>
                            <button
                                aria-label={t("下一首")}
                                onClick={handlePlayNext}
                                className={`skip-btn skip-btn--next ${isNextAnimating ? 'is-animating' : ''} p-1.5 transition-colors duration-200 block text-white/70 hover:text-white`}
                            >
                                <SolidRoundedSkipForward size={22} isAnimating={isNextAnimating} animKey={nextAnimNonce} />
                            </button>
                        </div>

                        {/* 右列：时间、翻译、模式、音量、列表 */}
                        <div className="relative z-20 flex items-center justify-end gap-3 md:gap-4 flex-shrink-0 col-span-1 justify-self-end animate-[fade-in_0.4s_ease-out] w-full" onClick={e => e.stopPropagation()}>
                            <PlayerBarTimeDisplay className="text-[11px] font-medium text-white/50 tracking-wider font-mono mr-1 md:mr-2 whitespace-nowrap flex-shrink-0" />
                            {showTranslationButton && (
                                <button
                                    type="button"
                                    aria-label={translationPending
                                        ? t("歌词翻译补全中")
                                        : translationReady
                                            ? t("切换歌词翻译")
                                            : translationState === 'failed'
                                                ? t("歌词翻译补全失败，重试")
                                                : t("补全歌词翻译")}
                                    aria-busy={translationPending || undefined}
                                    disabled={translationPending}
                                    data-active={translationReady && translationEnabled}
                                    data-translation-state={translationState}
                                    onClick={handleTranslationAction}
                                    className={`lyrics-translation-action classic-lyrics__tool classic-lyrics__tool--text relative h-5.5 px-2 inline-flex cursor-pointer items-center justify-center rounded border text-[11px] font-medium transition-all disabled:cursor-wait shrink-0 ${
                                        translationReady && translationEnabled
                                            ? 'border-blue-400/60 text-blue-300 bg-blue-500/20 font-semibold shadow-[0_0_6px_rgba(59,130,246,0.3)]'
                                            : translationReady
                                                ? 'border-blue-400/30 text-blue-200/75 bg-blue-500/10 hover:text-blue-100 hover:border-blue-300/50'
                                                : translationState === 'failed'
                                                    ? 'border-amber-300/35 text-amber-200/80 bg-amber-400/10 hover:border-amber-200/60'
                                                    : 'border-white/15 text-white/45 hover:text-white/70 hover:border-white/30 bg-black/15'
                                    }`}
                                    title={translationPending
                                        ? t("正在补全歌词翻译")
                                        : translationReady
                                            ? (translationEnabled ? t("已显示歌词翻译（点击隐藏）") : t("显示歌词翻译"))
                                            : translationState === 'failed' ? t("补全失败，点击重试") : t("点击补全歌词翻译")}
                                >
                                    <span aria-hidden="true">{t("译")}</span>
                                    {translationState === 'failed' && (
                                        <span aria-hidden="true" className="lyrics-translation-action__warning">!</span>
                                    )}
                                </button>
                            )}
                            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                                {translationStatusMessage}
                            </span>
                            <PlayModeToggle isExpanded={true} />
                            <VolumeControl isExpanded={true} />
                            <button aria-label={t("打开播放列表")} onClick={() => setIsPlaylistOpen(true)} className={`text-white/70 hover:text-white transition-colors outline-none flex items-center justify-center ${playlistBouncing ? 'animate-playlist-bounce text-white' : ''}`}>
                                <Menu size={20} />
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="relative flex items-center justify-between w-full">
                        {/* 左翼：封面 + 桌面端三大主控 */}
                        <div className="flex items-center flex-shrink-0 z-20 gap-1 sm:gap-2">
                            <CoinFlipCover
                                currentSong={currentSong}
                                isExpanded={false}
                                switchDirection={switchDirection}
                            />
                            <div className="hidden sm:flex items-center gap-0.5 sm:gap-1" onClick={e => e.stopPropagation()}>
                                <button
                                    aria-label={t("上一首")}
                                    onClick={handlePlayPrev}
                                    className={`skip-btn skip-btn--prev ${isPrevAnimating ? 'is-animating' : ''} p-1.5 transition-colors duration-200 player-console__icon player-console__icon--nav`}
                                >
                                    <SolidRoundedSkipBack size={20} isAnimating={isPrevAnimating} animKey={prevAnimNonce} />
                                </button>
                                <button
                                    aria-label={isPlaying ? t("暂停") : t("播放")}
                                    onClick={togglePlay}
                                    className="player-console__play relative flex items-center justify-center p-1.5 transition-all duration-300 active:scale-90 text-current"
                                >
                                    {isPlaying ? (
                                        <Pause size={22} fill="currentColor" />
                                    ) : (
                                        <Play size={22} fill="currentColor" className="ml-0.5" />
                                    )}
                                </button>
                                <button
                                    aria-label={t("下一首")}
                                    onClick={handlePlayNext}
                                    className={`skip-btn skip-btn--next ${isNextAnimating ? 'is-animating' : ''} p-1.5 transition-colors duration-200 player-console__icon player-console__icon--nav`}
                                >
                                    <SolidRoundedSkipForward size={20} isAnimating={isNextAnimating} animKey={nextAnimNonce} />
                                </button>
                            </div>
                        </div>

                        {/* 中轴：50% 几何绝对居中、流式自适应充满的歌词/歌曲信息视窗 */}
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-170px)] sm:w-[calc(100%-340px)] md:w-[calc(100%-360px)] max-w-[620px] h-[36px] flex flex-col items-center justify-center text-center overflow-hidden z-10 pointer-events-none">
                            <PlayerBarLyricPreview
                                currentSong={currentSong}
                                isHidden={isHidden}
                                isPlaying={isPlaying}
                                showBuffering={showBuffering}
                                lyrics={lyrics}
                                currentLyricIndex={currentLyricIndex}
                                lyricIntro={lyricIntro}
                                lyricSyncMode={lyricSyncMode}
                                surfaceVisible={!isHidden}
                                translationEnabled={translationEnabled}
                                canTranslate={showTranslationButton}
                                title={pillLine1}
                                subtitle={pillLine2}
                            />
                        </div>

                        {/* 右翼：移动端右置播放键 + 音量 + 模式 + 列表 */}
                        <div className="relative z-20 flex items-center flex-shrink-0 gap-0.5 sm:gap-1.5" onClick={e => e.stopPropagation()}>
                            {/* 移动端专属播放/暂停键（与播放列表紧挨着） */}
                            <button
                                aria-label={isPlaying ? t("暂停") : t("播放")}
                                onClick={togglePlay}
                                className="player-console__play relative flex sm:hidden items-center justify-center p-1.5 transition-all duration-300 active:scale-90 text-current"
                            >
                                {isPlaying ? (
                                    <Pause size={22} fill="currentColor" />
                                ) : (
                                    <Play size={22} fill="currentColor" className="ml-0.5" />
                                )}
                            </button>
                            <div className="hidden sm:flex items-center">
                                <VolumeControl isExpanded={false} />
                            </div>
                            <div className="hidden lg:flex items-center">
                                <PlayModeToggle isExpanded={false} />
                            </div>
                            {canSwitchPlacement && (
                                <button
                                    type="button"
                                    aria-label={t("切换到侧边播放器")}
                                    title={t("切换到侧边播放器")}
                                    disabled={Boolean(transition)}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        setCompactPlayerPlacement('sidebar');
                                    }}
                                    className="player-console__icon p-1.5 transition-all duration-300 active:scale-90"
                                >
                                    <PanelLeft size={20} />
                                </button>
                            )}
                            <button aria-label={t("打开播放列表")} onClick={() => setIsPlaylistOpen(true)} className={`player-console__icon p-1.5 transition-all duration-300 active:scale-90 ${playlistBouncing ? 'animate-playlist-bounce text-[var(--accent-strong)]' : ''}`}>
                                <Menu size={20} />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
        </>
    );
}
