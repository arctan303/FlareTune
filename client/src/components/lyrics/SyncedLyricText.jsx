import React from 'react';
import { lyricPlaybackClock } from '../../services/lyricPlaybackClock.js';
import { resolveLineWordProgress, segmentLyricGraphemes } from '../../utils/lyricTimeline.js';
import { computeAdaptiveWordTiming } from '../../utils/lyricAdaptiveTiming.js';
import './synced-lyric-text.css';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const WORD_TIMELINE_DURATION_MS = 1000;
const WORD_LEAD_IN_SECONDS = 0.42;

const clampProgress = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export default function SyncedLyricText({
    line,
    text,
    active = false,
    visible = true,
    syncMode = 'line',
    surface = 'classic',
    className = '',
    clock = lyricPlaybackClock,
    lineProgressRef = null,
}) {
    const displayText = typeof text === 'string' ? text : String(line?.text || '');
    const words = Array.isArray(line?.words) ? line.words : [];
    const projectionMatches = words.length > 0
        && words.map((word) => String(word?.text || '')).join('') === displayText;
    const hasReliableWordTiming = React.useMemo(
        () => resolveLineWordProgress(line, 0).hasWordTiming,
        [line],
    );
    const shouldSync = Boolean(
        active
        && visible
        && syncMode === 'word'
        && projectionMatches
        && hasReliableWordTiming
    );
    const wordRefs = React.useRef([]);
    const characterRefs = React.useRef([]);
    const wordCharacters = React.useMemo(
        () => shouldSync && surface === 'classic'
            ? words.map((word) => segmentLyricGraphemes(word.text))
            : [],
        [shouldSync, surface, words],
    );
    const rootRef = React.useRef(null);
    const lastBoundaryRef = React.useRef(null);
    const lineProgressTargetRef = React.useRef(null);
    const lastLineProgressRef = React.useRef(null);

    const updatePlayerBarScroll = React.useCallback((resolved, prefersReducedMotion) => {
        if (surface !== 'playerbar') return;
        const rootEl = rootRef.current;
        if (!rootEl) return;

        const parentEl = rootEl.parentElement;
        const viewportWidth = parentEl?.clientWidth || rootEl.clientWidth || 0;
        const contentWidth = rootEl.scrollWidth || 0;
        const maxScroll = Math.max(0, contentWidth - viewportWidth);

        if (maxScroll <= 0) {
            rootEl.style.removeProperty('--synced-scroll-x');
            return;
        }

        let focusX = 0;
        if (resolved.isComplete) {
            focusX = contentWidth;
        } else if (resolved.activeWordIndex >= 0) {
            const wordEl = wordRefs.current[resolved.activeWordIndex];
            if (wordEl) {
                const wordLeft = wordEl.offsetLeft;
                const wordWidth = wordEl.offsetWidth;
                const progress = prefersReducedMotion ? 0 : clampProgress(resolved.wordProgress);
                focusX = wordLeft + wordWidth * progress;
            } else {
                focusX = contentWidth * clampProgress(resolved.lineProgress);
            }
        }

        const idealOffset = (contentWidth / 2) - focusX;
        const limit = maxScroll / 2;
        const clampedTranslateX = Math.max(-limit, Math.min(limit, idealOffset));
        rootEl.style.setProperty('--synced-scroll-x', `${clampedTranslateX.toFixed(2)}px`);
    }, [surface]);

    const clearLineProgressTarget = React.useCallback(() => {
        const target = lineProgressTargetRef.current;
        target?.style?.removeProperty?.('--synced-line-progress');
        lineProgressTargetRef.current = null;
    }, []);

    const setLineProgress = React.useCallback((progress) => {
        const normalizedProgress = clampProgress(progress);
        const nextTarget = lineProgressRef?.current || null;
        if (lineProgressTargetRef.current !== nextTarget) {
            clearLineProgressTarget();
            lineProgressTargetRef.current = nextTarget;
        }
        lastLineProgressRef.current = normalizedProgress;
        nextTarget?.style?.setProperty?.('--synced-line-progress', `${normalizedProgress * 100}%`);
    }, [clearLineProgressTarget, lineProgressRef]);

    // A parent can replace the DOM node held by the same object ref without
    // changing this component's props. Re-publish the last sampled value after
    // that commit; the clock subscription remains the sole timeline source.
    React.useLayoutEffect(() => {
        if (!shouldSync || !lineProgressRef || lastLineProgressRef.current === null) return;
        setLineProgress(lastLineProgressRef.current);
    });

    React.useLayoutEffect(() => {
        if (!shouldSync && surface === 'playerbar' && rootRef.current) {
            rootRef.current.style.removeProperty('--synced-scroll-x');
        }
        const shouldObserve = shouldSync || (surface === 'classic' && active && visible);
        if (!shouldObserve) {
            if (rootRef.current?.dataset) rootRef.current.dataset.motionRunning = 'false';
            return undefined;
        }

        const mediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(REDUCED_MOTION_QUERY)
            : null;
        let prefersReducedMotion = mediaQuery?.matches === true;

        const setWordState = (index, progress, state) => {
            const element = wordRefs.current[index];
            if (!element) return;
            const normalizedProgress = clampProgress(progress);
            const timelineOffset = normalizedProgress === 0
                ? 0
                : -normalizedProgress * WORD_TIMELINE_DURATION_MS;
            element.style.setProperty('--synced-word-progress', `${normalizedProgress * 100}%`);
            element.style.setProperty('--synced-word-timeline-offset', `${timelineOffset}ms`);
            if (element.dataset.wordState !== state) {
                element.dataset.wordState = state;
            }
            if (surface === 'classic') {
                const characters = wordCharacters[index] || [];
                characters.forEach((_, characterIndex) => {
                    const character = characterRefs.current[index]?.[characterIndex];
                    if (!character) return;
                    const progress = clampProgress(normalizedProgress * characters.length - characterIndex);
                    // Smooth only the currently filling glyph; completed glyphs stay level.
                    const lift = prefersReducedMotion ? 0 : -1.8 * progress * progress * (3 - 2 * progress);
                    character.style.setProperty('--synced-word-progress', `${progress * 100}%`);
                    character.style.setProperty('--synced-char-lift', `${lift.toFixed(3)}px`);
                    character.dataset.charState = progress >= 1 ? 'complete' : progress > 0 ? 'active' : 'pending';
                });
            }
        };

        const getWordLeadIn = (word) => (
            surface === 'immersive' && word
                ? computeAdaptiveWordTiming(word).wordLeadIn
                : WORD_LEAD_IN_SECONDS
        );

        const syncBoundary = (resolved, force = false, currentTime = 0) => {
            const boundaryKey = `${resolved.activeWordIndex}:${resolved.hasStarted}:${resolved.isComplete}:${prefersReducedMotion}`;
            if (!force && boundaryKey === lastBoundaryRef.current) return false;
            lastBoundaryRef.current = boundaryKey;

            for (let index = 0; index < words.length; index += 1) {
                if (resolved.isComplete || index < resolved.activeWordIndex) {
                    setWordState(index, 1, 'complete');
                } else if (index === resolved.activeWordIndex && resolved.hasStarted) {
                    const progress = prefersReducedMotion ? 1 : resolved.wordProgress;
                    setWordState(index, progress, progress >= 1 ? 'complete' : 'active');
                } else {
                    const word = words[index];
                    const leadIn = getWordLeadIn(word);
                    const isEntering = surface === 'immersive'
                        && !prefersReducedMotion
                        && word
                        && currentTime >= (word.startTime - leadIn)
                        && currentTime < word.startTime;
                    setWordState(index, 0, isEntering ? 'entering' : 'pending');
                }
            }
            return true;
        };

        const applySnapshot = (snapshot, force = false) => {
            if (surface === 'classic' && rootRef.current?.dataset) {
                rootRef.current.dataset.motionRunning = !prefersReducedMotion
                    && snapshot?.visible !== false && !snapshot?.paused
                    && !snapshot?.buffering && !snapshot?.seeking && !snapshot?.ended
                    ? 'true' : 'false';
            }
            if (!shouldSync) return;
            const currentTime = snapshot?.currentTime ?? 0;
            const resolved = resolveLineWordProgress(line, currentTime);
            if (!resolved.hasWordTiming) {
                clearLineProgressTarget();
                lastLineProgressRef.current = null;
                if (surface === 'playerbar' && rootRef.current) {
                    rootRef.current.style.removeProperty('--synced-scroll-x');
                }
                return;
            }
            const crossedBoundary = syncBoundary(resolved, force, currentTime);
            if (!prefersReducedMotion || crossedBoundary) {
                setLineProgress(resolved.lineProgress);
            }
            if (!prefersReducedMotion && !crossedBoundary && resolved.activeWordIndex >= 0) {
                setWordState(resolved.activeWordIndex, resolved.wordProgress, 'active');
            }
            if (surface === 'playerbar' && (!prefersReducedMotion || crossedBoundary)) {
                updatePlayerBarScroll(resolved, prefersReducedMotion);
            }
            if (surface === 'immersive' && !prefersReducedMotion && !crossedBoundary) {
                const startIndex = Math.max(0, resolved.activeWordIndex + (resolved.hasStarted ? 1 : 0));
                for (let index = startIndex; index < words.length; index += 1) {
                    const word = words[index];
                    if (!word) continue;
                    const leadIn = getWordLeadIn(word);
                    if (currentTime >= (word.startTime - leadIn) && currentTime < word.startTime) {
                        const element = wordRefs.current[index];
                        if (element && element.dataset.wordState !== 'entering') {
                            setWordState(index, 0, 'entering');
                        }
                    } else if (currentTime < (word.startTime - leadIn)) {
                        const element = wordRefs.current[index];
                        if (element && element.dataset.wordState !== 'pending') {
                            setWordState(index, 0, 'pending');
                        }
                    }
                }
            }
        };

        applySnapshot(clock.getSnapshot(), true);
        const frameStart = shouldSync ? words[0].startTime - (surface === 'immersive' ? getWordLeadIn(words[0]) : 0) : Infinity;
        const frameEnd = shouldSync ? words.at(-1).endTime : Infinity;
        const unsubscribe = clock.subscribe((snapshot) => applySnapshot(snapshot), {
            animationFrames: (snapshot) => !prefersReducedMotion
                && snapshot.currentTime >= frameStart && snapshot.currentTime < frameEnd,
            getNextBoundary: (snapshot) => {
                const future = [frameStart, ...words.flatMap((word) => [word.startTime, word.endTime])]
                    .filter((time) => time > snapshot.currentTime);
                return future.length ? Math.min(...future) : null;
            },
        });
        const handleMotionChange = (event) => {
            prefersReducedMotion = event.matches === true;
            lastBoundaryRef.current = null;
            applySnapshot(clock.getSnapshot(), true);
            clock.sample?.('motion-preference-change');
        };
        const handleResize = () => {
            if (surface === 'playerbar') {
                applySnapshot(clock.getSnapshot(), true);
            }
        };
        mediaQuery?.addEventListener?.('change', handleMotionChange);
        window.addEventListener('resize', handleResize);

        return () => {
            unsubscribe?.();
            mediaQuery?.removeEventListener?.('change', handleMotionChange);
            window.removeEventListener('resize', handleResize);
            lastBoundaryRef.current = null;
            lastLineProgressRef.current = null;
            clearLineProgressTarget();
            if (surface === 'playerbar' && rootRef.current) {
                rootRef.current.style.removeProperty('--synced-scroll-x');
            }
        };
    }, [active, visible, clearLineProgressTarget, clock, line, setLineProgress, shouldSync, words, wordCharacters, surface, updatePlayerBarScroll]);

    return (
        <span
            ref={rootRef}
            className={`synced-lyric-text ${className}`.trim()}
            data-synced={shouldSync ? 'word' : 'static'}
            data-surface={surface}
            data-active={active ? 'true' : 'false'}
        >
            <span className="synced-lyric-text__accessible">{displayText}</span>
            <span className="synced-lyric-text__visual" aria-hidden="true">
                {shouldSync
                    ? words.map((word, index) => {
                        if (surface === 'immersive') {
                            const isSpace = word?.isSpace || word?.text === ' ' || word?.text === '　';
                            const timing = computeAdaptiveWordTiming(word);
                            const wordStyle = { '--word-anim-ms': `${timing.wordAnimMs}ms` };
                            return (
                                <span
                                    key={`${index}-${word.startTime}-${word.endTime}`}
                                    ref={(node) => { wordRefs.current[index] = node; }}
                                    className={`synced-lyric-text__word word-slot ${isSpace ? 'is-space' : ''}`.trim()}
                                    data-word-state="pending"
                                    style={wordStyle}
                                >
                                    <span className="word-char">{word.text}</span>
                                </span>
                            );
                        }
                        return (
                            <span
                                key={`${index}-${word.startTime}-${word.endTime}`}
                                ref={(node) => { wordRefs.current[index] = node; }}
                                className="synced-lyric-text__word"
                                data-word-state="pending"
                            >
                                {surface === 'classic'
                                    ? wordCharacters[index].map((character, characterIndex) => (
                                        <span
                                            key={characterIndex}
                                            ref={(node) => {
                                                if (!characterRefs.current[index]) characterRefs.current[index] = [];
                                                characterRefs.current[index][characterIndex] = node;
                                            }}
                                            className="synced-lyric-text__char"
                                            data-char-state="pending"
                                        >{character}</span>
                                    ))
                                    : word.text}
                            </span>
                        );
                    })
                    : displayText}
            </span>
        </span>
    );
}
