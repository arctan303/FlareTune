import { isPlayableSong } from '../utils.js';

export function sanitizePlayableQueue(playlist) {
    if (!Array.isArray(playlist)) return [];
    const seen = new Set();
    return playlist.filter(song => {
        if (!isPlayableSong(song) || seen.has(song.id)) return false;
        seen.add(song.id);
        return true;
    });
}

export function planInsertNext(playlist, currentSong, targetSong) {
    const playableQueue = sanitizePlayableQueue(playlist);
    if (!isPlayableSong(targetSong)) {
        return { action: 'reject', playlist: playableQueue };
    }

    if (!isPlayableSong(currentSong)) {
        return {
            action: 'play',
            playlist: [targetSong, ...playableQueue.filter(song => song.id !== targetSong.id)],
        };
    }

    if (currentSong.id === targetSong.id) {
        return { action: 'noop', playlist: playableQueue };
    }

    const nextPlaylist = playableQueue.filter(song => song.id !== targetSong.id);
    const currentIndex = nextPlaylist.findIndex(song => song.id === currentSong.id);
    if (currentIndex >= 0) {
        nextPlaylist.splice(currentIndex + 1, 0, targetSong);
    } else {
        nextPlaylist.unshift(currentSong, targetSong);
    }

    return { action: 'queue', playlist: nextPlaylist };
}

const sameQueue = (left, right) => (
    left.length === right.length && left.every((song, index) => song.id === right[index]?.id)
);

export function planQueueEdit(playlist, currentSong, targetSongs, operation = 'insert_next') {
    const playableQueue = sanitizePlayableQueue(playlist);
    const playableTargets = sanitizePlayableQueue(targetSongs);
    if (playableTargets.length === 0 || !['insert_next', 'append'].includes(operation)) {
        return { action: 'reject', playlist: playableQueue, affectedSongIds: [] };
    }

    const currentIsPlayable = isPlayableSong(currentSong);
    const movableTargets = currentIsPlayable
        ? playableTargets.filter((song) => song.id !== currentSong.id)
        : playableTargets;
    if (movableTargets.length === 0) {
        return { action: 'noop', playlist: playableQueue, affectedSongIds: [] };
    }

    const targetIds = new Set(movableTargets.map((song) => song.id));
    const baseQueue = playableQueue.filter((song) => !targetIds.has(song.id));
    let insertIndex = baseQueue.length;
    if (operation === 'insert_next') {
        if (currentIsPlayable) {
            let currentIndex = baseQueue.findIndex((song) => song.id === currentSong.id);
            if (currentIndex < 0) {
                baseQueue.unshift(currentSong);
                currentIndex = 0;
            }
            insertIndex = currentIndex + 1;
        } else {
            insertIndex = 0;
        }
    }
    const nextPlaylist = [
        ...baseQueue.slice(0, insertIndex),
        ...movableTargets,
        ...baseQueue.slice(insertIndex),
    ];
    const action = sameQueue(playableQueue, nextPlaylist) ? 'noop' : 'update';
    const affectedSongIds = action === 'noop'
        ? []
        : movableTargets
            .filter((song) => (
                playableQueue.findIndex((item) => item.id === song.id)
                !== nextPlaylist.findIndex((item) => item.id === song.id)
            ))
            .map((song) => song.id);
    return { action, playlist: nextPlaylist, affectedSongIds };
}

export function reorderQueue(playlist, fromIndex, toIndex) {
    if (!Array.isArray(playlist) || playlist.length < 2) return playlist;
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return playlist;
    if (fromIndex < 0 || fromIndex >= playlist.length) return playlist;
    const boundedTo = Math.max(0, Math.min(playlist.length - 1, toIndex));
    if (fromIndex === boundedTo) return playlist;

    const playableQueue = sanitizePlayableQueue(playlist);
    const boundedPlayableTo = Math.max(0, Math.min(playableQueue.length - 1, toIndex));
    if (fromIndex >= playableQueue.length || fromIndex === boundedPlayableTo) {
        return sameQueue(playlist, playableQueue) ? playlist : playableQueue;
    }

    const next = [...playableQueue];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(boundedPlayableTo, 0, moved);
    return next;
}
