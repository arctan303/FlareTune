import { getReliableLyricWordBounds } from './lyricTimeline.js';

export const INTERLUDE_CONFIG = {
    // 逐行歌词与 line-only 前奏沿用的保守门槛。
    MIN_GAP_SECONDS: 12.0,
    // 已扣除演唱与歌词回归缓冲后的最短净展示时长。
    MIN_ACTIVE_SECONDS: 4.0,
    INTRO_PREPARE_SECONDS: 2.0,
    BASE_CHAR_TIME: 0.28,
    LINE_TAIL_HOLD: 1.2,
    MIN_SING_DURATION: 2.5,
    RETURN_LEAD_TIME: 1.8,
    REVERT_TRANSITION_SECONDS: 1.8,
    STAGE_3_LEAD_SECONDS: 0.6,
};

const VALID_SYNC_MODES = new Set(['word', 'line', 'none']);

const finiteNonNegative = (value) => (
    Number.isFinite(value) && value >= 0 ? value : null
);

const noWindow = (kind, diagnosticReason) => ({
    kind,
    basis: 'none',
    start: null,
    end: null,
    duration: 0,
    diagnosticReason,
});

const activeWindow = (kind, basis, start, end, diagnosticReason = null) => ({
    kind,
    basis,
    start,
    end,
    duration: end - start,
    diagnosticReason,
});

const firstValidWordStart = (line) => {
    const bounds = getReliableLyricWordBounds(line);
    return bounds?.startTime ?? null;
};

const lastValidWordEnd = (line) => {
    const bounds = getReliableLyricWordBounds(line);
    return bounds?.endTime ?? null;
};

const reliableLineEnd = (line) => {
    const start = finiteNonNegative(line?.time);
    const end = finiteNonNegative(line?.endTime);
    return end !== null && (start === null || end >= start) ? end : null;
};

const firstVocalStart = (line) => firstValidWordStart(line) ?? finiteNonNegative(line?.time);

/**
 * 逐行歌词没有可靠结束轴时使用的兼容估算。精确走词绝不经过这里。
 */
export function getLyricSingDuration(text, gap) {
    const cleanText = typeof text === 'string' ? text.trim() : '';
    const charCount = [...cleanText].filter((character) => !/\s/.test(character)).length;
    const estimated = INTERLUDE_CONFIG.LINE_TAIL_HOLD
        + (charCount * INTERLUDE_CONFIG.BASE_CHAR_TIME);
    const safeGap = Number.isFinite(gap) && gap > 0
        ? gap
        : INTERLUDE_CONFIG.MIN_GAP_SECONDS;
    const maxAllowed = Math.max(2.5, safeGap * 0.55);
    return Math.min(
        Math.max(INTERLUDE_CONFIG.MIN_SING_DURATION, estimated),
        maxAllowed,
    );
}

function resolveIntroWindow(firstLine, syncMode) {
    const wordStart = firstValidWordStart(firstLine);
    if (syncMode === 'word' && wordStart === null) {
        return noWindow('intro', 'exact-unavailable');
    }
    const vocalStart = wordStart ?? finiteNonNegative(firstLine?.time);
    if (vocalStart === null) return noWindow('intro', 'intro-start-unavailable');

    // A line-only timestamp remains intentionally conservative. A local word
    // boundary (even in a globally line-degraded document) is exact enough to
    // use the four-second net-window rule.
    if (syncMode === 'line' && wordStart === null
        && vocalStart < INTERLUDE_CONFIG.MIN_GAP_SECONDS) {
        return noWindow('intro', 'line-only-intro-below-threshold');
    }

    const start = 0;
    const end = vocalStart - INTERLUDE_CONFIG.INTRO_PREPARE_SECONDS;
    if (end - start < INTERLUDE_CONFIG.MIN_ACTIVE_SECONDS) {
        return noWindow('intro', 'intro-window-too-short');
    }
    return activeWindow('intro', 'exact', start, end);
}

function resolveBetweenLinesWindow(currentLine, nextLine, syncMode) {
    const currentStart = finiteNonNegative(currentLine?.time);
    const nextLineStart = finiteNonNegative(nextLine?.time);
    const vocalEnd = lastValidWordEnd(currentLine) ?? reliableLineEnd(currentLine);
    const nextWordStart = firstValidWordStart(nextLine);
    const nextVocalStart = nextWordStart
        ?? (syncMode === 'word' ? null : nextLineStart);
    if (vocalEnd !== null && nextVocalStart !== null) {
        if (nextVocalStart < vocalEnd) {
            return noWindow('between-lines', 'exact-boundary-invalid');
        }
        const end = nextVocalStart - INTERLUDE_CONFIG.RETURN_LEAD_TIME;
        if (end - vocalEnd < INTERLUDE_CONFIG.MIN_ACTIVE_SECONDS) {
            return noWindow('between-lines', 'exact-window-too-short');
        }
        return activeWindow('between-lines', 'exact', vocalEnd, end);
    }

    if (syncMode === 'word') {
        return noWindow('between-lines', 'exact-unavailable');
    }
    if (syncMode !== 'line') {
        return noWindow('between-lines', 'synchronized-timeline-unavailable');
    }
    if (currentStart === null || nextLineStart === null || nextLineStart <= currentStart) {
        return noWindow('between-lines', 'line-boundary-unavailable');
    }

    const gap = nextLineStart - currentStart;
    if (gap < INTERLUDE_CONFIG.MIN_GAP_SECONDS) {
        return noWindow('between-lines', 'legacy-gap-below-threshold');
    }
    const start = currentStart + getLyricSingDuration(currentLine?.text, gap);
    const end = nextLineStart - INTERLUDE_CONFIG.RETURN_LEAD_TIME;
    if (end - start < INTERLUDE_CONFIG.MIN_ACTIVE_SECONDS) {
        return noWindow('between-lines', 'legacy-window-too-short');
    }
    return activeWindow('between-lines', 'legacy-estimate', start, end);
}

/**
 * Resolve the one canonical window used by visibility, progress stages and dot
 * seek targets. `currentTime` disambiguates intro from line-0 interlude.
 */
export function resolveInterludeWindow({
    currentTime,
    lyrics,
    currentLyricIndex,
    lineIndex,
    syncMode = 'line',
}) {
    if (!Array.isArray(lyrics) || lyrics.length === 0) {
        return noWindow(null, 'lyrics-unavailable');
    }
    const normalizedSyncMode = VALID_SYNC_MODES.has(syncMode) ? syncMode : 'line';
    if (normalizedSyncMode === 'none') {
        return noWindow(null, 'synchronized-timeline-unavailable');
    }

    const firstLine = lyrics[0];
    const introBoundary = firstVocalStart(firstLine);
    const hasCurrentTime = Number.isFinite(currentTime);
    const isLineZeroContext = lineIndex === 0 && currentLyricIndex === 0;
    const isBeforeFirstVocal = isLineZeroContext
        && hasCurrentTime
        && introBoundary !== null
        && currentTime < introBoundary;

    if (isBeforeFirstVocal) {
        return resolveIntroWindow(firstLine, normalizedSyncMode);
    }

    if (lineIndex === currentLyricIndex) {
        const nextLine = lyrics[lineIndex + 1];
        if (nextLine) {
            const between = resolveBetweenLinesWindow(
                lyrics[lineIndex],
                nextLine,
                normalizedSyncMode,
            );
            if (between.basis !== 'none' || hasCurrentTime || !isLineZeroContext) return between;
        } else if (hasCurrentTime || !isLineZeroContext) {
            return noWindow('between-lines', 'next-line-unavailable');
        }
    } else if (!isLineZeroContext) {
        return noWindow('between-lines', 'inactive-line');
    }

    // Compatibility for dot calculations that historically omitted currentTime:
    // prefer a valid line-0 interlude, then fall back to the intro window.
    if (isLineZeroContext && !hasCurrentTime) {
        return resolveIntroWindow(firstLine, normalizedSyncMode);
    }
    return noWindow(null, 'window-unavailable');
}

const getStageTimes = ({ start, duration }) => {
    const stage3Threshold = Math.max(
        0.75,
        1 - (INTERLUDE_CONFIG.STAGE_3_LEAD_SECONDS / duration),
    );
    return [start + duration / 3, start + duration * 2 / 3,
        start + duration * stage3Threshold];
};

const stageAtTime = (currentTime, window) => {
    const [first, second, third] = getStageTimes(window);
    // Compare the same absolute boundaries used by the scheduler. Dividing
    // back into progress can round an exact stage wake just below its threshold.
    if (currentTime >= third) return 3;
    if (currentTime >= second) return 2;
    if (currentTime >= first) return 1;
    return 0;
};

export function getInterludeState({
    currentTime,
    lyrics,
    currentLyricIndex,
    lineIndex,
    isUserScrolling = false,
    syncMode = 'line',
}) {
    const fallback = { isInterlude: false, stage: 0, progress: 0 };
    if (isUserScrolling) return fallback;
    const validCurrentTime = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
    const window = resolveInterludeWindow({
        currentTime: validCurrentTime,
        lyrics,
        currentLyricIndex,
        lineIndex,
        syncMode,
    });
    if (window.basis === 'none'
        || validCurrentTime < window.start
        || validCurrentTime >= window.end) return fallback;

    const progress = Math.min(
        1,
        Math.max(0, (validCurrentTime - window.start) / window.duration),
    );
    return {
        isInterlude: true,
        stage: stageAtTime(validCurrentTime, window),
        progress,
    };
}

export function isInterludeActive(params) {
    return getInterludeState(params).isInterlude;
}

export function getInterludeDotTimes({
    lyrics,
    currentLyricIndex,
    lineIndex,
    currentTime,
    syncMode = 'line',
}) {
    const window = resolveInterludeWindow({
        currentTime,
        lyrics,
        currentLyricIndex,
        lineIndex,
        syncMode,
    });
    if (window.basis === 'none') return null;
    const [first, second, third] = getStageTimes(window);
    return {
        t1: first + 0.05,
        t2: second + 0.05,
        t3: third + 0.05,
    };
}

/** Schedule only the next visibility/stage change when no word renderer runs. */
export function getNextInterludeBoundary(params) {
    if (params.isUserScrolling) return null;
    const window = resolveInterludeWindow(params);
    const candidates = [firstVocalStart(params.lyrics?.[0])];
    if (window.basis !== 'none') {
        candidates.push(window.start, ...getStageTimes(window), window.end);
    }
    const future = candidates.filter((time) => Number.isFinite(time) && time > params.currentTime);
    return future.length ? Math.min(...future) : null;
}
