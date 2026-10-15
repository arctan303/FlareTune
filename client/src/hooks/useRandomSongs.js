import { useCallback, useEffect, useRef, useState } from 'react';
import { buildRandomSongsUrl } from '../randomSongRequest.js';
import { hydrateSong } from '../utils';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import { createDailyRecommendations } from '../services/dailyRecommendations.js';

const REQUEST_TIMEOUT_MS = 10000;
const REFRESH_COOLDOWN_MS = 2000;

const emptyState = { songs: [], isLoading: true, isRefreshing: false, error: null };

export function useRandomSongs(authenticated, { accountId = '', active = true } = {}) {
    const apiBase = getApiBaseUrl();
    const scope = authenticated && accountId ? JSON.stringify([apiBase, String(accountId)]) : '';
    const [state, setState] = useState({ scope: '', ...emptyState });
    const [isCoolingDown, setIsCoolingDown] = useState(false);
    const instanceRef = useRef(null);
    const cooldownTimerRef = useRef(null);

    useEffect(() => {
        clearTimeout(cooldownTimerRef.current);
        setIsCoolingDown(false);
        if (!scope) { instanceRef.current = null; return undefined; }
        const instance = createDailyRecommendations({ scope, request: async ({ signal, excludeIds }) => {
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) controller.abort();
            const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
            try {
                const response = await authenticatedFetch(buildRandomSongsUrl(apiBase, excludeIds), {
                    signal: controller.signal, credentials: 'include',
                });
                if (!response.ok) throw Object.assign(new Error('Recommendation request failed'), { status: response.status });
                const json = await response.json();
                if (json.code !== 200 || !Array.isArray(json?.data?.songs)) throw new Error('Invalid recommendation response');
                return json.data.songs.map(hydrateSong);
            } finally {
                clearTimeout(timeout);
                signal.removeEventListener('abort', abort);
            }
        } });
        instanceRef.current = { scope, instance };
        const unsubscribe = instance.subscribe(next => setState({ scope, ...next }));
        setState({ scope, ...instance.getSnapshot() });
        return () => { unsubscribe(); instance.dispose(); clearTimeout(cooldownTimerRef.current); };
    }, [scope, apiBase]);

    useEffect(() => {
        if (!scope || !active) return undefined;
        const check = () => {
            if (document.visibilityState === 'hidden') return;
            if (instanceRef.current?.scope === scope) void instanceRef.current.instance.ensureFresh();
        };
        check();
        window.addEventListener('focus', check);
        document.addEventListener('visibilitychange', check);
        return () => {
            window.removeEventListener('focus', check);
            document.removeEventListener('visibilitychange', check);
        };
    }, [scope, active]);

    const refresh = useCallback(async () => {
        const current = instanceRef.current;
        if (!scope || current?.scope !== scope) return { ok: false, message: '请先登录。' };
        if (isCoolingDown) return { ok: false, message: '刷新过于频繁，请稍后再试' };
        const result = await current.instance.refresh();
        if (result.ok && instanceRef.current === current) {
            setIsCoolingDown(true);
            clearTimeout(cooldownTimerRef.current);
            cooldownTimerRef.current = setTimeout(() => setIsCoolingDown(false), REFRESH_COOLDOWN_MS);
        }
        return result;
    }, [scope, isCoolingDown]);

    useEffect(() => () => clearTimeout(cooldownTimerRef.current), []);

    return { ...(state.scope === scope ? state : emptyState), isCoolingDown, refresh };
}
