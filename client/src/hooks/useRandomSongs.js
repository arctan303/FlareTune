import { useCallback, useEffect, useRef, useState } from 'react';
import { isValidRandomSongCache, loadRandomSongs, saveRandomSongs } from '../randomSongCache';
import { buildRandomSongsUrl } from '../randomSongRequest.js';
import { hydrateSong } from '../utils';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';

const REQUEST_TIMEOUT_MS = 10000;
const REFRESH_COOLDOWN_MS = 2000;

export function useRandomSongs(authenticated) {
    const [songs, setSongs] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isCoolingDown, setIsCoolingDown] = useState(false);
    const [error, setError] = useState(null);
    const requestIdRef = useRef(0);
    const cooldownTimerRef = useRef(null);

    const apiBase = getApiBaseUrl();

    const requestSongs = useCallback(async (excludeIds = []) => {
        const requestId = ++requestIdRef.current;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await authenticatedFetch(buildRandomSongsUrl(apiBase, excludeIds), { signal: controller.signal, credentials: 'include' });
            if (!response.ok) {
                const err = new Error(`random failed (${response.status})`);
                err.status = response.status;
                throw err;
            }
            const json = await response.json();
            if (json.code !== 200 || !Array.isArray(json?.data?.songs)) {
                throw new Error('Invalid random response format');
            }
            const nextSongs = json.data.songs
                .map(hydrateSong)
                .filter((song) => song?.id != null);
            if (!isValidRandomSongCache(nextSongs)) {
                throw new Error('Invalid random song language metadata');
            }
            if (requestIdRef.current === requestId) {
                saveRandomSongs(nextSongs);
                setSongs(nextSongs);
                setError(null);
            }
            return { ok: true, songs: nextSongs };
        } catch (err) {
            const message = err?.name === 'AbortError'
                ? '随机推荐请求超时，请稍后重试'
                : err?.status === 401
                    ? '登录状态已失效，请重新登录后再试'
                    : err?.status === 429
                        ? '刷新过于频繁，请稍后再试'
                        : '随机推荐加载失败，请稍后重试';
            if (requestIdRef.current === requestId) setError(message);
            return { ok: false, message };
        } finally {
            clearTimeout(timeout);
            if (requestIdRef.current === requestId) setIsRefreshing(false);
        }
    }, [apiBase]);

    useEffect(() => {
        if (!authenticated) return;

        const cached = loadRandomSongs();
        if (Array.isArray(cached) && cached.length > 0) {
            setSongs(cached);
            return;
        }

        let cancelled = false;
        setIsLoading(true);
        requestSongs().finally(() => {
            if (!cancelled) setIsLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [authenticated, requestSongs]);

    const refresh = useCallback(async () => {
        if (!authenticated) return { ok: false, message: '请先登录。' };
        setIsRefreshing(true);
        const result = await requestSongs(songs.map((song) => String(song?.id || '')));
        setIsRefreshing(false);
        if (result?.ok) {
            setIsCoolingDown(true);
            clearTimeout(cooldownTimerRef.current);
            cooldownTimerRef.current = setTimeout(() => setIsCoolingDown(false), REFRESH_COOLDOWN_MS);
        }
        return result;
    }, [authenticated, requestSongs, songs]);

    useEffect(() => () => clearTimeout(cooldownTimerRef.current), []);

    return { songs, isLoading, isRefreshing, isCoolingDown, error, refresh };
}
