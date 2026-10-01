import { t } from '../../i18n/index.js';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useThemeStore } from '../../store/useThemeStore';
import {
    getEffectConfig,
    resolveLyricEffect,
} from '../../constants/lyricEffects';
import { lyricPlaybackClock } from '../../services/lyricPlaybackClock';
import { resolveLineWordProgress } from '../../utils/lyricTimeline';
import { computeAdaptiveLineTiming } from '../../utils/lyricAdaptiveTiming';
import {
    createImmersiveLyricState,
    IMMERSIVE_LYRIC_ACTIONS,
    IMMERSIVE_LYRIC_TRANSITIONS,
    reduceImmersiveLyricState,
} from '../../utils/immersiveLyricState';
import SyncedLyricText from '../lyrics/SyncedLyricText';
import { useLyricSurfacePresentation } from '../lyrics/lyricSurfacePresentation';

const NATURAL_ADVANCE_REASONS = new Set(['animation-frame', 'timeupdate']);
const EXIT_ANIMATION_BY_GROUP = Object.freeze({
    space: 'immersive-exit-space',
    focus: 'immersive-exit-focus',
    direction: 'immersive-exit-direction',
    light: 'immersive-exit-light',
});

const stringValue = (value) => (typeof value === 'string' ? value : '');

export function getImmersiveSongKey(song) {
    const id = String(song?.id ?? '').trim();
    const audioUrl = String(song?.audio_url ?? '').trim();
    if (id) return `id:${id}`;
    if (audioUrl) return `audio:${audioUrl}`;

    const metadataKey = [
        song?.title,
        song?.artist,
        song?.album,
        song?.duration,
    ].map((value) => String(value ?? '')).join('|');
    return `metadata:${metadataKey}`;
}

const getClockGateKey = (snapshot) => [
    snapshot?.visible !== false ? 'visible' : 'hidden',
    snapshot?.paused ? 'paused' : 'playing',
    snapshot?.seeking ? 'seeking' : 'settled',
    snapshot?.buffering ? 'buffering' : 'ready',
    snapshot?.ended ? 'ended' : 'active',
].join(':');

/**
 * Observe only low-frequency clock flags. Per-frame currentTime changes keep
 * the same primitive snapshot and therefore never re-render this component.
 */
function useLyricClockGate(clock) {
    const getSnapshot = React.useCallback(
        () => getClockGateKey(clock.getSnapshot()),
        [clock],
    );
    const subscribe = React.useCallback((notify) => {
        let previousKey = getSnapshot();
        return clock.subscribe((snapshot) => {
            const nextKey = getClockGateKey(snapshot);
            if (nextKey === previousKey) return;
            previousKey = nextKey;
            notify();
        });
    }, [clock, getSnapshot]);

    React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return clock.getSnapshot();
}

export function resolveImmersiveLyricTransition(snapshot, motionRunning) {
    if (snapshot?.seeking || snapshot?.reason === 'seeking' || snapshot?.reason === 'seeked') {
        return IMMERSIVE_LYRIC_TRANSITIONS.SEEK;
    }
    if (!motionRunning) return IMMERSIVE_LYRIC_TRANSITIONS.SYNC;
    return IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE;
}

function getFontFamilyStyle(fontFamily) {
    switch (fontFamily) {
        case 'font-serif': return { fontFamily: '"Noto Serif SC", "SimSun", "PMingLiU", serif' };
        case 'font-mono': return { fontFamily: '"Fira Code", "Consolas", monospace' };
        case 'font-kai': return { fontFamily: '"KaiTi", "STKaiti", "BiauKai", "楷体", serif' };
        case 'font-round': return { fontFamily: '"Yuanti SC", "圆体", "Source Han Sans SC", "Noto Sans SC", system-ui, sans-serif' };
        case 'font-sans':
        default: return { fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' };
    }
}

function getReadableTextStyle(lyricShadow) {
    const optionalShadow = lyricShadow === 'heavy'
        ? ', 0 0 20px rgba(255,255,255,0.4)'
        : lyricShadow === 'light'
            ? ', 0 4px 12px rgba(0,0,0,0.6)'
            : '';
    return {
        textShadow: `0 0 var(--immersive-lyric-glow-size, 8px) rgba(255,255,255,var(--immersive-lyric-glow-alpha,0.16)), 0 3px 18px rgba(0,0,0,var(--immersive-readable-shadow-alpha,0.45)), 0 0 3px rgba(0,0,0,var(--immersive-readable-stroke-alpha,0))${optionalShadow}`,
        WebkitTextStroke: 'var(--immersive-readable-stroke-width,0px) rgba(0,0,0,var(--immersive-readable-stroke-alpha,0))',
    };
}

function hasRenderableWordTiming(line, text) {
    const words = Array.isArray(line?.words) ? line.words : [];
    return words.length > 0
        && words.map((word) => String(word?.text || '')).join('') === text
        && resolveLineWordProgress(line, 0).hasWordTiming;
}

function getLayerStyle(effect, timing) {
    const enterMs = timing?.lineEnterMs ?? effect?.motionBudget?.enterMs ?? 380;
    const exitMs = timing?.lineExitMs ?? effect?.motionBudget?.exitMs ?? 320;
    return {
        '--immersive-enter-ms': `${enterMs}ms`,
        '--immersive-exit-ms': `${exitMs}ms`,
        '--line-enter-ms': `${enterMs}ms`,
        '--line-exit-ms': `${exitMs}ms`,
    };
}

function LoadingSkeleton({ motionRunning }) {
    return (
        <div
            className="immersive-lyrics"
            data-motion-running={motionRunning ? 'true' : 'false'}
            aria-busy="true"
            aria-label={t("歌词加载中")}
        >
            <div className="flex flex-col items-center justify-center">
                <div className="immersive-lyrics__loading-spinner mb-7 h-10 w-10 rounded-full border-[3px] border-white/15 border-t-white/80 animate-spin" />
                <div className="space-y-4">
                    <div className="h-5 w-72 max-w-[70vw] overflow-hidden rounded-full bg-white/12">
                        <div className="immersive-lyrics__loading-shimmer h-full w-1/2 animate-[shimmer_1.4s_infinite] bg-gradient-to-r from-transparent via-white/35 to-transparent" />
                    </div>
                    <div className="mx-auto h-4 w-44 max-w-[48vw] overflow-hidden rounded-full bg-white/10">
                        <div className="immersive-lyrics__loading-shimmer h-full w-1/2 animate-[shimmer_1.4s_infinite] bg-gradient-to-r from-transparent via-white/25 to-transparent" />
                    </div>
                </div>
            </div>
        </div>
    );
}

function StaticExitLine({ layer, translationEnabled, lyricShadow, onAnimationEnd }) {
    const effect = getEffectConfig(layer.effectId);
    const timing = React.useMemo(() => computeAdaptiveLineTiming({
        line: layer.line,
        prevLine: layer.prevLine,
        nextLine: layer.nextLine,
    }), [layer.line, layer.prevLine, layer.nextLine]);
    const scheme = effect.scheme || 'scheme-warp';

    return (
        <div className="immersive-lyrics__layer" aria-hidden="true">
            <div
                className={`immersive-lyrics__line ${scheme}`}
                data-layer="exit"
                data-scheme={scheme}
                data-effect={effect.id}
                data-effect-group={effect.group}
                data-word-event="none"
                data-line-index={layer.lineIndex}
                data-exit-token={layer.token}
                style={getLayerStyle(effect, timing)}
                onAnimationEnd={onAnimationEnd}
            >
                <div className="immersive-lyrics__content">
                    <span
                        className="immersive-lyrics__original"
                        style={getReadableTextStyle(lyricShadow)}
                    >
                        {layer.text}
                    </span>
                    {translationEnabled && layer.translation && (
                        <span
                            className="immersive-lyrics__translation"
                            data-translation-progress="none"
                        >
                            {layer.translation}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

function ActiveLyricLine({
    layer,
    effect,
    lyricSyncMode,
    surfaceVisible,
    translationEnabled,
    prefersReducedMotion,
    lyricShadow,
}) {
    const translationProgressRef = React.useRef(null);
    const timing = React.useMemo(() => computeAdaptiveLineTiming({
        line: layer.line,
        prevLine: layer.prevLine,
        nextLine: layer.nextLine,
    }), [layer.line, layer.prevLine, layer.nextLine]);
    const scheme = effect.scheme || 'scheme-warp';

    const canRenderWordEffect = lyricSyncMode === 'word'
        && layer.kind === 'line'
        && !prefersReducedMotion
        && hasRenderableWordTiming(layer.line, layer.text);
    const canTrackLineProgress = effect.translationProgress === 'line'
        && canRenderWordEffect;
    const translationProgress = canTrackLineProgress ? 'line' : 'none';

    return (
        <div className="immersive-lyrics__layer" aria-live="polite" aria-atomic="true">
            <div
                className={`immersive-lyrics__line ${scheme}`}
                data-layer="active"
                data-scheme={scheme}
                data-effect={effect.id}
                data-effect-group={effect.group}
                data-word-event={canRenderWordEffect ? effect.wordEvent : 'none'}
                data-resident-motion={effect.motionBudget.resident ? 'true' : 'false'}
                data-animate-entry={layer.animateEntry ? 'true' : 'false'}
                data-line-index={layer.lineIndex}
                data-presentation={layer.kind}
                style={getLayerStyle(effect, timing)}
            >
                <div className="immersive-lyrics__content">
                    <span
                        className="immersive-lyrics__original"
                        style={getReadableTextStyle(lyricShadow)}
                    >
                        <SyncedLyricText
                            line={layer.line}
                            text={layer.text}
                            active
                            visible={surfaceVisible}
                            syncMode={lyricSyncMode}
                            surface="immersive"
                            lineProgressRef={canTrackLineProgress ? translationProgressRef : null}
                        />
                    </span>
                    {translationEnabled && layer.translation && (
                        <span
                            ref={translationProgressRef}
                            className="immersive-lyrics__translation"
                            data-translation-progress={translationProgress}
                        >
                            {layer.translation}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function ImmersiveLyrics({
    lyrics,
    currentLyricIndex,
    isLyricsLoading,
    currentSong,
    translationEnabled = false,
    lyricSyncMode = 'line',
    lyricIntro = null,
    isPlaying = false,
    isBuffering = false,
    prefersReducedMotion = false,
    surfaceVisible = true,
    motionEnabled = true,
    clock = lyricPlaybackClock,
}) {
    const {
        fontFamily,
        lyricTransition,
        lyricShadow,
        setResolvedTransition,
    } = useThemeStore(useShallow((state) => ({
        fontFamily: state.fontFamily,
        lyricTransition: state.lyricTransition,
        lyricShadow: state.lyricShadow,
        setResolvedTransition: state.setResolvedTransition,
    })));
    const safeLyrics = Array.isArray(lyrics) ? lyrics : [];
    const songKey = React.useMemo(() => getImmersiveSongKey(currentSong), [
        currentSong?.id,
        currentSong?.audio_url,
        currentSong?.title,
        currentSong?.artist,
        currentSong?.album,
        currentSong?.duration,
    ]);
    const presentation = useLyricSurfacePresentation({
        lyrics: isLyricsLoading ? [] : safeLyrics,
        currentLyricIndex,
        lyricIntro,
        lyricSyncMode,
        surfaceVisible,
        clock,
    });
    const effect = React.useMemo(
        () => resolveLyricEffect(lyricTransition, songKey, presentation.index),
        [lyricTransition, songKey, presentation.index],
    );
    const clockSnapshot = useLyricClockGate(clock);
    const motionRunning = Boolean(
        motionEnabled
        && surfaceVisible
        && isPlaying
        && !isBuffering
        && !prefersReducedMotion
        && clockSnapshot.visible !== false
        && !clockSnapshot.paused
        && !clockSnapshot.seeking
        && !clockSnapshot.buffering
        && !clockSnapshot.ended
    );
    const transition = resolveImmersiveLyricTransition(clockSnapshot, motionRunning);
    const presentationLine = presentation.line;
    const presentationText = presentation.kind === 'none'
        ? ''
        : typeof presentationLine === 'string'
            ? presentationLine
            : stringValue(presentationLine?.text);
    const presentationTranslation = typeof presentationLine === 'object' && presentationLine !== null
        ? stringValue(presentationLine.translation)
        : '';
    const exitAnimationName = React.useCallback((previousLayer) => {
        const group = previousLayer?.effectId
            ? getEffectConfig(previousLayer.effectId).group
            : effect.group;
        return EXIT_ANIMATION_BY_GROUP[group] || EXIT_ANIMATION_BY_GROUP.space;
    }, [effect.group]);
    const prevLine = presentation.index > 0 ? safeLyrics[presentation.index - 1] : null;
    const nextLine = presentation.index >= 0 && presentation.index < safeLyrics.length - 1 ? safeLyrics[presentation.index + 1] : null;

    const syncAction = React.useMemo(() => ({
        type: IMMERSIVE_LYRIC_ACTIONS.SYNC,
        songKey,
        presentation,
        lineIndex: presentation.index,
        line: presentationLine,
        prevLine,
        nextLine,
        text: presentationText,
        translation: presentationTranslation,
        effectId: effect.id,
        transition,
        animateEntry: transition === IMMERSIVE_LYRIC_TRANSITIONS.ADVANCE,
        exitAnimationName,
        loading: isLyricsLoading,
        // The reducer's visibility gate controls transition layers, not lyric
        // readability. A paused/buffered/suspended surface keeps the active
        // line but immediately drops any decorative exit layer.
        visible: motionRunning,
        reducedMotion: prefersReducedMotion,
    }), [
        clockSnapshot.visible,
        effect.id,
        exitAnimationName,
        isLyricsLoading,
        motionRunning,
        nextLine,
        prefersReducedMotion,
        presentation.index,
        presentation.kind,
        presentationLine,
        presentationText,
        presentationTranslation,
        prevLine,
        songKey,
        surfaceVisible,
        transition,
    ]);
    const [lyricState, dispatch] = React.useReducer(
        reduceImmersiveLyricState,
        undefined,
        createImmersiveLyricState,
    );

    React.useLayoutEffect(() => {
        dispatch(syncAction);
    }, [syncAction]);

    React.useEffect(() => {
        setResolvedTransition(effect.id);
    }, [effect.id, setResolvedTransition]);

    const handleExitAnimationEnd = React.useCallback((event) => {
        if (event.target !== event.currentTarget || !lyricState.exiting) return;
        dispatch({
            type: IMMERSIVE_LYRIC_ACTIONS.ANIMATION_END,
            token: lyricState.exiting.token,
            identity: lyricState.exiting.identity,
            animationName: event.animationName,
        });
    }, [lyricState.exiting]);

    if (isLyricsLoading) {
        return <LoadingSkeleton motionRunning={motionRunning} />;
    }
    if (presentation.kind === 'none' || !presentationText || !lyricState.active) return null;

    const activeEffect = getEffectConfig(lyricState.active.effectId);
    const activeScheme = activeEffect.scheme || 'scheme-warp';
    const activeTranslationProgress = activeEffect.translationProgress === 'line'
        && lyricSyncMode === 'word'
        && lyricState.active.kind === 'line'
        && !prefersReducedMotion
        && hasRenderableWordTiming(lyricState.active.line, lyricState.active.text)
        ? 'line'
        : 'none';

    return (
        <div
            className={`immersive-lyrics select-none ${activeScheme}`}
            style={getFontFamilyStyle(fontFamily)}
            data-effect={activeEffect.id}
            data-effect-group={activeEffect.group}
            data-scheme={activeScheme}
            data-sync-mode={lyricSyncMode}
            data-motion-running={motionRunning ? 'true' : 'false'}
            data-translation-progress={activeTranslationProgress}
            data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
        >
            <div className={`immersive-lyrics__stage ${activeScheme}`} data-scheme={activeScheme}>
                {lyricState.exiting && (
                    <StaticExitLine
                        key={`exit:${lyricState.exiting.token}`}
                        layer={lyricState.exiting}
                        translationEnabled={translationEnabled}
                        lyricShadow={lyricShadow}
                        onAnimationEnd={handleExitAnimationEnd}
                    />
                )}
                <ActiveLyricLine
                    key={lyricState.active.identity}
                    layer={lyricState.active}
                    effect={activeEffect}
                    lyricSyncMode={lyricSyncMode}
                    surfaceVisible={surfaceVisible}
                    translationEnabled={translationEnabled}
                    prefersReducedMotion={prefersReducedMotion}
                    lyricShadow={lyricShadow}
                />
            </div>
        </div>
    );
}
