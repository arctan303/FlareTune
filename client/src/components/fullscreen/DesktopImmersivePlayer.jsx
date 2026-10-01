import { t } from '../../i18n/index.js';
import React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { useThemeStore } from '../../store/useThemeStore';
import { getImmersiveTheme } from '../../constants/immersiveThemes';
import { resolveCoverUrl } from '../../utils';
import ImmersiveBackground from './ImmersiveBackground';
import ImmersiveChrome from './ImmersiveChrome';
import ImmersiveLyrics from './ImmersiveLyrics';
import ImmersiveAudioAura from './ImmersiveAudioAura';
import PlayerSkinEntry from '../PlayerSkinEntry';
import LyricsWorkspaceEntry from '../LyricsWorkspaceEntry';
import { useMediaQuery } from './useMediaQuery';
import { useShallow } from 'zustand/react/shallow';
import { VISUAL_MOTION_PHASE } from '../../utils/motionPerformance';
import { useFullscreenTransition } from '../../hooks/useFullscreenTransition.js';

// 调试面板按需加载：生产环境（未开启 VITE_ENABLE_THEME_DEBUGGER）下不打包进主包、也不发起请求
const ThemeDebugger = import.meta.env.VITE_ENABLE_THEME_DEBUGGER === 'true'
    ? React.lazy(() => import('./ThemeDebugger'))
    : null;

export default function DesktopImmersivePlayer({ motionProfile = 'full', instantEnter = false }) {
    const {
        currentSong,
        lyrics,
        currentLyricIndex,
        audioRef,
        isPlaying,
        isBuffering,
        isLyricsLoading,
        lyricsStatus,
        translationEnabled,
        lyricSyncMode,
        lyricIntro,
    } = usePlayerStore(useShallow((state) => ({
        currentSong: state.currentSong,
        lyrics: state.lyrics,
        currentLyricIndex: state.currentLyricIndex,
        audioRef: state.audioRef,
        isPlaying: state.isPlaying,
        isBuffering: state.isBuffering,
        isLyricsLoading: state.isLyricsLoading,
        lyricsStatus: state.lyricsStatus,
        translationEnabled: state.translationEnabled,
        lyricSyncMode: state.lyricSyncMode,
        lyricIntro: state.lyricIntro,
    })));

    const {
        isFullScreen,
        setIsFullScreen,
        setIsFullScreenClosing,
        isPlaylistOpen,
        visualMotionPhase,
        setVisualMotionPhase,
        immersiveControlsPinned,
        setImmersiveControlsPinned,
        immersiveControlsVisible,
        setImmersiveControlsVisible,
        immersiveAmbientEnabled,
        setImmersiveAmbientEnabled,
        immersiveAmbientIntensity,
        setImmersiveAmbientIntensity,
    } = useUIStore(useShallow((state) => ({
        isFullScreen: state.isFullScreen,
        setIsFullScreen: state.setIsFullScreen,
        setIsFullScreenClosing: state.setIsFullScreenClosing,
        isPlaylistOpen: state.isPlaylistOpen,
        visualMotionPhase: state.visualMotionPhase,
        setVisualMotionPhase: state.setVisualMotionPhase,
        immersiveControlsPinned: state.immersiveControlsPinned,
        setImmersiveControlsPinned: state.setImmersiveControlsPinned,
        immersiveControlsVisible: state.immersiveControlsVisible,
        setImmersiveControlsVisible: state.setImmersiveControlsVisible,
        immersiveAmbientEnabled: state.immersiveAmbientEnabled,
        setImmersiveAmbientEnabled: state.setImmersiveAmbientEnabled,
        immersiveAmbientIntensity: state.immersiveAmbientIntensity,
        setImmersiveAmbientIntensity: state.setImmersiveAmbientIntensity,
    })));
    const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', false);
    const [isChromeVisible, setIsChromeVisible] = React.useState(true);
    const [hasCurrentSongPlayed, setHasCurrentSongPlayed] = React.useState(false);
    const [isVisualResetPending, setIsVisualResetPending] = React.useState(false);
    const chromeTimerRef = React.useRef(null);
    const stageRef = React.useRef(null);
    const initialVisualSongKey = `${currentSong?.id || ''}|${currentSong?.audio_url || ''}`;
    const visualSongKeyRef = React.useRef(initialVisualSongKey);
    const expectedVisualSrcRef = React.useRef('');
    const loadedDeclaredSrcRef = React.useRef('');
    // 记录已写入默认设置的沉浸主题 id：仅在主题切换/首次进入时写入，
    // 避免每次进入全屏都用 defaultSettings 覆盖 useThemeStore，导致手动调试值被重置。
    const appliedThemeDefaultsRef = React.useRef('');

    const { 
        setGlassMaterial, 
        setAccentColor, 
        setFontFamily,
        setLyricShadow 
    } = useThemeStore(useShallow((state) => ({
        setGlassMaterial: state.setGlassMaterial,
        setAccentColor: state.setAccentColor,
        setFontFamily: state.setFontFamily,
        setLyricShadow: state.setLyricShadow,
    })));

    const activeTheme = getImmersiveTheme('artist-photo');
    const showNoLyricsVisual = ['none', 'unavailable', 'error'].includes(lyricsStatus);
    const noLyricsVisualActive = showNoLyricsVisual && hasCurrentSongPlayed && !isVisualResetPending;
    const expectedAudioSrc = currentSong?.audio_url
        ? (() => {
            try { return new URL(currentSong.audio_url, window.location.href).href; }
            catch { return currentSong.audio_url || ''; }
        })()
        : '';
    expectedVisualSrcRef.current = expectedAudioSrc;
    const handleVisualModeCollapsed = React.useCallback(() => {
        setIsVisualResetPending(false);
    }, []);

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
        focusTargetRef: stageRef,
        onBeforeClose: () => setGlassMaterial('glass-light'),
    });

    React.useLayoutEffect(() => {
        const audio = audioRef?.current;
        const songKey = `${currentSong?.id || ''}|${currentSong?.audio_url || ''}`;
        const songChanged = visualSongKeyRef.current !== songKey;
        if (songChanged) {
            visualSongKeyRef.current = songKey;
            setIsVisualResetPending(true);
        }
        setHasCurrentSongPlayed(false);
        if (!audio || !currentSong) return undefined;

        const declaredSrc = audio.getAttribute('src') || audio.src;
        const declaredAbsoluteSrc = declaredSrc
            ? new URL(declaredSrc, window.location.href).href
            : '';
        if (!audio.paused
            && audio.readyState >= 2
            && declaredAbsoluteSrc === expectedAudioSrc
            && loadedDeclaredSrcRef.current === expectedAudioSrc) {
            setHasCurrentSongPlayed(true);
        }
        return undefined;
    }, [audioRef, currentSong?.id, currentSong?.audio_url, expectedAudioSrc]);

    React.useEffect(() => {
        const audio = audioRef?.current;
        if (!audio) return undefined;

        const getDeclaredSrc = () => {
            const declaredSrc = audio.getAttribute('src') || audio.src;
            return declaredSrc
                ? new URL(declaredSrc, window.location.href).href
                : '';
        };
        const handleLoadStart = () => {
            loadedDeclaredSrcRef.current = '';
        };
        const handleLoadedMetadata = () => {
            loadedDeclaredSrcRef.current = getDeclaredSrc();
        };
        const handlePlaying = () => {
            const declaredSrc = getDeclaredSrc();
            if (declaredSrc) {
                loadedDeclaredSrcRef.current = declaredSrc;
                setHasCurrentSongPlayed(true);
            }
        };

        if (audio.readyState >= 1) {
            loadedDeclaredSrcRef.current = getDeclaredSrc();
        }
        if (!audio.paused && audio.readyState >= 2) {
            handlePlaying();
        }

        audio.addEventListener('loadstart', handleLoadStart);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('playing', handlePlaying);
        return () => {
            audio.removeEventListener('loadstart', handleLoadStart);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('playing', handlePlaying);
        };
    }, [audioRef]);

    const shouldMountAudioAura = hasEntered;
    const suspendPlayerEffects = isClosing
        || isPlaylistOpen
        || visualMotionPhase === VISUAL_MOTION_PHASE.DRAWER;

    React.useEffect(() => {
        if (appliedThemeDefaultsRef.current === activeTheme.id) return;
        appliedThemeDefaultsRef.current = activeTheme.id;
        if (activeTheme.defaultSettings) {
            setGlassMaterial(activeTheme.defaultSettings.glassMaterial);
            setAccentColor(activeTheme.defaultSettings.accentColor);
            setFontFamily(activeTheme.defaultSettings.fontFamily);
            setLyricShadow(activeTheme.defaultSettings.lyricShadow);
            if (activeTheme.defaultSettings.ambientIntensity) {
                setImmersiveAmbientIntensity(activeTheme.defaultSettings.ambientIntensity);
            }
        }
    }, [activeTheme, setAccentColor, setFontFamily, setGlassMaterial, setImmersiveAmbientIntensity, setLyricShadow]);
    const revealChrome = React.useCallback(() => {
        setIsChromeVisible(true);
        setImmersiveControlsVisible(true);
        if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);

        chromeTimerRef.current = setTimeout(() => {
            setIsChromeVisible(false);
            if (!immersiveControlsPinned) {
                setImmersiveControlsVisible(false);
            }
        }, 2600);
    }, [immersiveControlsPinned, setImmersiveControlsVisible]);

    React.useEffect(() => {
        revealChrome();
        return () => {
            if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
        };
    }, [revealChrome, currentSong?.id]);

    React.useEffect(() => {
        if (immersiveControlsPinned) {
            setImmersiveControlsVisible(true);
        } else {
            revealChrome();
        }
    }, [immersiveControlsPinned, revealChrome, setImmersiveControlsVisible]);

    return (
        <div
            ref={stageRef}
            aria-label={t("沉浸式播放器画面")}
            tabIndex={-1}
            className={`fixed inset-0 z-50 overflow-hidden bg-black text-white ${(hasMounted && isFullScreen && !isClosing) ? 'translate-y-0' : 'translate-y-full'} ${instantEnter ? 'player-mode-fade-in' : ''}`}
            style={{
                transitionProperty: hasMounted ? 'transform' : 'none',
                transitionDuration: prefersReducedMotion ? '150ms' : '620ms',
                transitionTimingFunction: 'cubic-bezier(0.22,1,0.36,1)',
                contain: 'layout style',
            }}
            onMouseMove={revealChrome}
            onClick={revealChrome}
            onTransitionEnd={handleStageTransitionEnd}
        >
            <ImmersiveBackground
                theme={activeTheme}
                artistName={currentSong?.artist || ''}
                coverUrl={resolveCoverUrl(currentSong?.cover_url || '')}
                prefersReducedMotion={prefersReducedMotion}
                isPlaying={isPlaying}
                isBuffering={isBuffering}
                mediaEnabled={hasEntered}
                active={hasEntered && !isClosing}
                suspendEffects={suspendPlayerEffects}
            />

            {shouldMountAudioAura && <ImmersiveAudioAura
                audioRef={audioRef}
                isPlaying={isPlaying}
                isBuffering={isBuffering}
                enabled={hasEntered && immersiveAmbientEnabled && !prefersReducedMotion}
                suspended={suspendPlayerEffects || !hasEntered}
                intensity={immersiveAmbientIntensity}
                containerRef={stageRef}
                visualMode={showNoLyricsVisual
                    ? (noLyricsVisualActive ? 'no-lyrics' : 'no-lyrics-idle')
                    : 'ambient'}
                prefersReducedMotion={prefersReducedMotion}
                presentationReady={hasEntered}
                onModeCollapsed={handleVisualModeCollapsed}
            />}

            <ImmersiveChrome
                isVisible={isChromeVisible}
                controlsPinned={immersiveControlsPinned}
                ambientEnabled={immersiveAmbientEnabled}
                ambientIntensity={immersiveAmbientIntensity}
                onClose={handleClose}
                onReveal={revealChrome}
                modeSwitcher={<PlayerSkinEntry variant="immersive" />}
                toolEntry={<LyricsWorkspaceEntry variant="immersive" />}
                onControlsPinnedChange={(value) => {
                    setImmersiveControlsPinned(value);
                    revealChrome();
                }}
                onAmbientEnabledChange={setImmersiveAmbientEnabled}
                onAmbientIntensityChange={setImmersiveAmbientIntensity}
            />

            {ThemeDebugger && (
                <React.Suspense fallback={null}>
                    <ThemeDebugger />
                </React.Suspense>
            )}

            <div className="relative z-10 flex h-full w-full items-center justify-center px-10 pt-16 pb-40">
                <ImmersiveLyrics
                    lyrics={lyrics}
                    currentLyricIndex={currentLyricIndex}
                    isLyricsLoading={isLyricsLoading}
                    currentSong={currentSong}
                    translationEnabled={translationEnabled}
                    lyricSyncMode={lyricSyncMode}
                    lyricIntro={lyricIntro}
                    isPlaying={isPlaying}
                    isBuffering={isBuffering}
                    prefersReducedMotion={prefersReducedMotion}
                    surfaceVisible={Boolean(isFullScreen && hasEntered && !isClosing)}
                    motionEnabled={!suspendPlayerEffects && motionProfile === 'full'}
                />
            </div>
        </div>
    );
}
