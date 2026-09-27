import { querySongs } from '../tools/searchSongs.js';
import { buildSongLanguageFilter, isValidSongLanguage } from '../utils/songLanguage.js';
import { runtimeSongColumns } from '../utils/songProjection.js';

const privateSongHeaders = (headers) => ({ ...headers, 'Cache-Control': 'private, no-store' });

export async function handleGetSong(id, db, headers) {
    const song = await db.prepare(`
        SELECT ${runtimeSongColumns('s')} FROM Songs s
        WHERE s.id = ?
    `).bind(id).first();
    if (!song) {
        return new Response(JSON.stringify({ code: 404, message: 'Song not found' }), { headers: privateSongHeaders(headers), status: 404 });
    }
    return new Response(JSON.stringify({ code: 200, data: song }), { headers: privateSongHeaders(headers) });
}

export async function handleGetSongsByLanguage(url, db, headers) {
    let language = '';
    let page = 1;
    let limit = 30;
    let sort = 'desc';

    const searchParams = url.searchParams;
    language = searchParams.get('language') || '';
    const parsedPage = parseInt(searchParams.get('page') || '1', 10);
    if (!Number.isNaN(parsedPage) && parsedPage >= 1) page = parsedPage;
    const parsedLimit = parseInt(searchParams.get('limit') || '30', 10);
    if (!Number.isNaN(parsedLimit) && parsedLimit >= 1) limit = Math.min(parsedLimit, 50);
    const parsedSort = (searchParams.get('sort') || '').toLowerCase();
    if (parsedSort === 'asc' || parsedSort === 'desc') sort = parsedSort;

    if (!isValidSongLanguage(language)) {
        return new Response(JSON.stringify({ code: 400, message: 'invalid_language' }), { headers, status: 400 });
    }
    try {
        const langFilter = buildSongLanguageFilter(language, 's.language');
        const countRes = await db.prepare(`
            SELECT COUNT(*) as total FROM Songs s
            WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
              AND ${langFilter.sql}
        `).bind(...langFilter.bindings).all();
        const total = Number(countRes?.results?.[0]?.total) || 0;

        const offset = (page - 1) * limit;
        const sortDirection = sort === 'asc' ? 'ASC' : 'DESC';
        const result = await db.prepare(`
            SELECT ${runtimeSongColumns('s')}, s.created_at FROM Songs s
            WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
              AND ${langFilter.sql}
            ORDER BY CASE WHEN s.created_at IS NOT NULL THEN 0 ELSE 1 END, s.created_at ${sortDirection}, s.id ${sortDirection}
            LIMIT ? OFFSET ?
        `).bind(...langFilter.bindings, limit, offset).all();

        const songs = result?.results || [];
        const hasMore = offset + songs.length < total;

        return new Response(JSON.stringify({
            code: 200,
            data: {
                language,
                songs,
                total,
                page,
                pageSize: limit,
                hasMore,
                sort,
            },
        }), {
            headers: privateSongHeaders(headers),
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ code: 500, message: 'get_songs_by_language_failed' }), { headers, status: 500 });
    }
}

export async function handleGetSongLanguageCounts(db, headers) {
    try {
        const result = await db.prepare(`
            SELECT s.language, COUNT(*) as count FROM Songs s
            WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
            GROUP BY s.language
        `).all();
        const map = {};
        for (const row of result.results || []) {
            if (row.language) map[row.language] = row.count;
        }
        return new Response(JSON.stringify({ code: 200, data: map }), {
            headers: privateSongHeaders(headers),
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ code: 500, message: 'get_language_counts_failed' }), { headers, status: 500 });
    }
}

export async function handleSearchSongs(url, db, headers) {
    const query = (url.searchParams.get('q') || '').trim();
    const language = (url.searchParams.get('language') || '').trim();
    const rawLimit = url.searchParams.get('limit');
    const rawOffset = url.searchParams.get('offset');
    if (language && !isValidSongLanguage(language)) {
        return new Response(JSON.stringify({ code: 400, message: 'invalid_language' }), { headers, status: 400 });
    }
    if (!query) {
        return new Response(JSON.stringify({ code: 200, data: { songs: [], query: '' } }), {
            headers: privateSongHeaders(headers),
            status: 200,
        });
    }
    try {
        const songs = await querySongs(
            db,
            query,
            rawLimit === null ? undefined : Number(rawLimit),
            rawOffset === null ? 0 : Math.max(Number(rawOffset) || 0, 0),
            { language: language || null },
        );
        return new Response(JSON.stringify({ code: 200, data: { songs, query } }), {
            headers: privateSongHeaders(headers),
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ code: 500, message: 'search_failed' }), {
            headers,
            status: 500,
        });
    }
}

const RANDOM_SONGS_LIMIT = 10;
const RANDOM_EXCLUDE_ID_MAX_LENGTH = 80;
const RANDOM_EXCLUDE_QUERY_MAX_LENGTH = 1000;
const RANDOM_ROAM_SEEN_IDS_LIMIT = 5000;

export const parseRandomLimit = (url) => {
    const raw = url?.searchParams?.get('limit');
    if (!raw) return RANDOM_SONGS_LIMIT;
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return RANDOM_SONGS_LIMIT;
    return Math.min(parsed, 50);
};

export const parseRandomExcludeIds = (url, limit = RANDOM_SONGS_LIMIT) => {
    const raw = url?.searchParams?.get('exclude');
    if (!raw) return [];
    const ids = [];
    const seen = new Set();
    for (const value of raw.slice(0, RANDOM_EXCLUDE_QUERY_MAX_LENGTH).split(',')) {
        const id = value.trim().slice(0, RANDOM_EXCLUDE_ID_MAX_LENGTH);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length === limit) break;
    }
    return ids;
};

export async function handleRandomSongs(url, db, headers) {
    try {
        const limit = parseRandomLimit(url);
        const excludeIds = parseRandomExcludeIds(url, limit);
        const excludePlaceholders = excludeIds.map(() => '?').join(',');
        const diversityOrder = excludeIds.length > 0
            ? `CASE WHEN s.id IN (${excludePlaceholders}) THEN 1 ELSE 0 END, `
            : '';
        const res = await db.prepare(`
            SELECT ${runtimeSongColumns('s')} FROM Songs s
            WHERE s.audio_url IS NOT NULL AND s.audio_url != ''
            ORDER BY ${diversityOrder}RANDOM()
            LIMIT ?
        `).bind(...excludeIds, limit).all();
        return new Response(JSON.stringify({ code: 200, data: { songs: res.results || [] } }), {
            headers: privateSongHeaders(headers),
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ code: 500, message: 'random_failed' }), {
            headers,
            status: 500,
        });
    }
}

export const parseSpotlightExcludeArtists = (url, limit = 20) => {
    const raw = url?.searchParams?.get('exclude');
    if (!raw) return [];
    const artists = [];
    const seen = new Set();
    for (const value of raw.slice(0, 1000).split(',')) {
        const name = value.trim().slice(0, 100);
        if (!name) continue;
        const lower = name.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        artists.push(name);
        if (artists.length === limit) break;
    }
    return artists;
};

export async function handleSpotlightArtist(url, db, headers) {
    try {
        const excludeArtists = parseSpotlightExcludeArtists(url);
        const hasExclude = excludeArtists.length > 0;
        const excludePlaceholders = excludeArtists.map(() => '?').join(',');
        const excludeSql = hasExclude ? `AND s.artist NOT IN (${excludePlaceholders})` : '';

        // 优先随机挑选曲目 >= 2 的重点歌手，若全被排除或不足则从全部歌手随机挑选
        let chosenRow = null;
        if (hasExclude) {
            const queryWithExclude = `
                SELECT s.artist, COUNT(*) as song_count
                FROM Songs s
                WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
                  AND s.artist NOT IN ('纯音乐', '未知歌手', '群星', '')
                  AND s.artist NOT LIKE '%纯音乐%'
                  AND s.artist NOT LIKE '%未知%'
                  ${excludeSql}
                GROUP BY s.artist
                ORDER BY CASE WHEN COUNT(*) >= 2 THEN 0 ELSE 1 END, RANDOM()
                LIMIT 1
            `;
            const res = await db.prepare(queryWithExclude).bind(...excludeArtists).first();
            if (res?.artist) chosenRow = res;
        }

        // 若排除后无结果（例如所有歌手都在 exclude 中），重试不带 exclude 的查询
        if (!chosenRow) {
            const fallbackQuery = `
                SELECT s.artist, COUNT(*) as song_count
                FROM Songs s
                WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
                  AND s.artist NOT IN ('纯音乐', '未知歌手', '群星', '')
                  AND s.artist NOT LIKE '%纯音乐%'
                  AND s.artist NOT LIKE '%未知%'
                GROUP BY s.artist
                ORDER BY CASE WHEN COUNT(*) >= 2 THEN 0 ELSE 1 END, RANDOM()
                LIMIT 1
            `;
            chosenRow = await db.prepare(fallbackQuery).first();
        }

        if (!chosenRow?.artist) {
            return new Response(JSON.stringify({ code: 200, data: null }), {
                headers: privateSongHeaders(headers),
                status: 200,
            });
        }

        const artistName = chosenRow.artist;
        const songCount = Number(chosenRow.song_count) || 0;

        // 查询该歌手在登录后完整曲库中的全部歌曲
        const songsResult = await db.prepare(`
            SELECT ${runtimeSongColumns('s')}
            FROM Songs s
            WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
              AND s.artist = ?
            ORDER BY s.id ASC
        `).bind(artistName).all();

        const songs = songsResult?.results || [];

        // 尝试从 Artist_Photos 查询已缓存的真实写真
        let photoUrl = '';
        try {
            const photoRow = await db.prepare(`
                SELECT photo_url, photos
                FROM Artist_Photos
                WHERE artist_name = ?
                LIMIT 1
            `).bind(artistName).first();
            if (photoRow?.photo_url) {
                photoUrl = photoRow.photo_url;
            } else if (photoRow?.photos) {
                const parsed = JSON.parse(photoRow.photos);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.url) {
                    photoUrl = parsed[0].url;
                }
            }
        } catch {
            // Artist_Photos 查询异常不影响主体返回
        }

        const coverUrl = songs.find((s) => s.cover_url)?.cover_url || '';

        return new Response(JSON.stringify({
            code: 200,
            data: {
                artist: artistName,
                songCount,
                songs,
                photoUrl,
                coverUrl,
            },
        }), {
            headers: privateSongHeaders(headers),
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ code: 500, message: 'spotlight_artist_failed' }), {
            headers,
            status: 500,
        });
    }
}

export const normalizeRandomRoamSeenIds = (values) => {
    if (!Array.isArray(values)) return null;
    const ids = [];
    const seen = new Set();
    for (const value of values.slice(0, RANDOM_ROAM_SEEN_IDS_LIMIT)) {
        if (typeof value !== 'string') continue;
        const id = value.trim();
        if (!id || id.length > RANDOM_EXCLUDE_ID_MAX_LENGTH || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
};

export const parseRoamBatchLimit = (value) => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
        return Math.min(value, 50);
    }
    if (typeof value === 'string') {
        const parsed = parseInt(value.trim(), 10);
        if (!Number.isNaN(parsed) && parsed >= 1) {
            return Math.min(parsed, 50);
        }
    }
    return RANDOM_SONGS_LIMIT;
};

export async function handleRandomRoam(request, db, headers) {
    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ code: 400, message: 'Invalid JSON body' }), {
            headers: privateSongHeaders(headers),
            status: 400,
        });
    }

    const seenSongIds = normalizeRandomRoamSeenIds(body?.seenSongIds);
    if (!seenSongIds) {
        return new Response(JSON.stringify({ code: 400, message: 'seenSongIds must be an array' }), {
            headers: privateSongHeaders(headers),
            status: 400,
        });
    }

    const roamLimit = parseRoamBatchLimit(body?.limit ?? body?.batchSize);

    const rawLanguage = body?.language;
    const language = typeof rawLanguage === 'string' && rawLanguage.trim() !== '' && rawLanguage.trim() !== 'all'
        ? rawLanguage.trim()
        : null;

    const langFilter = language ? buildSongLanguageFilter(language, 's.language') : null;
    if (language && !langFilter) {
        return new Response(JSON.stringify({ code: 400, message: 'invalid_language' }), {
            headers: privateSongHeaders(headers),
            status: 400,
        });
    }

    try {
        // 当前曲库规模很小；一次读取随机排列的可播放候选，可避开 SQLite/D1
        // 绑定参数数量上限，同时让 totalPlayable 与实际候选过滤严格一致。
        const whereLanguage = langFilter ? `AND ${langFilter.sql}` : '';
        const query = `
            SELECT ${runtimeSongColumns('s')} FROM Songs s
            WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
              ${whereLanguage}
            ORDER BY RANDOM()
        `;
        const stmt = db.prepare(query);
        const result = langFilter ? await stmt.bind(...langFilter.bindings).all() : await stmt.all();
        const playableSongs = result.results || [];
        const seen = new Set(seenSongIds);
        const unseenSongs = playableSongs.filter((song) => !seen.has(String(song.id)));
        const songs = unseenSongs.slice(0, roamLimit);
        const remainingPlayable = Math.max(0, unseenSongs.length - songs.length);

        return new Response(JSON.stringify({
            code: 200,
            data: {
                songs,
                language: language || 'all',
                limit: roamLimit,
                totalPlayable: playableSongs.length,
                seenPlayable: playableSongs.length - unseenSongs.length,
                remainingPlayable,
                exhausted: remainingPlayable === 0,
            },
        }), {
            headers: privateSongHeaders(headers),
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ code: 500, message: 'random_roam_failed' }), {
            headers: privateSongHeaders(headers),
            status: 500,
        });
    }
}

const MAX_RESOLVE_SONG_IDS = 500;
const RESOLVE_QUERY_CHUNK_SIZE = 100;

const normalizeResolveSongIds = (values) => {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const ids = [];
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const id = value.trim().slice(0, 80);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length > MAX_RESOLVE_SONG_IDS) break;
    }
    return ids;
};

export async function handleResolveSongs(request, db, headers) {
    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ code: 400, message: 'Invalid JSON body' }), { headers, status: 400 });
    }

    const rawIds = body?.song_ids;
    if (!Array.isArray(rawIds)) {
        return new Response(JSON.stringify({ code: 400, message: 'song_ids must be an array' }), { headers, status: 400 });
    }
    const songIds = normalizeResolveSongIds(rawIds);
    if (songIds.length === 0 || songIds.length > MAX_RESOLVE_SONG_IDS) {
        return new Response(JSON.stringify({
            code: 400,
            message: `song_ids must contain 1-${MAX_RESOLVE_SONG_IDS} unique ids`,
        }), { headers, status: 400 });
    }

    const songsById = new Map();
    for (let offset = 0; offset < songIds.length; offset += RESOLVE_QUERY_CHUNK_SIZE) {
        const chunk = songIds.slice(offset, offset + RESOLVE_QUERY_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await db.prepare(`
            SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
            FROM Songs s
            WHERE s.id IN (${placeholders})
              AND s.audio_url IS NOT NULL
              AND TRIM(s.audio_url) <> ''
        `).bind(...chunk).all();
        for (const song of rows.results || []) songsById.set(song.id, song);
    }

    const songs = songIds.map((id) => songsById.get(id)).filter(Boolean);
    const missingIds = songIds.filter((id) => !songsById.has(id));
    return new Response(JSON.stringify({
        code: 200,
        data: { songs, missing_ids: missingIds },
    }), {
        headers: privateSongHeaders(headers),
    });
}
