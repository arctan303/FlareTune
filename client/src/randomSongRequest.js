const RANDOM_SONGS_LIMIT = 20;
const RANDOM_EXCLUDE_ID_MAX_LENGTH = 80;

export const normalizeRandomExcludeIds = (values, limit = RANDOM_SONGS_LIMIT) => {
    if (!Array.isArray(values)) return [];
    const ids = [];
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const id = value.trim().slice(0, RANDOM_EXCLUDE_ID_MAX_LENGTH);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length === limit) break;
    }
    return ids;
};

export const buildRandomSongsUrl = (apiBase = '', excludeIds = [], limit = RANDOM_SONGS_LIMIT) => {
    const cleanBase = String(apiBase || '').trim().replace(/\/$/, '');
    const path = `${cleanBase}/api/songs/random`;
    const params = new URLSearchParams();
    const normalized = normalizeRandomExcludeIds(excludeIds, limit);
    if (normalized.length > 0) params.set('exclude', normalized.join(','));
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return query ? `${path}?${query}` : path;
};
