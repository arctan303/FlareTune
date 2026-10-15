import { isValidRandomSongCache, localRecommendationDate, loadRandomSongs, saveRandomSongs } from '../randomSongCache.js';
import { RANDOM_SONGS_LIMIT } from '../randomSongRequest.js';

export function normalizeDailySongs(songs) {
    const seen = new Set();
    const batch = songs.filter((song) => {
        if (song?.id == null || !String(song.id).trim() || typeof song.audio_url !== 'string'
            || !song.audio_url.trim() || seen.has(String(song.id))) return false;
        seen.add(String(song.id));
        return true;
    }).slice(0, RANDOM_SONGS_LIMIT);
    if (!isValidRandomSongCache(batch)) throw new Error('Invalid recommendation metadata');
    return batch;
}

export function createDailyRecommendationPlaylist(songs = []) {
    return { id: 'daily-recommend', name: '今日精选', cover_url: songs[0]?.cover_url, preloadedSongs: songs };
}

const requestError = (error) => error?.name === 'AbortError' ? '每日推荐请求超时，请重试'
    : error?.status === 401 ? '登录状态已失效，请重新登录后再试'
        : error?.status === 429 ? '刷新过于频繁，请稍后再试' : '每日推荐加载失败，请重试';

// Shared daily behaviour; a Demo can inject a local sampler instead of HTTP.
export function createDailyRecommendations({ scope, request, today = localRecommendationDate,
    load = loadRandomSongs, save = saveRandomSongs }) {
    const cached = load(scope);
    let state = { songs: cached?.songs || [], date: cached?.date || null,
        isLoading: false, isRefreshing: false, error: null };
    let pending = null, controller = null, disposed = false;
    const listeners = new Set();
    const publish = (patch) => {
        state = { ...state, ...patch };
        for (const listener of listeners) listener(state);
    };
    const update = () => {
        if (disposed) return Promise.resolve({ ok: false, stale: true });
        if (pending) return pending;
        const date = today();
        controller = new AbortController();
        publish({ isLoading: state.date === null, isRefreshing: true, error: null });
        pending = Promise.resolve().then(() => request({ signal: controller.signal, excludeIds: state.songs.map(song => String(song.id)) }))
            .then((songs) => {
                if (disposed) return { ok: false, stale: true };
                const batch = normalizeDailySongs(songs);
                save(batch, { scope, date });
                publish({ songs: batch, date, error: null });
                return { ok: true, songs: batch };
            }).catch((error) => {
                if (disposed) return { ok: false, stale: true };
                const message = requestError(error);
                publish({ error: message });
                return { ok: false, message };
            }).finally(() => {
                pending = null;
                if (!disposed) publish({ isLoading: false, isRefreshing: false });
            });
        return pending;
    };
    return {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        ensureFresh() {
            if (pending) return pending;
            return state.date === today() ? Promise.resolve({ ok: true, songs: state.songs }) : update();
        },
        refresh: update,
        dispose() { disposed = true; controller?.abort(); listeners.clear(); },
    };
}
