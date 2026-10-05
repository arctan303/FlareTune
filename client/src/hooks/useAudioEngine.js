import { t } from '../i18n/index.js';
import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { usePlayStatsStore } from '../store/usePlayStatsStore.js';
import { usePlayHistoryStore } from '../store/usePlayHistoryStore.js';
import { showToast, useUIStore } from '../store/useUIStore.js';
import {
    invalidateAudioAnalyser,
    markAudioAnalyserPlaying,
} from '../components/fullscreen/audioAnalyserResource.js';
import { lyricPlaybackClock } from '../services/lyricPlaybackClock.js';
import { findActiveLyricLineIndex, getNextLyricBoundary } from '../utils/lyricTimeline.js';

const HAVE_CURRENT_DATA = 2;

export const canClearBufferingAfterSeek = (audio) => (
    Boolean(audio && audio.readyState >= HAVE_CURRENT_DATA)
);

export const syncCurrentLyricIndex = (state, currentTime) => {
    if (!state || !Array.isArray(state.lyrics) || state.lyrics.length === 0) return false;
    const nextIndex = findActiveLyricLineIndex(
        state.lyrics,
        currentTime,
        state.lyricSyncMode,
    );
    if (nextIndex < 0 || nextIndex === state.currentLyricIndex) return false;
    state.setCurrentLyricIndex(nextIndex);
    return true;
};

/**
 * 音频引擎 hook：集中管理 <audio> 元素的事件处理、缓冲检测、错误重试、
 * MediaSession 进度同步。
 *
 * PlayerContext 回调（claimPlayback / persist* / restorePosition）由 app.jsx
 * 唯一调用一次 usePlayerContext 后以 props 传入；其余 store 读写内部直连
 * getState()，不向根组件追加订阅。
 */
export function useAudioEngine({
    audioRef,
    claimPlayback,
    persistPosition,
    persistPositionThrottled,
    persistSeekPosition,
    restorePosition,
}) {
    const lastTimeRef = useRef(0);
    const stallCountRef = useRef(0);
    const audioErrorTimerRef = useRef(null);
    const consecutiveAudioErrorsRef = useRef(0);
    const playQualificationRef = useRef({
        songId: null,
        accumulatedSeconds: 0,
        lastTime: 0,
        recorded: false,
    });

    const {
        currentSong,
        shouldAutoPlay,
        playNext,
        tryPlay,
    } = usePlayerStore(useShallow((state) => ({
        currentSong: state.currentSong,
        shouldAutoPlay: state.shouldAutoPlay,
        playNext: state.playNext,
        tryPlay: state.tryPlay,
    })));

    const setPlaying = useCallback((v) => usePlayerStore.getState().setIsPlaying(v), []);
    const setBuffering = useCallback((v) => usePlayerStore.getState().setIsBuffering(v), []);
    const setAutoPlay = useCallback((v) => usePlayerStore.getState().setShouldAutoPlay(v), []);

    // === 缓冲 / 进度 ===
    const handleWaiting = useCallback(() => {
        setBuffering(true);
    }, [setBuffering]);

    const clearBuffering = useCallback(() => {
        setBuffering(false);
    }, [setBuffering]);

    const handleTimeUpdate = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const currentTime = audio.currentTime;
        const state = usePlayerStore.getState();
        state.setProgress(currentTime);
        persistPositionThrottled();

        // Buffer detection: if progress stalls while playing, we're buffering
        // Also catch initial load: duration==0 while isPlaying
        if (!audio.paused && currentTime > 0 && currentTime < (audio.duration || Infinity)) {
            if (Math.abs(currentTime - lastTimeRef.current) < 0.05) {
                stallCountRef.current++;
                if (stallCountRef.current >= 3) {
                    setBuffering(true);
                }
            } else {
                if (stallCountRef.current > 0) {
                    stallCountRef.current = 0;
                    setBuffering(false);
                }
            }
        }
        lastTimeRef.current = currentTime;

        if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && state.duration > 0) {
            try {
                navigator.mediaSession.setPositionState({
                    duration: state.duration,
                    playbackRate: audio.playbackRate,
                    position: currentTime
                });
            } catch (e) { console.warn('setPositionState failed:', e); }
        }

        // 有效收听统计（30秒有效收听判定与防误触防刷）
        const activeSong = state.currentSong;
        const qual = playQualificationRef.current;
        if (activeSong?.id) {
            // 当单曲循环重新从头播放（currentTime 归零或大幅跳回开头）且本轮已记录过，重置并开启新一轮有效收听
            if (qual.recorded && (currentTime < 1.5 || currentTime < qual.lastTime - 3)) {
                qual.accumulatedSeconds = 0;
                qual.lastTime = currentTime;
                qual.recorded = false;
            }

            if (qual.songId !== activeSong.id) {
                qual.songId = activeSong.id;
                qual.accumulatedSeconds = 0;
                qual.lastTime = currentTime;
                qual.recorded = false;
            } else if (!qual.recorded && !audio.paused) {
                const delta = currentTime - qual.lastTime;
                if (delta > 0 && delta < 1.5) {
                    qual.accumulatedSeconds += delta;
                }
                const duration = audio.duration || state.duration || 0;
                const isThirtySeconds = qual.accumulatedSeconds >= 30;
                const isShortSongHalf = duration > 0 && duration < 60 && qual.accumulatedSeconds >= duration * 0.5;

                if (isThirtySeconds || isShortSongHalf) {
                    qual.recorded = true;
                    if (useUIStore.getState().authSession?.authenticated) {
                        usePlayStatsStore.getState().recordQualifiedPlay(activeSong.id, activeSong);
                    }
                }
            }
            qual.lastTime = currentTime;
        }
    }, [audioRef, persistPositionThrottled, setBuffering]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return undefined;

        lyricPlaybackClock.attach(audio);
        const unsubscribeClock = lyricPlaybackClock.subscribe((snapshot) => {
            syncCurrentLyricIndex(usePlayerStore.getState(), snapshot.currentTime);
        }, {
            getNextBoundary: (snapshot) => {
                const state = usePlayerStore.getState();
                return getNextLyricBoundary(state.lyrics, snapshot.currentTime, state.lyricSyncMode);
            },
        });
        const unsubscribeLyrics = usePlayerStore.subscribe((state, previousState) => {
            if (
                state.lyrics !== previousState.lyrics
                || state.lyricSyncMode !== previousState.lyricSyncMode
                || state.currentSong?.id !== previousState.currentSong?.id
            ) {
                lyricPlaybackClock.sample('lyrics-state-change');
            }
        });

        return () => {
            unsubscribeLyrics();
            unsubscribeClock();
            lyricPlaybackClock.detach(audio);
        };
    }, [audioRef]);

    // === 错误重试 ===
    const handleError = useCallback((e) => {
        clearBuffering();
        if (currentSong) {
            console.error('音频加载失败:', e.target.error);
            consecutiveAudioErrorsRef.current += 1;
            if (audioErrorTimerRef.current) clearTimeout(audioErrorTimerRef.current);

            if (consecutiveAudioErrorsRef.current >= 3) {
                setAutoPlay(false);
                setPlaying(false);
                showToast(t("连续多首歌曲加载失败，已停止自动跳转"), 3000);
                return;
            }

            showToast(t("音频加载失败，正在尝试下一首"), 2000);
            audioErrorTimerRef.current = setTimeout(() => {
                audioErrorTimerRef.current = null;
                playNext({ type: 'error' });
            }, 1500);
        }
    }, [clearBuffering, currentSong, playNext, setAutoPlay, setPlaying]);

    // === 结束与自动下一首 ===
    const handleEnded = useCallback((e) => {
        // 歌曲播放完毕或循环时重置有效收听状态
        const activeSong = usePlayerStore.getState().currentSong;
        playQualificationRef.current = {
            songId: activeSong?.id || null,
            accumulatedSeconds: 0,
            lastTime: 0,
            recorded: false,
        };
        playNext(e);
    }, [playNext]);

    const handleLoadStart = useCallback((e) => {
        invalidateAudioAnalyser(e.currentTarget);
        setBuffering(true);
    }, [setBuffering]);

    const handleEmptied = useCallback((e) => invalidateAudioAnalyser(e.currentTarget), []);

    const handlePlay = useCallback(() => {
        const audio = audioRef.current;
        if (audio) {
            restorePosition(audio);
        }
        setPlaying(true);
        claimPlayback();
        const active = usePlayerStore.getState().currentSong;
        if (active?.id && useUIStore.getState().authSession?.authenticated) {
            usePlayHistoryStore.getState().addSong(active);
        }
    }, [audioRef, claimPlayback, restorePosition, setPlaying]);

    const handlePause = useCallback(() => {
        setPlaying(false);
        persistPosition();
    }, [persistPosition, setPlaying]);

    const handlePlaying = useCallback((e) => {
        markAudioAnalyserPlaying(e.currentTarget);
        clearBuffering();
        consecutiveAudioErrorsRef.current = 0;
        if (audioErrorTimerRef.current) {
            clearTimeout(audioErrorTimerRef.current);
            audioErrorTimerRef.current = null;
        }
        const active = usePlayerStore.getState().currentSong;
        if (active?.id && useUIStore.getState().authSession?.authenticated) {
            usePlayHistoryStore.getState().addSong(active);
        }
    }, [clearBuffering]);

    const handleSeeking = useCallback(() => {
        setBuffering(true);
    }, [setBuffering]);

    const handleSeeked = useCallback((event) => {
        // seeked only means the playhead move finished. When the target is
        // already buffered, browsers do not have to emit canplay/playing
        // again, so relying on those events can leave the UI permanently in
        // a buffering state even while playback continues normally.
        if (canClearBufferingAfterSeek(event.currentTarget)) {
            clearBuffering();
        }
        persistSeekPosition();
    }, [clearBuffering, persistSeekPosition]);

    const audioHandlers = {
        onTimeUpdate: handleTimeUpdate,
        onLoadStart: handleLoadStart,
        onEmptied: handleEmptied,
        onLoadedMetadata: (e) => restorePosition(e.currentTarget),
        onEnded: handleEnded,
        onWaiting: handleWaiting,
        onStalled: handleWaiting,
        onPlay: handlePlay,
        onPause: handlePause,
        onPlaying: handlePlaying,
        onSeeking: handleSeeking,
        onSeeked: handleSeeked,
        onCanPlay: (e) => {
            restorePosition(e.currentTarget);
            clearBuffering();
        },
        onError: handleError,
    };

    // 歌曲切换时重置有效收听计时
    useEffect(() => {
        playQualificationRef.current = {
            songId: currentSong?.id || null,
            accumulatedSeconds: 0,
            lastTime: 0,
            recorded: false,
        };
    }, [currentSong?.id]);

    // 自动播放：currentSong 就绪且应自动播放时启动
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !currentSong?.audio_url || !shouldAutoPlay) return undefined;

        let cancelled = false;
        const startPlayback = () => {
            if (cancelled) return;
            setAutoPlay(false);
            tryPlay();
        };

        if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            startPlayback();
            return undefined;
        }

        audio.addEventListener('canplay', startPlayback, { once: true });
        return () => {
            cancelled = true;
            audio.removeEventListener('canplay', startPlayback);
        };
    }, [audioRef, currentSong?.audio_url, currentSong?.id, setAutoPlay, shouldAutoPlay, tryPlay]);

    // 错误重试定时器清理
    useEffect(() => () => {
        if (audioErrorTimerRef.current) clearTimeout(audioErrorTimerRef.current);
    }, []);

    useEffect(() => {
        if (audioErrorTimerRef.current) {
            clearTimeout(audioErrorTimerRef.current);
            audioErrorTimerRef.current = null;
        }
    }, [currentSong?.id]);

    return { audioHandlers };
}
