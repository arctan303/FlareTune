const EMPTY_WORD_PROGRESS = Object.freeze({
    activeWordIndex: -1,
    wordProgress: 0,
    lineProgress: 0,
    hasStarted: false,
    isComplete: false,
    hasWordTiming: false,
});

const TIME_BOUNDARY_TOLERANCE_SECONDS = 0.002;
const timedWordCache = new WeakMap();

const defaultSegmenter = (() => {
    try {
        return typeof Intl?.Segmenter === 'function'
            ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
            : null;
    } catch {
        return null;
    }
})();

const isFiniteTimestamp = (value) => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const normalizeCurrentTime = (currentTime) => (
    isFiniteTimestamp(currentTime) ? currentTime : 0
);

/**
 * Split lyric text without trimming it. Whitespace is timing-bearing content,
 * and therefore remains part of the grapheme count.
 */
export function segmentLyricGraphemes(value, segmenter = defaultSegmenter) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return [];

    if (segmenter && typeof segmenter.segment === 'function') {
        try {
            return Array.from(segmenter.segment(text), ({ segment }) => segment);
        } catch {
            // Fall through to the deterministic code-point fallback.
        }
    }

    return Array.from(text);
}

const getValidLineTime = (line) => (
    isFiniteTimestamp(line?.time) ? line.time : null
);

const getLineActivationTime = (line, syncMode) => {
    if (syncMode === 'word') {
        return getLyricVocalStart(line);
    }
    return getValidLineTime(line);
};

/**
 * Resolve the canonical line index with an upper-bound binary search.
 * Repeated timestamps intentionally select the last line starting at that
 * instant. Before the first timed line, canonical index 0 remains selected;
 * callers use snapshot.hasStarted to distinguish that prelude state.
 */
export function findActiveLyricLineIndex(lines, currentTime, syncMode = 'line') {
    if (!Array.isArray(lines) || lines.length === 0) return -1;

    const time = normalizeCurrentTime(currentTime);
    const firstTime = getLineActivationTime(lines[0], syncMode);
    if (firstTime === null || time < firstTime) return 0;

    let low = 0;
    let high = lines.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const middleTime = getLineActivationTime(lines[middle], syncMode);

        // Canonical lyric documents are ordered. A malformed timestamp is
        // treated as not-yet-started so the search fails closed rather than
        // prematurely advancing the visible line.
        if (middleTime !== null && middleTime <= time) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return Math.max(0, low - 1);
}

const normalizeTimedWords = (line) => {
    if (!Array.isArray(line?.words) || line.words.length === 0) return null;

    const cached = timedWordCache.get(line);
    if (cached
        && Object.is(cached.lineTime, line.time)
        && Object.is(cached.lineEndTime, line.endTime)
        && cached.sourceWords === line.words
        && cached.words.length === line.words.length
        && cached.words.every((word, index) => (
            word.text === line.words[index]?.text
            && word.startTime === line.words[index]?.startTime
            && word.endTime === line.words[index]?.endTime
        ))) return cached;

    // Playback documents and editor projections normally replace changed rows.
    // Check the timing-bearing values too, so a mutable caller cannot reuse a
    // stale axis. The cheap comparison avoids repeating grapheme segmentation
    // and allocations on every clock sample. Weak keys release old documents.
    const lineTime = getValidLineTime(line);
    const lineEndTime = isFiniteTimestamp(line?.endTime) ? line.endTime : null;
    let previousStart = -1;
    let previousEnd = -1;
    let totalGraphemeWeight = 0;
    const words = [];

    for (let index = 0; index < line.words.length; index += 1) {
        const word = line.words[index];
        if (
            typeof word?.text !== 'string'
            || word.text.length === 0
            || !isFiniteTimestamp(word.startTime)
            || !isFiniteTimestamp(word.endTime)
            || word.endTime < word.startTime
            || (lineTime !== null
                && word.startTime + TIME_BOUNDARY_TOLERANCE_SECONDS < lineTime)
            || (lineEndTime !== null
                && word.endTime > lineEndTime + TIME_BOUNDARY_TOLERANCE_SECONDS)
            || word.startTime < previousStart
            || word.startTime + TIME_BOUNDARY_TOLERANCE_SECONDS < previousEnd
        ) {
            return null;
        }

        const graphemeWeight = segmentLyricGraphemes(word.text).length;
        words.push({
            index,
            text: word.text,
            startTime: word.startTime,
            endTime: word.endTime,
            graphemeWeight,
            completedWeight: totalGraphemeWeight,
        });
        totalGraphemeWeight += graphemeWeight;
        previousStart = word.startTime;
        previousEnd = word.endTime;
    }

    if (totalGraphemeWeight <= 0) return null;
    const normalized = {
        words,
        totalGraphemeWeight,
        endTime: Math.max(...words.map((word) => word.endTime)),
        lineTime: line.time,
        lineEndTime: line.endTime,
        sourceWords: line.words,
    };
    const vocalWords = words.filter((word) => word.text.trim());
    normalized.vocalBounds = vocalWords.length > 0 ? {
        startTime: vocalWords[0].startTime,
        endTime: Math.max(...vocalWords.map((word) => word.endTime)),
    } : null;
    timedWordCache.set(line, normalized);
    return normalized;
};

/**
 * Return defensive vocal bounds only when the complete word axis is reliable.
 * Whitespace remains timing-bearing for progress, but leading/trailing blank
 * segments do not extend the audible interlude boundary.
 */
export function getReliableLyricWordBounds(line) {
    const normalized = normalizeTimedWords(line);
    return normalized?.vocalBounds ? { ...normalized.vocalBounds } : null;
}

export function getLyricVocalStart(line) {
    return getReliableLyricWordBounds(line)?.startTime ?? getValidLineTime(line);
}

/** Next observable line/intro/completion boundary, in audio seconds. */
export function getNextLyricBoundary(lines, currentTime, syncMode = 'line') {
    const index = findActiveLyricLineIndex(lines, currentTime, syncMode);
    if (index < 0) return null;
    const line = lines[index];
    const normalized = normalizeTimedWords(line);
    const candidates = [
        getLineActivationTime(line, syncMode),
        getLineActivationTime(lines[index + 1], syncMode),
        getLyricVocalStart(lines[0]),
        normalized?.endTime,
        isFiniteTimestamp(line?.endTime) ? line.endTime : null,
    ].filter((time) => Number.isFinite(time) && time > currentTime);
    return candidates.length ? Math.min(...candidates) : null;
}

const resolveWordLocalProgress = (word, currentTime) => {
    const duration = word.endTime - word.startTime;
    if (duration <= 0) return currentTime >= word.startTime ? 1 : 0;
    return Math.max(0, Math.min(1, (currentTime - word.startTime) / duration));
};

/**
 * Resolve precise word and line fill for one canonical lyric line.
 * Any malformed/incomplete word axis degrades the whole line to a static
 * result; this utility never fabricates per-character timing.
 */
export function resolveLineWordProgress(line, currentTime) {
    const normalized = normalizeTimedWords(line);
    if (!normalized) return { ...EMPTY_WORD_PROGRESS };

    const time = normalizeCurrentTime(currentTime);
    const { words, totalGraphemeWeight } = normalized;
    const firstWord = words[0];

    if (time < firstWord.startTime) {
        return {
            ...EMPTY_WORD_PROGRESS,
            hasWordTiming: true,
        };
    }

    // Last word whose start is at or before the playhead. This handles gaps,
    // repeated starts, zero-duration words, and seeks in either direction.
    let low = 0;
    let high = words.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (words[middle].startTime <= time) low = middle + 1;
        else high = middle;
    }

    const activeWord = words[Math.max(0, low - 1)];
    const wordProgress = resolveWordLocalProgress(activeWord, time);
    const isComplete = time >= normalized.endTime;
    const weightedProgress = (
        activeWord.completedWeight
        + activeWord.graphemeWeight * wordProgress
    ) / totalGraphemeWeight;

    return {
        activeWordIndex: activeWord.index,
        wordProgress: isComplete ? 1 : wordProgress,
        lineProgress: isComplete ? 1 : Math.max(0, Math.min(1, weightedProgress)),
        hasStarted: true,
        isComplete,
        hasWordTiming: true,
    };
}

/**
 * Produce the shared, seek-independent timeline view consumed by renderers
 * and the low-frequency active-line coordinator.
 */
export function resolveLyricTimelineSnapshot({ lines, currentTime, syncMode = 'line' } = {}) {
    const time = normalizeCurrentTime(currentTime);
    const activeLineIndex = findActiveLyricLineIndex(lines, time, syncMode);

    if (activeLineIndex < 0) {
        return {
            currentTime: time,
            activeLineIndex: -1,
            activeLine: null,
            ...EMPTY_WORD_PROGRESS,
        };
    }

    const activeLine = lines[activeLineIndex];
    const wordState = resolveLineWordProgress(activeLine, time);
    const lineTime = getValidLineTime(activeLine);
    const explicitEndTime = isFiniteTimestamp(activeLine?.endTime)
        && (lineTime === null || activeLine.endTime >= lineTime)
        ? activeLine.endTime
        : null;
    const hasStarted = wordState.hasWordTiming
        ? wordState.hasStarted
        : lineTime !== null && time >= lineTime;
    const isComplete = wordState.hasWordTiming
        ? wordState.isComplete
        : explicitEndTime !== null && time >= explicitEndTime;

    return {
        currentTime: time,
        activeLineIndex,
        activeLine,
        ...wordState,
        hasStarted,
        isComplete,
    };
}
