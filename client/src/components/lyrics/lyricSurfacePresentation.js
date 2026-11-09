import React from 'react';
import { lyricPlaybackClock } from '../../services/lyricPlaybackClock.js';
import {
    findActiveLyricLineIndex,
    getNextLyricBoundary,
} from '../../utils/lyricTimeline.js';

const finiteTime = (value) => (
    value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value))
    && Number(value) >= 0
        ? Number(value)
        : null
);

const clampLyricIndex = (lyrics, index) => {
    if (!Array.isArray(lyrics) || lyrics.length === 0) return -1;
    const numericIndex = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
    return Math.max(0, Math.min(numericIndex, lyrics.length - 1));
};

export function resolveLyricSurfacePresentation({
    lyrics,
    currentLyricIndex = 0,
    currentTime = null,
    usePreciseIndex = false,
}) {
    if (!Array.isArray(lyrics) || lyrics.length === 0) {
        return { kind: 'none', index: -1, line: null };
    }

    const safeCurrentTime = finiteTime(currentTime);
    const preciseIndex = usePreciseIndex && safeCurrentTime !== null
        ? findActiveLyricLineIndex(lyrics, safeCurrentTime, 'word')
        : currentLyricIndex;
    const index = clampLyricIndex(lyrics, preciseIndex);
    return { kind: 'line', index, line: lyrics[index] || null };
}

const presentationKey = (presentation) => `${presentation.kind}:${presentation.index}`;

/**
 * Subscribe to the shared clock without exposing its per-frame object snapshot to
 * React. The wrapped subscriber only invalidates React when the presentation row
 * changes. Row zero always contains the first canonical lyric, even before vocals.
 */
export function useLyricSurfacePresentation({
    lyrics,
    currentLyricIndex = 0,
    lyricSyncMode = 'line',
    surfaceVisible = true,
    clock = lyricPlaybackClock,
}) {
    const shouldUseClock = Boolean(
        surfaceVisible
        && Array.isArray(lyrics)
        && lyrics.length > 0
        && lyricSyncMode === 'word',
    );

    const resolveFromSnapshot = React.useCallback((snapshot) => resolveLyricSurfacePresentation({
        lyrics,
        currentLyricIndex,
        currentTime: snapshot?.currentTime,
        usePreciseIndex: shouldUseClock && lyricSyncMode === 'word',
    }), [lyrics, currentLyricIndex, lyricSyncMode, shouldUseClock]);

    const getKey = React.useCallback(() => presentationKey(resolveFromSnapshot(
        shouldUseClock ? clock.getSnapshot() : null,
    )), [clock, resolveFromSnapshot, shouldUseClock]);

    const subscribe = React.useCallback((notify) => {
        if (!shouldUseClock) return () => {};
        let lastKey = getKey();
        return clock.subscribe((snapshot) => {
            const nextKey = presentationKey(resolveFromSnapshot(snapshot));
            if (nextKey === lastKey) return;
            lastKey = nextKey;
            notify();
        }, {
            getNextBoundary: (snapshot) => getNextLyricBoundary(lyrics, snapshot.currentTime, lyricSyncMode),
        });
    }, [clock, getKey, resolveFromSnapshot, shouldUseClock, lyrics, lyricSyncMode]);

    const key = React.useSyncExternalStore(subscribe, getKey, getKey);
    const separatorIndex = key.lastIndexOf(':');
    const kind = key.slice(0, separatorIndex);
    const index = Number(key.slice(separatorIndex + 1));
    return {
        kind,
        index,
        line: lyrics?.[index] || null,
    };
}
