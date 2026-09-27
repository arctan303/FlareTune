import { isValidSongLanguage } from './constants/language.js';

const DB_NAME = 'arc-player-context';
const DB_VERSION = 1;
const STORE_NAME = 'contexts';
const CONTEXT_KEY = 'current';

export const PLAYER_CONTEXT_SCHEMA = 1;

const MAX_QUEUE_LENGTH = 500;

const toFiniteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const toText = (value, fallback = '') => (
    typeof value === 'string' ? value.trim() : fallback
);

const cleanAssetUrl = (value) => {
    const raw = toText(value);
    if (!raw) return '';
    try {
        const url = new URL(raw, window.location.origin);
        url.searchParams.delete('_c');
        return /^https?:/i.test(raw) ? url.href : `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return raw;
    }
};

export const toCanonicalSong = (song) => {
    if (!song || typeof song !== 'object') return null;
    const id = toText(song.id);
    const audioUrl = cleanAssetUrl(song.audio_url);
    if (!id || !audioUrl) return null;

    return {
        id,
        title: toText(song.title, '未知歌曲'),
        artist: toText(song.artist, '未知艺术家'),
        album: toText(song.album),
        duration: toFiniteNumber(song.duration),
        audio_url: audioUrl,
        cover_url: cleanAssetUrl(song.cover_url),
        language: isValidSongLanguage(song.language) ? song.language : null,
    };
};

export const toCanonicalQueue = (queue) => {
    if (!Array.isArray(queue)) return [];
    const seen = new Set();
    const result = [];
    for (const item of queue.slice(0, MAX_QUEUE_LENGTH)) {
        const song = toCanonicalSong(item);
        if (!song || seen.has(song.id)) continue;
        seen.add(song.id);
        result.push(song);
    }
    return result;
};

const normalizeSessionId = (value) => {
    const sessionId = toText(value);
    return sessionId && sessionId.length <= 128 ? sessionId : '';
};

export const normalizePlayerContext = (value) => {
    if (!value || typeof value !== 'object') return null;
    if (value.schema !== PLAYER_CONTEXT_SCHEMA) return null;
    const queue = toCanonicalQueue(value.queue);
    const sessionId = normalizeSessionId(value.sessionId);
    let currentSongId = toText(value.currentSongId);
    if (queue.length === 0 || !sessionId) return null;
    const hasValidCurrentSong = queue.some((song) => song.id === currentSongId);
    if (!hasValidCurrentSong) currentSongId = queue[0].id;

    return {
        schema: PLAYER_CONTEXT_SCHEMA,
        revision: Math.max(1, Math.floor(toFiniteNumber(value.revision, 1))),
        currentSongId,
        position: hasValidCurrentSong ? toFiniteNumber(value.position) : 0,
        duration: hasValidCurrentSong
            ? toFiniteNumber(value.duration)
            : toFiniteNumber(queue[0].duration),
        queue,
        updatedAt: Math.max(1, Math.floor(toFiniteNumber(value.updatedAt, Date.now()))),
        writer: 'music',
        sessionId,
    };
};

let databasePromise;

const openDatabase = () => {
    if (!('indexedDB' in window)) {
        return Promise.reject(new Error('IndexedDB is unavailable'));
    }
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
        let settled = false;
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);
        const fail = (error) => {
            if (settled) return;
            settled = true;
            databasePromise = undefined;
            reject(error);
        };
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => {
            if (settled) {
                request.result.close();
                return;
            }
            settled = true;
            const database = request.result;
            database.onversionchange = () => {
                database.close();
                databasePromise = undefined;
            };
            resolve(database);
        };
        request.onerror = () => fail(request.error || new Error('Unable to open player context database'));
        request.onblocked = () => fail(new Error('Player context database upgrade is blocked'));
    });
    return databasePromise;
};

const runReadwrite = async (update) => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getRequest = store.get(CONTEXT_KEY);
        let result;

        getRequest.onsuccess = () => {
            try {
                const current = normalizePlayerContext(getRequest.result);
                result = update(current);
                if (result) store.put(result, CONTEXT_KEY);
            } catch (error) {
                transaction.abort();
                reject(error);
            }
        };
        getRequest.onerror = () => reject(getRequest.error || new Error('Unable to read player context'));
        transaction.oncomplete = () => {
            resolve(result || null);
        };
        transaction.onerror = () => reject(transaction.error || new Error('Unable to write player context'));
        transaction.onabort = () => {
            if (transaction.error) reject(transaction.error);
        };
    });
};

export const readPlayerContext = async () => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(CONTEXT_KEY);
        let result = null;
        request.onsuccess = () => {
            result = normalizePlayerContext(request.result);
            if (!request.result) return;
            if (result) store.put(result, CONTEXT_KEY);
            else store.delete(CONTEXT_KEY);
        };
        request.onerror = () => reject(request.error || new Error('Unable to read player context'));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error('Unable to repair player context'));
    });
};

export const writePlayerContext = (payload) => {
    const normalized = normalizePlayerContext({
        ...payload,
        schema: PLAYER_CONTEXT_SCHEMA,
        revision: 1,
        updatedAt: Date.now(),
    });
    if (!normalized) return Promise.reject(new Error('Invalid player context'));

    return runReadwrite((current) => ({
        ...normalized,
        revision: (current?.revision || 0) + 1,
        updatedAt: Math.max(Date.now(), (current?.updatedAt || 0) + 1),
        writer: 'music',
    }));
};

export const mergePlayerContextSongMetadata = (context, authoritativeSongs, now = Date.now()) => {
    const current = normalizePlayerContext(context);
    if (!current) return null;

    const authoritativeById = new Map(
        toCanonicalQueue(authoritativeSongs)
            .filter((song) => isValidSongLanguage(song.language))
            .map((song) => [song.id, song]),
    );
    if (authoritativeById.size === 0) return current;

    let changed = false;
    const queue = current.queue.map((song) => {
        const authoritative = authoritativeById.get(song.id);
        if (!authoritative) return song;
        changed = true;
        return { ...song, language: authoritative.language };
    });
    if (!changed) return current;

    return {
        ...current,
        queue,
        revision: current.revision + 1,
        updatedAt: Math.max(Math.floor(toFiniteNumber(now, Date.now())), current.updatedAt + 1),
    };
};

/**
 * Applies only song metadata to the latest IndexedDB context inside one
 * transaction. Concurrent queue/current/progress/session writes always win.
 */
export const patchPlayerContextSongMetadata = (authoritativeSongs) => (
    runReadwrite((current) => mergePlayerContextSongMetadata(current, authoritativeSongs))
);

export const updatePlayerPosition = (payload) => {
    const currentSongId = toText(payload?.currentSongId);
    const sessionId = toText(payload?.sessionId);
    if (!currentSongId) return Promise.reject(new Error('Invalid current song'));
    if (!sessionId || sessionId.length > 128) return Promise.reject(new Error('Invalid playback session'));

    return runReadwrite((current) => {
        if (!current) throw new Error('No player context');
        if (current.currentSongId !== currentSongId) {
            throw new Error('Stale player position');
        }
        if (current.sessionId !== sessionId) {
            throw new Error('Stale playback session');
        }
        return {
            ...current,
            revision: current.revision + 1,
            position: toFiniteNumber(payload?.position),
            duration: toFiniteNumber(payload?.duration, current.duration),
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
            writer: 'music',
        };
    });
};

export const claimPlayerContext = (payload) => {
    const currentSongId = toText(payload?.currentSongId);
    const sessionId = toText(payload?.sessionId);
    if (!currentSongId) return Promise.reject(new Error('Invalid current song'));
    if (!sessionId || sessionId.length > 128) return Promise.reject(new Error('Invalid playback session'));

    return runReadwrite((current) => {
        if (!current) throw new Error('No player context');
        if (current.currentSongId !== currentSongId) throw new Error('Stale player position');
        return {
            ...current,
            revision: current.revision + 1,
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
            writer: 'music',
            sessionId,
        };
    });
};

export const clearPlayerContext = async () => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(CONTEXT_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Unable to clear player context'));
    });
};
