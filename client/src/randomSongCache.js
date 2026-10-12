import { isValidSongLanguage } from './constants/language.js';
import { RANDOM_SONGS_LIMIT } from './randomSongRequest.js';

// Undated v2 entries cannot prove that a preview is a complete daily batch.
export const RANDOM_SONGS_CACHE_KEY = 'musicPlayer_xiaoa_random_songs_v3';
const cacheKey = (scope) => `${RANDOM_SONGS_CACHE_KEY}:${encodeURIComponent(scope)}`;

export const localRecommendationDate = (date = new Date()) => (
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

export const isValidRandomSongCache = (songs) => {
    const seen = new Set();
    return Array.isArray(songs) && songs.length <= RANDOM_SONGS_LIMIT && songs.every((song) => {
        if (!song || song.id == null || !String(song.id).trim()
            || typeof song.audio_url !== 'string' || !song.audio_url.trim()
            || !isValidSongLanguage(song.language) || seen.has(String(song.id))) return false;
        seen.add(String(song.id));
        return true;
    });
};

export function loadRandomSongs(scope) {
    if (!scope) return null;
    try {
        const raw = globalThis.window?.localStorage.getItem(cacheKey(scope));
        if (!raw) return null;
        const payload = JSON.parse(raw);
        if (payload?.limit === RANDOM_SONGS_LIMIT && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
            && isValidRandomSongCache(payload.songs)) return payload;
    } catch {
        // Storage may be blocked. The current session can still use live data.
    }
    return null;
}

export function saveRandomSongs(songs, { scope, date } = {}) {
    if (!scope || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValidRandomSongCache(songs)) return;
    try {
        globalThis.window?.localStorage.setItem(cacheKey(scope), JSON.stringify({ songs, date, limit: RANDOM_SONGS_LIMIT }));
    } catch {
        // A cache write failure must not turn a successful request into an error.
    }
}
