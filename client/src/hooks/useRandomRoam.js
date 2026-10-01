import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerStore } from '../store/usePlayerStore';
import { getApiBaseUrl, hydrateSong } from '../utils';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import { useUIStore } from '../store/useUIStore.js';
import {
    buildRandomRoamPayload,
    normalizeRandomRoamResponse,
    shouldPrefetchRandomRoam,
} from '../randomRoam.js';

const REQUEST_TIMEOUT_MS = 10000;

const getRandomRoamErrorMessage = (error) => {
    if (error?.name === 'AbortError') return '续播请求超时，请重试';
    if (error?.status === 401) return '登录状态已失效，重新登录后可继续漫游';
    if (error?.status === 429) return '请求过于频繁，请稍后重试';
    return '续播加载失败，请重试';
};

export function useRandomRoam({ authenticated, isPlayerContextReady }) {
    const {
        playlist,
        currentSong,
        randomRoam,
        beginRandomRoamRequest,
        appendRandomRoamBatch,
        failRandomRoamRequest,
        pauseRandomRoamRequest,
    } = usePlayerStore(useShallow((state) => ({
        playlist: state.playlist,
        currentSong: state.currentSong,
        randomRoam: state.randomRoam,
        beginRandomRoamRequest: state.beginRandomRoamRequest,
        appendRandomRoamBatch: state.appendRandomRoamBatch,
        failRandomRoamRequest: state.failRandomRoamRequest,
        pauseRandomRoamRequest: state.pauseRandomRoamRequest,
    })));
    const lastRequestKeyRef = useRef('');
    const activeRequestRef = useRef(null);
    const lastHandledManualNonceRef = useRef(0);
    const requestScopeRef = useRef('');
    const activeManualNonceRef = useRef(null);
    const sessionScope = useUIStore(state => `${state.authSession?.user?.accountId || ''}:${state.authSession?.csrfToken || ''}`);

    useEffect(() => () => activeRequestRef.current?.abort(), []);

    useEffect(() => {
        const scope = `${sessionScope}:${randomRoam.language}`;
        if (requestScopeRef.current !== scope) {
            activeRequestRef.current?.abort();
            activeRequestRef.current = null;
            requestScopeRef.current = scope;
            lastRequestKeyRef.current = '';
            if (randomRoam.status === 'loading') { pauseRandomRoamRequest(); return; }
        }
        const manualNonce = Number.isInteger(randomRoam.manualNonce) ? randomRoam.manualNonce : 0;
        const isManualTrigger = manualNonce > lastHandledManualNonceRef.current;
        if (!authenticated || (!randomRoam.enabled && !isManualTrigger && activeManualNonceRef.current !== manualNonce)) {
            activeRequestRef.current?.abort();
            activeRequestRef.current = null;
            lastRequestKeyRef.current = '';
            lastHandledManualNonceRef.current = manualNonce;
            pauseRandomRoamRequest();
            return;
        }
        if (!isPlayerContextReady || !shouldPrefetchRandomRoam({
            randomRoam,
            playlist,
            currentSong,
            lastHandledManualNonce: lastHandledManualNonceRef.current,
        })) {
            return;
        }

        const payload = buildRandomRoamPayload(randomRoam, playlist, currentSong);
        const requestKey = [
            randomRoam.language || 'all',
            randomRoam.batchSize || 10,
            currentSong?.id || '',
            payload.queuedSongIds.join(','),
            randomRoam.retryNonce,
            manualNonce,
        ].join(':');
        if (lastRequestKeyRef.current === requestKey || !beginRandomRoamRequest()) return;
        lastRequestKeyRef.current = requestKey;
        lastHandledManualNonceRef.current = manualNonce;

        if (activeRequestRef.current) {
            activeRequestRef.current.abort();
            activeRequestRef.current = null;
        }
        const controller = new AbortController();
        activeRequestRef.current = controller;
        activeManualNonceRef.current = isManualTrigger && !randomRoam.enabled ? manualNonce : null;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, REQUEST_TIMEOUT_MS);
        const request = async () => {
            try {
                const response = await authenticatedFetch(`${getApiBaseUrl()}/api/songs/roam`, {
                    method: 'POST',
                    credentials: 'include',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FlareTune',
                        'X-CSRF-Token': useUIStore.getState().authSession?.csrfToken || '' },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                if (!response.ok) {
                    const error = new Error(`random roam failed (${response.status})`);
                    error.status = response.status;
                    throw error;
                }
                const { songs, ...batchState } = normalizeRandomRoamResponse(await response.json());
                if (controller.signal.aborted || requestScopeRef.current !== scope) return;
                const hydratedSongs = songs.map(hydrateSong).filter((song) => song?.id != null && song.audio_url);
                if (hydratedSongs.length) lastRequestKeyRef.current = '';
                appendRandomRoamBatch(hydratedSongs, { ...batchState, requestedForSongId: currentSong?.id });
            } catch (error) {
                if (controller.signal.aborted && !timedOut) return;
                failRandomRoamRequest(getRandomRoamErrorMessage(error));
            } finally {
                clearTimeout(timeout);
                if (activeRequestRef.current === controller) {
                    activeRequestRef.current = null;
                    activeManualNonceRef.current = null;
                }
            }
        };
        void request();
    }, [
        appendRandomRoamBatch,
        authenticated,
        beginRandomRoamRequest,
        currentSong,
        failRandomRoamRequest,
        isPlayerContextReady,
        pauseRandomRoamRequest,
        playlist,
        randomRoam.batchSize,
        randomRoam.enabled,
        randomRoam.language,
        randomRoam.manualNonce,
        randomRoam.retryNonce,
        randomRoam.seenSongIds,
        randomRoam.totalPlayable,
        randomRoam.status,
        sessionScope,
    ]);
}
