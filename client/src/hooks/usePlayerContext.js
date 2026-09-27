import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiBaseUrl, hydratePlayableSong } from '../utils';
import { usePlayerStore } from '../store/usePlayerStore';
import { useUIStore } from '../store/useUIStore';
import { repairSongLanguages } from '../resolveSongs';
import {
    claimPlayerContext,
    clearPlayerContext,
    readPlayerContext,
    patchPlayerContextSongMetadata,
    updatePlayerPosition,
    writePlayerContext,
} from '../playerContext';

const RESTORE_END_GUARD_SECONDS = 5;
const POSITION_SAVE_INTERVAL = 4000;

const createPlaybackSessionId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `music-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getQueueIdSignature = (queue) => (
    Array.isArray(queue) ? queue.map((song) => song?.id || '').join('\u0000') : ''
);

const normalizeMediaUrl = (value) => {
    try {
        const url = new URL(value, window.location.href);
        url.searchParams.delete('_c');
        return url.href;
    } catch {
        return '';
    }
};

const audioMatchesSong = (audio, song) => {
    const audioUrl = audio?.currentSrc || audio?.src;
    return Boolean(
        audioUrl && song?.audio_url
        && normalizeMediaUrl(audioUrl) === normalizeMediaUrl(song.audio_url)
    );
};

export function usePlayerContext(audioRef) {
    const authInitialized = useUIStore((state) => Boolean(state.authSession?.initialized));
    const authenticated = useUIStore((state) => Boolean(state.authSession?.authenticated));
    const [isPlayerContextReady, setIsPlayerContextReady] = useState(false);
    const isReadyRef = useRef(false);
    const pendingRestoreRef = useRef(null);
    const ignoreNextSeekedRef = useRef(false);
    const lastPositionSaveRef = useRef(0);
    const playbackSessionIdRef = useRef(null);
    const ownerWriteRef = useRef(Promise.resolve());
    if (!playbackSessionIdRef.current) playbackSessionIdRef.current = createPlaybackSessionId();

    useEffect(() => {
        if (!authInitialized) return undefined;
        let cancelled = false;
        const repairController = new AbortController();
        const hydrate = async () => {
            try {
                if (!authenticated) {
                    await clearPlayerContext();
                    return;
                }
                let context = await readPlayerContext();
                if (cancelled || !context) return;
                let queue = context.queue.map((song) => {
                    const hydrated = hydratePlayableSong(song);
                    if (!hydrated) return null;
                    return hydrated;
                }).filter(Boolean);
                try {
                    const repaired = await repairSongLanguages(queue, {
                        apiBase: getApiBaseUrl(),
                        signal: repairController.signal,
                    });
                    if (cancelled) return;
                    queue = repaired.songs;
                    if (repaired.repairedSongIds.length > 0) {
                        const repairedIdSet = new Set(repaired.repairedSongIds);
                        const authoritativeSongs = queue.filter((song) => repairedIdSet.has(String(song.id)));
                        const latestContext = await patchPlayerContextSongMetadata(authoritativeSongs);
                        if (cancelled || !latestContext) return;
                        context = latestContext;
                        queue = context.queue.map(hydratePlayableSong).filter(Boolean);
                    }
                    if (repaired.unresolvedSongIds.length > 0) {
                        console.warn('部分歌曲语言未能从服务端补全:', repaired.unresolvedSongIds);
                    }
                } catch (error) {
                    if (error?.name !== 'AbortError') {
                        console.warn('补全播放队列歌曲语言失败，保留原播放记录:', error);
                    }
                }
                if (cancelled) return;
                const currentSong = queue.find((song) => song.id === context.currentSongId) || queue[0];
                if (!currentSong) {
                    await clearPlayerContext();
                    return;
                }

                pendingRestoreRef.current = {
                    currentSongId: currentSong.id,
                    position: context.position,
                };
                usePlayerStore.setState({
                    playlist: queue,
                    currentSong,
                    progress: context.position,
                    duration: context.duration,
                    isPlaying: false,
                    shouldAutoPlay: false,
                });
                if (audioRef?.current && audioRef.current.readyState >= HTMLMediaElement.HAVE_METADATA) {
                    restorePosition(audioRef.current);
                }
            } catch (error) {
                console.warn('读取本地播放记录失败，将使用默认歌单:', error);
            } finally {
                if (!cancelled) {
                    isReadyRef.current = true;
                    setIsPlayerContextReady(true);
                }
            }
        };
        hydrate();
        return () => {
            cancelled = true;
            repairController.abort();
        };
    }, [authInitialized, authenticated]);

    useEffect(() => usePlayerStore.subscribe((state, previous) => {
        if (!isReadyRef.current) return;
        if (!useUIStore.getState().authSession?.authenticated) return;
        const songChanged = state.currentSong?.id !== previous.currentSong?.id;
        const queueChanged = getQueueIdSignature(state.playlist) !== getQueueIdSignature(previous.playlist);
        if (!songChanged && !queueChanged) return;

        if (!state.currentSong || state.playlist.length === 0) {
            if (previous.currentSong || previous.playlist.length > 0) {
                clearPlayerContext().catch((error) => console.warn('清除播放记录失败:', error));
            }
            return;
        }

        const audio = audioRef.current;
        ownerWriteRef.current = writePlayerContext({
            currentSongId: state.currentSong.id,
            position: songChanged ? 0 : (audio?.currentTime || state.progress || 0),
            duration: songChanged ? 0 : (audio?.duration || state.duration || 0),
            queue: state.playlist,
            writer: 'music',
            sessionId: playbackSessionIdRef.current,
        }).catch((error) => console.warn('保存播放上下文失败:', error));
    }), [audioRef]);

    const claimPlayback = useCallback(() => {
        if (!isReadyRef.current) return Promise.resolve(null);
        if (!useUIStore.getState().authSession?.authenticated) return Promise.resolve(null);
        const state = usePlayerStore.getState();
        const audio = audioRef.current;
        if (!state.currentSong || !audioMatchesSong(audio, state.currentSong)) return Promise.resolve(null);

        ownerWriteRef.current = ownerWriteRef.current
            .catch(() => null)
            .then(() => claimPlayerContext({
                currentSongId: state.currentSong.id,
                writer: 'music',
                sessionId: playbackSessionIdRef.current,
            }))
            .catch((error) => {
                if (error?.message === 'No player context') {
                    return writePlayerContext({
                        currentSongId: state.currentSong.id,
                        position: audio.currentTime || 0,
                        duration: audio.duration || state.duration || 0,
                        queue: state.playlist,
                        writer: 'music',
                        sessionId: playbackSessionIdRef.current,
                    });
                }
                if (error?.message !== 'Stale player position') {
                    console.warn('取得播放进度写入权失败:', error);
                }
                return null;
            });
        return ownerWriteRef.current;
    }, [audioRef]);

    const persistPosition = useCallback(() => {
        if (!isReadyRef.current) return Promise.resolve(null);
        if (!useUIStore.getState().authSession?.authenticated) return Promise.resolve(null);
        const state = usePlayerStore.getState();
        const audio = audioRef.current;
        if (!state.currentSong || !audioMatchesSong(audio, state.currentSong)) return Promise.resolve(null);
        lastPositionSaveRef.current = Date.now();
        return ownerWriteRef.current
            .catch(() => null)
            .then(() => updatePlayerPosition({
                currentSongId: state.currentSong.id,
                position: audio.currentTime || 0,
                duration: audio.duration || state.duration || 0,
                writer: 'music',
                sessionId: playbackSessionIdRef.current,
            }))
            .catch((error) => {
                if (!['Stale player position', 'Stale playback session', 'No player context'].includes(error?.message)) {
                    console.warn('保存播放进度失败:', error);
                }
                return null;
            });
    }, [audioRef]);

    const persistPositionThrottled = useCallback(() => {
        if (Date.now() - lastPositionSaveRef.current >= POSITION_SAVE_INTERVAL) {
            persistPosition();
        }
    }, [persistPosition]);

    const persistSeekPosition = useCallback(async () => {
        if (ignoreNextSeekedRef.current) {
            ignoreNextSeekedRef.current = false;
            return;
        }
        await claimPlayback();
        return persistPosition();
    }, [claimPlayback, persistPosition]);

    const restorePosition = useCallback((audio) => {
        if (!audio) return false;
        const state = usePlayerStore.getState();
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
            state.setDuration(audio.duration);
        }
        const pending = pendingRestoreRef.current;
        let targetPosition = null;

        if (pending && pending.currentSongId === state.currentSong?.id) {
            targetPosition = Number(pending.position) || 0;
            pendingRestoreRef.current = null;
        } else if (state.progress > 0 && Math.abs(audio.currentTime) < 0.5) {
            targetPosition = state.progress;
        }

        if (targetPosition === null) {
            return audioMatchesSong(audio, state.currentSong);
        }

        if (!audioMatchesSong(audio, state.currentSong)) {
            const audioUrl = audio.currentSrc || audio.src;
            if (!audioUrl) {
                pendingRestoreRef.current = {
                    currentSongId: state.currentSong?.id,
                    position: targetPosition,
                };
                return false;
            }
        }

        const position = audio.duration > 0 && targetPosition >= audio.duration - RESTORE_END_GUARD_SECONDS
            ? 0
            : Math.min(targetPosition, Math.max(0, audio.duration || targetPosition));
        if (position > 0 && Math.abs(audio.currentTime - position) > 0.5) {
            ignoreNextSeekedRef.current = true;
            try {
                audio.currentTime = position;
            } catch (e) {
                console.warn('恢复播放进度失败:', e);
            }
        }
        state.setProgress(position);
        return true;
    }, []);

    useEffect(() => {
        if (!isPlayerContextReady || !audioRef?.current) return;
        const audio = audioRef.current;
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
            restorePosition(audio);
        }
    }, [isPlayerContextReady, audioRef, restorePosition]);

    useEffect(() => {
        const handlePageHide = () => persistPosition();
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') persistPosition();
        };
        window.addEventListener('pagehide', handlePageHide);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            window.removeEventListener('pagehide', handlePageHide);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [persistPosition]);

    return {
        isPlayerContextReady,
        claimPlayback,
        persistPosition,
        persistPositionThrottled,
        persistSeekPosition,
        restorePosition,
    };
}
