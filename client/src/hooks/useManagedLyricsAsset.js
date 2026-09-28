import { t } from '../i18n/index.js';
import React from 'react';
import { invalidateLyricsCacheForSong } from './useLyricsFetcher.js';
import { lyricsWorkspaceApi } from '../services/localLyricsWorkspaceApi.js';
import { showToast } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';

export function unwrapManagedLyricsAsset(response) {
    const data = response?.data || null;
    if (!data) return { song: null, asset: null, lyrics: null, etag: null,
        aiCompletionEnabled: false };
    const directAsset = data.schemaVersion || ['ready', 'not_found'].includes(data.status)
        ? data
        : null;
    return {
        song: data.song || null,
        asset: data.asset || data.artifact || directAsset,
        lyrics: data.lyrics || null,
        etag: data.etag || data.assetEtag || null,
        aiCompletionEnabled: data.aiCompletionEnabled === true,
    };
}

const errorMessage = (error, fallback) => (
    error?.status === 409
        ? '歌词文件已在别处更新，已回读最新内容，请重试。'
        : error?.message || fallback
);

export function useManagedLyricsAsset({ songId, enabled }) {
    const [state, setState] = React.useState({
        song: null,
        asset: null,
        lyrics: null,
        etag: null,
        aiCompletionEnabled: false,
        loading: false,
        saving: false,
        error: '',
    });
    const [isAiCompleting, setIsAiCompleting] = React.useState(false);
    const requestVersionRef = React.useRef(0);
    const pollTimerRef = React.useRef(null);
    const pollDeadlineRef = React.useRef(0);
    const isPollingBusyRef = React.useRef(false);
    const activePollingSongIdRef = React.useRef(null);

    const refreshPlayback = React.useCallback((targetSongId) => {
        invalidateLyricsCacheForSong(targetSongId);
        usePlayerStore.getState().requestLyricsRefresh(targetSongId);
    }, []);

    const load = React.useCallback(async ({ quiet = false } = {}) => {
        if (!songId) return null;
        const version = ++requestVersionRef.current;
        setState((current) => ({ ...current, error: '', loading: quiet ? current.loading : true }));
        try {
            const next = unwrapManagedLyricsAsset(await lyricsWorkspaceApi.getLyrics(songId));
            if (version !== requestVersionRef.current) return null;
            setState((current) => ({ ...current, ...next, loading: false }));
            if (next.song?.language) {
                usePlayerStore.getState().patchSongMetadata(songId, { language: next.song.language });
            }
            return next;
        } catch (error) {
            if (version !== requestVersionRef.current) return null;
            setState((current) => ({
                ...current,
                song: null,
                asset: null,
                lyrics: null,
                etag: null,
                aiCompletionEnabled: false,
                loading: false,
                error: errorMessage(error, '读取当前歌词文件失败'),
            }));
            return null;
        }
    }, [songId]);

    const stopPolling = React.useCallback(() => {
        if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
        pollDeadlineRef.current = 0;
        isPollingBusyRef.current = false;
        activePollingSongIdRef.current = null;
        setIsAiCompleting(false);
    }, []);

    const startPolling = React.useCallback(() => {
        if (pollTimerRef.current) return;
        setIsAiCompleting(true);
        pollDeadlineRef.current = Date.now() + 120000;
        activePollingSongIdRef.current = songId;

        const schedulePoll = () => {
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            pollTimerRef.current = setTimeout(async () => {
                if (!songId || activePollingSongIdRef.current !== songId) {
                    stopPolling();
                    return;
                }
                if (Date.now() > pollDeadlineRef.current) {
                    setState((current) => ({ ...current, error: 'AI 补全仍未完成，请稍后刷新或重试。' }));
                    stopPolling();
                    return;
                }
                if (isPollingBusyRef.current) {
                    schedulePoll();
                    return;
                }
                isPollingBusyRef.current = true;
                try {
                    const next = await load({ quiet: true });
                    if (!next || activePollingSongIdRef.current !== songId) {
                        if (Date.now() < pollDeadlineRef.current) {
                            schedulePoll();
                        } else {
                            stopPolling();
                        }
                        return;
                    }

                    const isPending = next.asset?.aiCompletion?.status === 'pending'
                        || next.lyrics?.translationState === 'pending';
                    const isFailed = next.asset?.aiCompletion?.status === 'failed'
                        || next.lyrics?.translationState === 'failed';
                    const hasTranslation = Boolean(next.asset?.translation);

                    if (isFailed) {
                        setState((current) => ({ ...current, error: 'AI 补全失败，可以重试。' }));
                        stopPolling();
                        return;
                    }

                    if (!isPending) {
                        stopPolling();
                        refreshPlayback(songId);
                        showToast(hasTranslation || next.lyrics?.translationState === 'ready'
                            ? 'AI 补全已完成' : 'AI 歌曲语言识别已完成');
                        return;
                    }

                    if (Date.now() < pollDeadlineRef.current) {
                        schedulePoll();
                    } else {
                        setState((current) => ({ ...current, error: 'AI 补全仍未完成，请稍后刷新或重试。' }));
                        stopPolling();
                    }
                } finally {
                    isPollingBusyRef.current = false;
                }
            }, 1800);
        };

        schedulePoll();
    }, [load, refreshPlayback, songId, stopPolling]);

    React.useEffect(() => {
        const isPending = Boolean(
            state.asset?.aiCompletion?.status === 'pending'
            || state.lyrics?.translationState === 'pending'
        );
        if (isPending && !pollTimerRef.current && songId) {
            startPolling();
        }
    }, [songId, state.asset?.aiCompletion?.status, state.lyrics?.translationState, startPolling]);

    React.useEffect(() => {
        stopPolling();
        requestVersionRef.current += 1;
        setState({ song: null, asset: null, lyrics: null, etag: null, loading: false, saving: false, error: '' });
        if (enabled && songId) void load();
        return () => {
            requestVersionRef.current += 1;
            stopPolling();
        };
    }, [enabled, load, songId, stopPolling]);

    const runMutation = React.useCallback(async (action, successMessage, {
        refreshPlayer = true, conflictResult = false,
    } = {}) => {
        if (!songId || state.saving) return false;
        setState((current) => ({ ...current, saving: true, error: '' }));
        try {
            const response = await action();
            if (refreshPlayer) refreshPlayback(songId);
            await load({ quiet: true });
            if (response?.data?.languageUpdateFailed) showToast(t("歌词已保存，但歌曲语言更新失败；可稍后重新运行 AI 补全"));
            else if (successMessage) showToast(successMessage);
            return true;
        } catch (error) {
            const message = errorMessage(error, '更新歌词文件失败');
            if (error?.status === 409) await load({ quiet: true });
            setState((current) => ({ ...current, error: message }));
            showToast(message);
            return error?.status === 409 ? conflictResult : false;
        } finally {
            setState((current) => ({ ...current, saving: false }));
        }
    }, [load, refreshPlayback, songId, state.saving]);

    const updateOffset = React.useCallback((offsetMs) => runMutation(
        () => lyricsWorkspaceApi.updateLyricsOffset(songId, { offsetMs, etag: state.etag }),
        `歌词偏移已设为 ${offsetMs}ms`,
    ), [runMutation, songId, state.etag]);

    const shiftTimeline = React.useCallback((deltaMs) => runMutation(
        () => lyricsWorkspaceApi.shiftLyricsTimeline(songId, { deltaMs, etag: state.etag }),
        '已将位移写入当前歌词时间轴',
    ), [runMutation, songId, state.etag]);

    const saveDocument = React.useCallback((lines, baselineEtag = state.etag, aiReceipt = null) => runMutation(
        () => lyricsWorkspaceApi.saveLyricsDocument(songId, { lines, etag: baselineEtag, aiReceipt }),
        '共享歌词已更新',
        { conflictResult: 'conflict' },
    ), [runMutation, songId, state.etag]);

    const importLrc = React.useCallback((lrc) => runMutation(
        () => lyricsWorkspaceApi.importLyricsLrc(songId, { lrc, etag: state.etag }),
        'LRC 已导入为当前歌词',
    ), [runMutation, songId, state.etag]);

    const restoreBackup = React.useCallback((asset) => runMutation(
        () => lyricsWorkspaceApi.restoreLyricsBackup(songId, { asset, etag: state.etag }),
        '歌词备份已恢复',
    ), [runMutation, songId, state.etag]);

    const completeTranslation = React.useCallback(async () => {
        const success = await runMutation(
            () => lyricsWorkspaceApi.completeLyricsTranslation(songId),
            'AI 处理已提交',
            { refreshPlayer: false },
        );
        if (success) startPolling();
        return success;
    }, [runMutation, songId, startPolling]);

    const clearTranslation = React.useCallback(() => runMutation(
        () => lyricsWorkspaceApi.clearLyricsTranslation(songId, state.etag),
        '译文已清除',
    ), [runMutation, songId, state.etag]);

    const reset = React.useCallback(() => runMutation(
        () => lyricsWorkspaceApi.resetLyrics(songId, state.etag),
        '歌词文件已重置',
    ), [runMutation, songId, state.etag]);

    return {
        ...state,
        isAiCompleting,
        load,
        updateOffset,
        shiftTimeline,
        saveDocument,
        importLrc,
        restoreBackup,
        completeTranslation,
        clearTranslation,
        reset,
    };
}
