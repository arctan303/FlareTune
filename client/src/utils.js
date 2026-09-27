export const getBaseUrl = () => {
    return '/media/';
};

const mediaUrl = (value) => {
    if (!value) return '';
    if (/^https?:\/\//i.test(value) || value.startsWith('/media/')) return value;
    return `${getBaseUrl()}${value.replace(/^\/+/, '')}`;
};

export { getApiBaseUrl } from './services/apiBase.js';

export const hydrateSong = (song) => {
    if (!song) return song;
    const audio_url = mediaUrl(song.audio_url);
    const cover_url = mediaUrl(song.cover_url) || '/placeholder-album.svg';

    return {
        ...song,
        audio_url,
        cover_url,
    };
};

export const isPlayableSong = (song) => Boolean(
    song
    && song.id != null
    && typeof song.audio_url === 'string'
    && song.audio_url.trim()
);

export const hydratePlayableSong = (song) => {
    const hydrated = hydrateSong(song);
    return isPlayableSong(hydrated) ? hydrated : null;
};

export const resolveCoverUrl = (raw) => {
    if (!raw || raw === '/placeholder-album.svg') return '/placeholder-album.svg';
    if (typeof raw !== 'string') return '/placeholder-album.svg';
    return mediaUrl(raw);
};

/**
 * 从歌单歌曲列表中提取最新添加/收藏的歌曲封面
 * 优先比较 addedAt 倒序；若无 addedAt 则按数组尾部向头部回溯（后加入的在末尾），自动跳过封面为空的歌曲
 */
export const resolveLatestSongCover = (songs, fallbackCover = null) => {
    if (Array.isArray(songs) && songs.length > 0) {
        const songsWithCover = songs.filter((s) => s && typeof s.cover_url === 'string' && s.cover_url.trim());
        if (songsWithCover.length > 0) {
            const latest = songsWithCover.reduce((max, curr) => {
                const currTime = Number(curr.addedAt) || 0;
                const maxTime = Number(max.addedAt) || 0;
                return currTime >= maxTime ? curr : max;
            }, songsWithCover[songsWithCover.length - 1]);
            return latest.cover_url;
        }
    }
    return fallbackCover;
};

export const formatDuration = (seconds) => {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const hydratePlaylistIndex = (playlist) => {
    if (!playlist) return playlist;
    const {
        preview_covers: rawPreviewCovers,
        ...currentPlaylist
    } = playlist;
    
    const hasCover = playlist.has_cover === 1;
    let rawCoverUrl = playlist.cover_url;

    if (!rawCoverUrl && hasCover && playlist.id) {
        rawCoverUrl = `playlists/${playlist.id}.jpg`;
    }

    let cover_url = null;
    if (rawCoverUrl && rawCoverUrl !== '/placeholder-album.svg') {
        cover_url = mediaUrl(rawCoverUrl);
    }

    let previewCovers = rawPreviewCovers || [];
    if (Array.isArray(previewCovers)) {
        previewCovers = previewCovers.map(url => {
            if (url) return mediaUrl(url);
            return url || '/placeholder-album.svg';
        });
    }

    return {
        ...currentPlaylist,
        has_cover: hasCover ? 1 : 0,
        cover_url,
        previewCovers,
    };
};

// === 歌词解析工具 ===
export function parseLyricsStr(lrcString) {
    if (!lrcString) return [];
    const lines = lrcString.split('\n');
    const rawParsed = [];
    lines.forEach(line => {
        const match = line.match(/\[(\d{2}):(\d{2}(\.\d+)?)\](.*)/);
        if (match) {
            const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
            const text = match[4].trim();
            if (text) {
                rawParsed.push({ time, text, tlyric: '' });
            }
        }
    });

    rawParsed.sort((a, b) => a.time - b.time);

    const result = [];
    let i = 0;
    while (i < rawParsed.length) {
        const current = rawParsed[i];
        
        if (i + 1 < rawParsed.length) {
            const next = rawParsed[i + 1];
            const diff = next.time - current.time;
            
            if (diff >= 0 && diff <= 0.5) {
                const hasCh1 = /[\u4e00-\u9fa5]/.test(current.text);
                const hasCh2 = /[\u4e00-\u9fa5]/.test(next.text);
                
                if (hasCh1 !== hasCh2) {
                    if (hasCh1 && !hasCh2) {
                        if (diff > 0.001 && result.length > 0) {
                            result[result.length - 1].tlyric = current.text.replace(/^[（\(【]翻译[）\)】]/, '').trim();
                            result.push(next);
                        } else {
                            next.tlyric = current.text.replace(/^[（\(【]翻译[）\)】]/, '').trim();
                            result.push(next);
                        }
                        i += 2;
                        continue;
                    } else if (!hasCh1 && hasCh2) {
                        current.tlyric = next.text.replace(/^[（\(【]翻译[）\)】]/, '').trim();
                        result.push(current);
                        i += 2;
                        continue;
                    }
                } else if (diff < 0.2) {
                    current.text += '\n' + next.text;
                    result.push(current);
                    i += 2;
                    continue;
                }
            }
        }
        result.push(current);
        i++;
    }
    
    return result;
}

export function mergeTranslations(parsedLyrics, translatedLrc) {
    if (!translatedLrc) return parsedLyrics;
    const result = parsedLyrics.map(l => ({
        ...l,
        ...(Array.isArray(l?.words) ? { words: l.words.map((word) => ({ ...word })) } : {}),
    }));
    const timeMap = new Map();
    result.forEach((item, idx) => {
        if (!Number.isFinite(item.time)) return;
        const key = Math.round(item.time * 10);
        if (!timeMap.has(key)) timeMap.set(key, idx);
    });

    const findClosest = (time) => {
        const key = Math.round(time * 10);
        if (timeMap.has(key)) return timeMap.get(key);
        for (let d = 1; d <= 3; d++) {
            if (timeMap.has(key - d)) return timeMap.get(key - d);
            if (timeMap.has(key + d)) return timeMap.get(key + d);
        }
        return -1;
    };

    const untimedIndexes = result
        .map((item, index) => (Number.isFinite(item?.time) ? -1 : index))
        .filter((index) => index >= 0);
    let untimedCursor = 0;
    const transLines = translatedLrc.split('\n');
    transLines.forEach(line => {
        const match = line.match(/\[(\d{2}):(\d{2}(\.\d+)?)\](.*)/);
        if (match) {
            const time = parseInt(match[1]) * 60 + parseFloat(match[2]);
            const text = match[4].trim();
            if (text && text !== '//') {
                const idx = findClosest(time);
                if (idx >= 0 && !result[idx].translation) {
                    result[idx].translation = text;
                }
            }
            return;
        }

        const text = line.trim();
        if (!text || text === '//' || /^\[[A-Za-z][\w-]*:/.test(text)) return;
        while (untimedCursor < untimedIndexes.length) {
            const idx = untimedIndexes[untimedCursor];
            untimedCursor += 1;
            if (!result[idx].translation) {
                result[idx].translation = text;
                break;
            }
        }
    });
    return result;
}
