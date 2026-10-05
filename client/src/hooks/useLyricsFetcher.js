import { useEffect } from 'react';
import { getApiBaseUrl } from '../utils.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { songLanguageHasLyrics } from '../constants/language.js';
import { getLyricVocalStart } from '../utils/lyricTimeline.js';
import { lyricsWorkspaceApi } from '../services/localLyricsWorkspaceApi.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';

const pendingLyricsRequests = new Map();
const lyricsCacheEpochs = new Map();
const LYRICS_CACHE_SCHEMA = 3;
const NO_LYRICS = [{ time: 0, text: '纯音乐，请欣赏' }];
const EMPTY_LYRICS = [{ time: 0, text: '暂无歌词' }];
const ERROR_LYRICS = [{ time: 0, text: '歌词加载失败' }];
const LYRICS_RETRY_DELAYS_MS = [1_500, 3_000];
const PLACEHOLDER_LYRIC_PATTERN = /^(?:暂无歌词|无歌词|纯音乐(?:\s*[，,、-]?\s*请欣赏)?|此歌曲为纯音乐)[。.!！]?$/;
const INTRO_LYRIC_THRESHOLD_SECONDS = 3;
const VALID_SYNC_MODES = new Set(['word', 'line', 'none']);
const VALID_RESOLVED_SOURCES = new Set(['kugou', 'netease', 'lrclib', 'manual']);
const VALID_TRANSLATION_STATES = new Set(['unavailable', 'missing', 'pending', 'ready', 'failed']);
const TRANSLATION_POLL_INTERVAL_MS = 2_000;
const TRANSLATION_POLL_WINDOW_MS = 30_000;
const pendingTranslationCompletions = new Map();

const waitForLyricsRetry = (delayMs, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', finish, { once: true });
});

const normalizeSongId = (songId) => (
    songId === undefined || songId === null ? '' : String(songId)
);

const cloneCanonicalLines = (lines) => (
    Array.isArray(lines)
        ? lines.map((line) => ({
            ...line,
            ...(Array.isArray(line?.words)
                ? { words: line.words.map((word) => ({ ...word })) }
                : {}),
        }))
        : []
);

const isPlaceholderLyrics = (lyrics) => (
    Array.isArray(lyrics)
    && lyrics.length === 1
    && PLACEHOLDER_LYRIC_PATTERN.test(String(lyrics[0]?.text || '').trim())
);

const hasTranslation = (lines) => (
    Array.isArray(lines)
    && lines.some((line) => typeof line?.translation === 'string' && line.translation.trim())
);

const getIntroLyricText = (song) => (
    [song?.artist, song?.title].filter(Boolean).join(' - ') || '正在播放'
);

export const createLyricIntro = (lyrics, song) => {
    if (!songLanguageHasLyrics(song?.language)) return null;
    if (!Array.isArray(lyrics) || lyrics.length === 0 || isPlaceholderLyrics(lyrics)) return null;
    const firstVocalStart = getLyricVocalStart(lyrics[0]);
    if (firstVocalStart === null || firstVocalStart <= INTRO_LYRIC_THRESHOLD_SECONDS) return null;
    return { time: 0, text: getIntroLyricText(song) };
};

export const getLyricsRequestKey = (song) => (
    song?.id ? `v${LYRICS_CACHE_SCHEMA}|${encodeURIComponent(String(song.id))}` : ''
);

const getLyricsCacheEpoch = (songId) => lyricsCacheEpochs.get(normalizeSongId(songId)) || 0;

/**
 * Advance the song-scoped request epoch. A request started before a member
 * update can no longer publish its stale result into the player store.
 */
export const invalidateLyricsCacheForSong = (songId) => {
    const normalizedSongId = normalizeSongId(songId);
    if (!normalizedSongId) return { memory: 0, session: 0, pending: 0 };

    lyricsCacheEpochs.set(normalizedSongId, getLyricsCacheEpoch(normalizedSongId) + 1);
    const requestKey = `v${LYRICS_CACHE_SCHEMA}|${encodeURIComponent(normalizedSongId)}`;
    const pending = pendingLyricsRequests.delete(requestKey) ? 1 : 0;
    return { memory: 0, session: 0, pending };
};

export const normalizeLyricsResult = (value) => {
    const lyrics = cloneCanonicalLines(Array.isArray(value?.lyrics) ? value.lyrics : EMPTY_LYRICS);
    let status = value?.status;
    const validStatus = ['ready', 'none', 'unavailable', 'error'].includes(status);
    const placeholder = isPlaceholderLyrics(lyrics);
    if (placeholder && (!validStatus || status === 'ready')) status = 'unavailable';
    else if (!validStatus) status = 'ready';
    const noLyrics = placeholder || ['none', 'unavailable', 'error'].includes(status);
    const translationAvailable = !noLyrics && hasTranslation(lyrics);
    const requestedTranslationState = VALID_TRANSLATION_STATES.has(value?.translationState)
        ? value.translationState
        : null;
    const translationState = noLyrics
        ? 'unavailable'
        : requestedTranslationState === 'ready' && !translationAvailable
            ? 'missing'
            : requestedTranslationState || (translationAvailable ? 'ready' : 'unavailable');
    const translationStartedAt = translationState === 'pending'
        && Number.isFinite(Date.parse(value?.translationStartedAt))
        ? new Date(value.translationStartedAt).toISOString()
        : null;
    return {
        version: LYRICS_CACHE_SCHEMA,
        source: VALID_RESOLVED_SOURCES.has(value?.source) ? value.source : null,
        format: typeof value?.format === 'string' ? value.format : 'none',
        syncMode: noLyrics || !VALID_SYNC_MODES.has(value?.syncMode) ? 'none' : value.syncMode,
        lyrics,
        rawLrc: value?.rawLrc || '',
        tlyric: translationAvailable ? (value?.tlyric || '') : '',
        translationAvailable,
        translationState,
        translationStartedAt,
        offsetMs: Number.isInteger(value?.offsetMs) ? value.offsetMs : 0,
        provenance: value?.provenance && typeof value.provenance === 'object'
            ? { ...value.provenance }
            : null,
        updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null,
        status,
    };
};

const attachTranslation = (lines, data) => {
    const translatedLines = Array.isArray(data?.translation?.lines) ? data.translation.lines : [];
    return cloneCanonicalLines(lines).map((line, index) => {
        const translation = String(
            translatedLines[index] ?? line?.translation ?? line?.tlyric ?? '',
        ).trim();
        const { tlyric: _providerTranslation, ...originalLine } = line;
        return translation ? { ...originalLine, translation } : originalLine;
    });
};

export const createLyricsResultFromResponse = (payload, responseStatus = 200) => {
    if (responseStatus === 404 || payload?.code === 404) {
        if (payload?.reason === 'lyrics_not_found') {
            return normalizeLyricsResult({ lyrics: EMPTY_LYRICS, status: 'unavailable' });
        }
        const error = new Error(payload?.message || 'Lyric song is not available');
        error.status = 404;
        error.reason = payload?.reason || 'unknown';
        throw error;
    }
    if (responseStatus < 200 || responseStatus >= 300) {
        const error = new Error(payload?.message || 'Network error or no lyrics found');
        error.status = responseStatus;
        throw error;
    }

    const data = payload?.data || {};
    if (payload?.code !== 200) throw new Error('Unsupported lyric response');
    if (data.status === 'not_needed' || data.reason === 'instrumental') {
        return normalizeLyricsResult({ lyrics: NO_LYRICS, status: 'none' });
    }
    if (data.status === 'not_found') {
        return normalizeLyricsResult({ lyrics: EMPTY_LYRICS, status: 'unavailable' });
    }
    if (data.version !== 2
        || !VALID_RESOLVED_SOURCES.has(data.source)
        || !VALID_SYNC_MODES.has(data.syncMode)
        || !Array.isArray(data.lines)) {
        throw new Error('Invalid canonical lyric document');
    }

    const lyrics = attachTranslation(data.lines, data);
    if (lyrics.length === 0) throw new Error('Canonical lyric document has no lines');
    return normalizeLyricsResult({
        source: data.source,
        format: data.format,
        syncMode: data.syncMode,
        lyrics,
        rawLrc: data.lrc || '',
        tlyric: data.tlyric || '',
        translationAvailable: Boolean(data.translationAvailable),
        translationState: data.translationState,
        translationStartedAt: data.translationStartedAt,
        offsetMs: data.offsetMs,
        provenance: data.provenance,
        updatedAt: data.updatedAt,
        status: isPlaceholderLyrics(lyrics) ? 'unavailable' : 'ready',
    });
};

export const fetchLyricsAsset = async (song, options = {}) => {
    const requestOptions = options && typeof options === 'object' ? options : {};
    const requestKey = getLyricsRequestKey(song);
    const requestEpoch = getLyricsCacheEpoch(song?.id);
    const shouldDedupe = requestOptions.dedupe !== false && !requestOptions.signal;
    const pendingRequest = shouldDedupe ? pendingLyricsRequests.get(requestKey) : null;
    if (pendingRequest?.epoch === requestEpoch) return pendingRequest.promise;

    const request = (async () => {
        const url = `${getApiBaseUrl()}/api/lyrics?songId=${encodeURIComponent(song.id)}`;
        const response = requestOptions.signal
            ? await authenticatedFetch(url, { credentials: 'include', cache: 'no-store', signal: requestOptions.signal })
            : await authenticatedFetch(url, { credentials: 'include' });
        const payload = await response.json().catch(() => {
            const error = new Error('Invalid lyric response');
            error.status = response.status;
            throw error;
        });
        return createLyricsResultFromResponse(payload, response.status);
    })();

    if (shouldDedupe) pendingLyricsRequests.set(requestKey, { epoch: requestEpoch, promise: request });
    try {
        return await request;
    } finally {
        if (shouldDedupe && pendingLyricsRequests.get(requestKey)?.promise === request) {
            pendingLyricsRequests.delete(requestKey);
        }
    }
};

const setTranslationSnapshot = (state, snapshot) => {
    if (typeof state.setTranslationSnapshot === 'function') {
        state.setTranslationSnapshot(snapshot);
        return;
    }
    state.setTranslationAvailable(snapshot.available);
    state.setTranslationState?.(snapshot.state);
    state.setTranslationStartedAt?.(snapshot.startedAt);
};

const mergeTranslationIntoExistingLyrics = (existingLyrics, incomingLyrics, { allowClear = false } = {}) => {
    if (!Array.isArray(existingLyrics) || existingLyrics.length === 0) return incomingLyrics;
    if (!Array.isArray(incomingLyrics) || incomingLyrics.length === 0) return existingLyrics;

    let changed = false;
    const merged = existingLyrics.map((line, index) => {
        const incomingTranslation = typeof incomingLyrics[index]?.translation === 'string'
            ? incomingLyrics[index].translation.trim()
            : '';
        // A pending response can legitimately omit translation content. Keep any
        // existing fallback until the completed document contains a replacement.
        const currentTranslation = String(line?.translation || '').trim();
        if (incomingTranslation === currentTranslation || (!incomingTranslation && !allowClear)) {
            return line;
        }
        changed = true;
        if (!incomingTranslation) {
            const { translation: _staleTranslation, ...originalLine } = line;
            return originalLine;
        }
        return { ...line, translation: incomingTranslation };
    });

    return changed ? merged : existingLyrics;
};

const haveSameWords = (currentWords, incomingWords) => {
    const currentIsArray = Array.isArray(currentWords);
    const incomingIsArray = Array.isArray(incomingWords);
    if (currentIsArray !== incomingIsArray) return false;
    if (!currentIsArray) return true;
    const current = currentWords;
    const incoming = incomingWords;
    return current.length === incoming.length && current.every((word, index) => (
        word?.text === incoming[index]?.text
        && word?.startTime === incoming[index]?.startTime
        && word?.endTime === incoming[index]?.endTime
    ));
};

const hasSameOriginalDocument = (state, result) => (
    state.resolvedLyricSource === result.source
    && state.lyricFormat === result.format
    && state.lyricSyncMode === result.syncMode
    && state.lyricOffsetMs === result.offsetMs
    && Array.isArray(state.lyrics)
    && state.lyrics.length === result.lyrics.length
    && state.lyrics.every((line, index) => {
        const incoming = result.lyrics[index];
        return line?.text === incoming?.text
            && line?.time === incoming?.time
            && line?.endTime === incoming?.endTime
            && haveSameWords(line?.words, incoming?.words);
    })
);

const applyLyricsDocumentSnapshot = (
    state,
    result,
    currentSong,
    lyrics = result.lyrics,
    intro = createLyricIntro(result.lyrics, currentSong),
) => {
    state.setLyricsDocumentSnapshot({
        lyrics,
        status: result.status,
        source: result.source,
        format: result.format,
        syncMode: result.syncMode,
        intro,
        offsetMs: result.offsetMs,
        translationAvailable: result.translationAvailable,
        translationState: result.translationState,
        translationStartedAt: result.translationStartedAt,
    });
};

export const getTranslationPollRemaining = (startedAt, now = Date.now()) => {
    const startedAtMs = Date.parse(startedAt);
    if (!Number.isFinite(startedAtMs)) return 0;
    return Math.max(0, (startedAtMs + TRANSLATION_POLL_WINDOW_MS) - now);
};

export function createLyricsTranslationPoller({
    songId,
    lyricsRefreshRevision,
    startedAt,
    loadDocument,
    getPlayerState = usePlayerStore.getState,
    documentTarget = typeof document === 'undefined' ? null : document,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    intervalMs = TRANSLATION_POLL_INTERVAL_MS,
}) {
    let stopped = false;
    let timer = null;
    let deadlineTimer = null;
    let deadlineReached = false;
    let requestGeneration = 0;
    let activeRequest = null;

    const getMatchingPendingState = () => {
        const state = getPlayerState();
        return String(state.currentSong?.id) === String(songId)
            && state.lyricsRefreshRevision === lyricsRefreshRevision
            && state.translationState === 'pending'
            ? state
            : null;
    };
    const isCurrentPending = () => !stopped && !deadlineReached && Boolean(getMatchingPendingState());
    const isVisible = () => !documentTarget || documentTarget.visibilityState !== 'hidden';
    const clearScheduled = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
    };
    const clearDeadline = () => {
        if (deadlineTimer !== null) clearTimer(deadlineTimer);
        deadlineTimer = null;
    };
    const cancelActiveRequest = () => {
        requestGeneration += 1;
        activeRequest?.controller.abort();
        activeRequest = null;
    };
    const expire = () => {
        if (stopped || deadlineReached) return;
        deadlineReached = true;
        clearScheduled();
        clearDeadline();
        cancelActiveRequest();
        const state = getMatchingPendingState();
        if (!state) return;
        setTranslationSnapshot(state, {
            available: Boolean(state.translationAvailable),
            state: state.translationAvailable ? 'ready' : 'failed',
            startedAt: null,
        });
    };
    const schedule = () => {
        clearScheduled();
        if (!isCurrentPending() || !isVisible()) return;
        const remaining = getTranslationPollRemaining(startedAt, now());
        timer = setTimer(() => void poll(remaining <= intervalMs), Math.min(intervalMs, remaining));
    };
    const poll = async (finalRead = false) => {
        clearScheduled();
        if (!isCurrentPending() || !isVisible() || activeRequest) return;
        const generation = ++requestGeneration;
        const request = { generation, controller: new AbortController() };
        activeRequest = request;
        try {
            await loadDocument(request.controller.signal);
        } catch (error) {
            if (generation === requestGeneration && error?.name !== 'AbortError' && finalRead) expire();
        } finally {
            if (activeRequest?.generation === generation) activeRequest = null;
        }
        if (generation !== requestGeneration) return;
        if (!isCurrentPending()) return;
        if (finalRead || getTranslationPollRemaining(startedAt, now()) <= 0) {
            expire();
            return;
        }
        schedule();
    };
    const handleVisibilityChange = () => {
        clearScheduled();
        cancelActiveRequest();
        if (!isVisible() || !isCurrentPending()) return;
        void poll(getTranslationPollRemaining(startedAt, now()) <= 0);
    };
    const stop = () => {
        stopped = true;
        clearScheduled();
        clearDeadline();
        cancelActiveRequest();
        documentTarget?.removeEventListener?.('visibilitychange', handleVisibilityChange);
    };

    documentTarget?.addEventListener?.('visibilitychange', handleVisibilityChange);
    schedule();
    const deadlineRemaining = getTranslationPollRemaining(startedAt, now());
    if (deadlineRemaining <= 0) {
        expire();
    } else {
        deadlineTimer = setTimer(expire, deadlineRemaining);
    }
    return { stop, pollNow: () => poll(getTranslationPollRemaining(startedAt, now()) <= 0) };
}

export async function requestLyricsTranslationCompletion({
    songId,
    authenticated,
    completeTranslation = lyricsWorkspaceApi.completeLyricsTranslation,
    getPlayerState = usePlayerStore.getState,
    notify = () => {},
    now = Date.now,
}) {
    const normalizedSongId = normalizeSongId(songId);
    if (!normalizedSongId) return { state: 'ignored' };
    if (!authenticated) {
        notify('请先登录后补全歌词翻译');
        return { state: 'login_required' };
    }
    const current = getPlayerState();
    if (String(current.currentSong?.id) !== normalizedSongId) return { state: 'ignored' };
    if (current.translationState === 'pending') return { state: 'pending' };
    const duplicate = pendingTranslationCompletions.get(normalizedSongId);
    if (duplicate) return duplicate;

    const previousAvailable = Boolean(current.translationAvailable);
    setTranslationSnapshot(current, {
        available: previousAvailable,
        state: 'pending',
        startedAt: new Date(now()).toISOString(),
    });
    const request = (async () => {
        try {
            const response = await completeTranslation(normalizedSongId);
            const responseState = response?.data?.status;
            const serverStartedAt = response?.data?.translationStartedAt ?? response?.data?.startedAt;
            const latest = getPlayerState();
            if (String(latest.currentSong?.id) !== normalizedSongId) return { state: responseState || 'pending' };
            if (responseState === 'not_needed') {
                setTranslationSnapshot(latest, { available: false, state: 'unavailable', startedAt: null });
                return { state: 'unavailable' };
            }
            setTranslationSnapshot(latest, {
                available: Boolean(latest.translationAvailable),
                state: 'pending',
                startedAt: Number.isFinite(Date.parse(serverStartedAt))
                    ? new Date(serverStartedAt).toISOString()
                    : latest.translationStartedAt,
            });
            return { state: 'pending' };
        } catch (error) {
            const latest = getPlayerState();
            if (String(latest.currentSong?.id) === normalizedSongId) {
                setTranslationSnapshot(latest, {
                    available: Boolean(latest.translationAvailable),
                    state: latest.translationAvailable ? 'ready' : 'failed',
                    startedAt: null,
                });
            }
            notify(error?.message || '歌词翻译补全提交失败');
            return { state: 'failed', error };
        } finally {
            pendingTranslationCompletions.delete(normalizedSongId);
        }
    })();
    pendingTranslationCompletions.set(normalizedSongId, request);
    return request;
}

export async function loadLyricsDocumentIntoStore({
    currentSong,
    resolvedHasLyrics,
    getPlayerState = usePlayerStore.getState,
    fetchLyrics = fetchLyricsAsset,
    isCancelled = () => false,
    lyricsRefreshRevision = null,
    preserveExisting = false,
    signal = null,
    reportError = (...args) => console.error(...args),
    waitBeforeRetry = waitForLyricsRetry,
}) {
    const store = getPlayerState;
    const resetDocumentMetadata = () => {
        store().setResolvedLyricSource(null);
        store().setLyricFormat('none');
        store().setLyricSyncMode('none');
        store().setLyricIntro(null);
        store().setLyricOffsetMs(0);
        setTranslationSnapshot(store(), { available: false, state: 'unavailable', startedAt: null });
    };

    if (!currentSong) {
        store().setLyrics([]);
        store().setLyricsStatus('idle');
        store().setCurrentLyricIndex(0);
        store().setIsLyricsLoading(false);
        resetDocumentMetadata();
        return;
    }

    if (!preserveExisting) {
        store().setLyrics([]);
        store().setLyricsStatus(resolvedHasLyrics ? 'loading' : 'none');
        store().setCurrentLyricIndex(0);
        resetDocumentMetadata();
    }

    const requestIdentity = { songId: currentSong.id, lyricsRefreshRevision };
    const isCurrent = () => (
        !isCancelled()
        && !signal?.aborted
        && store().currentSong?.id === requestIdentity.songId
        && (requestIdentity.lyricsRefreshRevision === null
            || store().lyricsRefreshRevision === requestIdentity.lyricsRefreshRevision)
    );

    if (!resolvedHasLyrics) {
        if (!isCurrent()) return;
        store().setLyrics(NO_LYRICS);
        store().setLyricsStatus('none');
        store().setIsLyricsLoading(false);
        return;
    }

    if (!preserveExisting) store().setIsLyricsLoading(true);
    try {
        let result;
        for (let attempt = 0; ; attempt += 1) {
            if (!isCurrent()) return null;
            try {
                result = await fetchLyrics(currentSong, signal ? { signal } : undefined);
                break;
            } catch (error) {
                const status = Number(error?.status);
                const retryable = error instanceof TypeError
                    || [408, 425, 429, 500, 502, 503, 504].includes(status);
                if (preserveExisting || !retryable || attempt >= LYRICS_RETRY_DELAYS_MS.length || !isCurrent()) {
                    throw error;
                }
                await waitBeforeRetry(LYRICS_RETRY_DELAYS_MS[attempt], signal);
            }
        }
        if (!isCurrent()) return null;
        const currentState = store();
        const syncQuality = { none: 0, line: 1, word: 2 };
        if (preserveExisting && currentState.lyrics?.length > 0
            && (syncQuality[result.syncMode] ?? 0) > (syncQuality[currentState.lyricSyncMode] ?? 0)) {
            // A background upgrade belongs to the next playback. In-flight
            // translation polling must not replace this playback's timeline.
            setTranslationSnapshot(currentState, {
                available: Boolean(currentState.translationAvailable),
                state: currentState.translationAvailable ? 'ready' : 'unavailable',
                startedAt: null,
            });
            return result;
        }
        if (preserveExisting && hasSameOriginalDocument(currentState, result)) {
            const currentLyrics = currentState.lyrics;
            const mergedLyrics = mergeTranslationIntoExistingLyrics(currentLyrics, result.lyrics, {
                allowClear: result.translationState === 'ready',
            });
            applyLyricsDocumentSnapshot(
                currentState,
                result,
                currentSong,
                mergedLyrics,
                currentState.lyricIntro,
            );
        } else {
            applyLyricsDocumentSnapshot(currentState, result, currentSong);
        }
        return result;
    } catch (error) {
        if (!isCurrent()) return null;
        if (error?.name !== 'AbortError') reportError('加载歌词失败:', error);
        if (!preserveExisting) {
            store().setLyrics(ERROR_LYRICS);
            store().setLyricsStatus('error');
            resetDocumentMetadata();
        }
        return null;
    } finally {
        if (!preserveExisting && isCurrent()) store().setIsLyricsLoading(false);
    }
}

export function useLyricsFetcher({ enabled = true } = {}) {
    const currentSong = usePlayerStore((state) => state.currentSong);
    const lyricsRefreshRevision = usePlayerStore((state) => state.lyricsRefreshRevision);
    const translationState = usePlayerStore((state) => state.translationState);
    const translationStartedAt = usePlayerStore((state) => state.translationStartedAt);
    const resolvedHasLyrics = songLanguageHasLyrics(currentSong?.language);

    useEffect(() => {
        if (!enabled) return undefined;
        const controller = new AbortController();
        void loadLyricsDocumentIntoStore({
            currentSong,
            resolvedHasLyrics,
            lyricsRefreshRevision,
            signal: controller.signal,
        });
        return () => controller.abort();
    }, [currentSong, enabled, resolvedHasLyrics, lyricsRefreshRevision]);

    useEffect(() => {
        if (!enabled || !currentSong || translationState !== 'pending' || !translationStartedAt) return undefined;
        const poller = createLyricsTranslationPoller({
            songId: currentSong.id,
            lyricsRefreshRevision,
            startedAt: translationStartedAt,
            loadDocument: (signal) => loadLyricsDocumentIntoStore({
                currentSong,
                resolvedHasLyrics,
                lyricsRefreshRevision,
                preserveExisting: true,
                fetchLyrics: (song) => fetchLyricsAsset(song, { signal, dedupe: false }),
                isCancelled: () => signal.aborted,
                reportError: () => {},
            }),
        });
        return poller.stop;
    }, [currentSong, enabled, resolvedHasLyrics, lyricsRefreshRevision, translationStartedAt, translationState]);

}
