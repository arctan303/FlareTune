import { isValidSongLanguage } from './constants/language.js';

export const RANDOM_SONGS_CACHE_KEY = 'musicPlayer_xiaoa_random_songs_v2';

export const isValidRandomSongCache = (songs) => (
    Array.isArray(songs)
    && songs.every((song) => song && typeof song === 'object' && song.id != null
        && isValidSongLanguage(song.language))
);

const removeCacheKey = (key) => {
    try {
        window.localStorage.removeItem(key);
    } catch (error) {
        console.warn('清理随机推荐缓存失败:', error);
    }
};

export function loadRandomSongs() {
    try {
        const raw = window.localStorage.getItem(RANDOM_SONGS_CACHE_KEY);
        if (!raw) return null;
        const payload = JSON.parse(raw);
        if (!isValidRandomSongCache(payload?.songs)) {
            removeCacheKey(RANDOM_SONGS_CACHE_KEY);
            return null;
        }
        return payload.songs;
    } catch (error) {
        console.warn('读取随机推荐缓存失败，将改用接口请求:', error);
        removeCacheKey(RANDOM_SONGS_CACHE_KEY);
        return null;
    }
}

export function saveRandomSongs(songs) {
    if (!isValidRandomSongCache(songs)) {
        removeCacheKey(RANDOM_SONGS_CACHE_KEY);
        return;
    }
    try {
        window.localStorage.setItem(RANDOM_SONGS_CACHE_KEY, JSON.stringify({ songs }));
    } catch (error) {
        // 缓存不可用不应让已经成功的 API 请求变成页面错误。
        console.warn('写入随机推荐缓存失败，继续使用内存数据:', error);
    }
}
