import { isValidSongLanguage } from '../utils/songLanguage.js';
import {
    MAX_BATCH_SONGS,
    METADATA_FIELDS,
    SONG_FIELDS,
    TEXT_FIELDS,
    WRITE_CHUNK_SIZE,
    badRequest,
    chunk,
    hasOwn,
    isObject,
    json,
    placeholders,
    readJsonObject,
} from '../utils/adminMusicContracts.js';

const SEMANTIC_SCAN_PAGE_SIZE = 1000;
const SEMANTIC_SCAN_MAX_PAGES = 40;

function validateSong(raw, index, { partial = false } = {}) {
    if (!isObject(raw)) return { error: `songs[${index}] must be an object` };
    const allowed = partial ? ['id', ...METADATA_FIELDS] : SONG_FIELDS;
    const unknown = Object.keys(raw).filter((field) => !allowed.includes(field));
    if (unknown.length > 0) return { error: `songs[${index}] contains unknown fields`, fields: unknown };
    if (!partial && (!hasOwn(raw, 'id') || !hasOwn(raw, 'title') || !hasOwn(raw, 'language'))) {
        return { error: `songs[${index}] requires id, title and language` };
    }

    const value = {};
    if (hasOwn(raw, 'id')) {
        if (typeof raw.id !== 'string' || !raw.id || raw.id !== raw.id.trim() || raw.id.length > 128 || raw.id.includes('/')) {
            return { error: `songs[${index}].id must be a non-empty path-safe string of at most 128 characters` };
        }
        value.id = raw.id;
    }
    if (hasOwn(raw, 'title')) {
        if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 500) {
            return { error: `songs[${index}].title must be a non-empty string of at most 500 characters` };
        }
        value.title = raw.title;
    }
    for (const field of TEXT_FIELDS) {
        if (!hasOwn(raw, field)) continue;
        if (raw[field] !== null && (typeof raw[field] !== 'string' || raw[field].length > 2000)) {
            return { error: `songs[${index}].${field} must be null or a string of at most 2000 characters` };
        }
        value[field] = raw[field];
    }
    if (hasOwn(raw, 'language')) {
        if (!isValidSongLanguage(raw.language)) {
            return { error: `songs[${index}].language must be a supported language code` };
        }
        value.language = raw.language;
    }
    if (hasOwn(raw, 'duration')) {
        if (raw.duration !== null && (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || raw.duration < 0)) {
            return { error: `songs[${index}].duration must be null or a non-negative finite number` };
        }
        value.duration = raw.duration;
    }
    if (partial) return { value };
    return {
        value: {
            id: value.id,
            title: value.title,
            artist: hasOwn(value, 'artist') ? value.artist : null,
            album: hasOwn(value, 'album') ? value.album : null,
            duration: hasOwn(value, 'duration') ? value.duration : null,
            audio_url: hasOwn(value, 'audio_url') ? value.audio_url : null,
            cover_url: hasOwn(value, 'cover_url') ? value.cover_url : null,
            language: value.language,
        },
    };
}

function validateSongs(rawSongs, headers) {
    if (!Array.isArray(rawSongs) || rawSongs.length < 1 || rawSongs.length > MAX_BATCH_SONGS) {
        return { response: badRequest(`songs must contain 1..${MAX_BATCH_SONGS} items`, headers) };
    }
    const songs = [];
    for (let index = 0; index < rawSongs.length; index += 1) {
        const result = validateSong(rawSongs[index], index);
        if (result.error) return { response: badRequest(result.error, headers, result.fields ? { fields: result.fields } : undefined) };
        songs.push(result.value);
    }
    return { songs };
}

async function readSongsRequest(request, headers) {
    const parsed = await readJsonObject(request, ['songs'], ['songs'], headers);
    if (parsed.response) return parsed;
    return validateSongs(parsed.body.songs, headers);
}

export async function querySongsByIds(db, ids) {
    if (ids.length === 0) return [];
    const result = await db.prepare(`
        SELECT id, title, artist, album, duration, audio_url, cover_url, language, created_at
        FROM Songs WHERE id IN (${placeholders(ids.length)})
    `).bind(...ids).all();
    return result.results || [];
}

const normalizeIdentity = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const identityKey = (song) => `${normalizeIdentity(song.title)}\u0000${normalizeIdentity(song.artist)}`;

async function querySemanticCandidates(db, songs) {
    const identities = new Set(songs.map(identityKey));
    if (identities.size === 0) return [];
    const candidates = [];
    for (let page = 0; page < SEMANTIC_SCAN_MAX_PAGES; page += 1) {
        const result = await db.prepare(`
            SELECT id, title, artist FROM Songs
            ORDER BY id LIMIT ? OFFSET ?
        `).bind(SEMANTIC_SCAN_PAGE_SIZE, page * SEMANTIC_SCAN_PAGE_SIZE).all();
        const rows = result.results || [];
        for (const row of rows) {
            if (identities.has(identityKey(row))) candidates.push(row);
        }
        if (rows.length < SEMANTIC_SCAN_PAGE_SIZE) return candidates;
    }
    throw new Error(`Song library exceeds the ${SEMANTIC_SCAN_PAGE_SIZE * SEMANTIC_SCAN_MAX_PAGES} row admin preview limit`);
}

function fieldDiffs(incoming, current) {
    if (!current) return [];
    const diffs = [];
    for (const field of METADATA_FIELDS) {
        const incomingValue = incoming[field] ?? null;
        const currentValue = current[field] ?? null;
        if (incomingValue !== currentValue) diffs.push({ field, current: currentValue, incoming: incomingValue });
    }
    return diffs;
}

async function computePreview(songs, db) {
    const idCounts = new Map();
    for (const song of songs) idCounts.set(song.id, (idCounts.get(song.id) || 0) + 1);
    const duplicateIds = [...idCounts].filter(([, count]) => count > 1).map(([id]) => id);
    const [existingRows, candidateRows] = await Promise.all([
        querySongsByIds(db, [...idCounts.keys()]),
        querySemanticCandidates(db, songs),
    ]);
    const existingById = new Map(existingRows.map((song) => [song.id, song]));
    const libraryByIdentity = new Map();
    for (const row of candidateRows) {
        const key = identityKey(row);
        const values = libraryByIdentity.get(key) || [];
        values.push(row);
        libraryByIdentity.set(key, values);
    }
    const batchByIdentity = new Map();
    songs.forEach((song, index) => {
        const key = identityKey(song);
        const values = batchByIdentity.get(key) || [];
        values.push({ index, id: song.id });
        batchByIdentity.set(key, values);
    });

    const results = songs.map((song, index) => {
        const existing = existingById.get(song.id) || null;
        const diffs = fieldDiffs(song, existing);
        const sameIdentityCandidates = [
            ...(libraryByIdentity.get(identityKey(song)) || [])
                .filter((candidate) => candidate.id !== song.id)
                .map((candidate) => ({ source: 'library', id: candidate.id, title: candidate.title, artist: candidate.artist })),
            ...(batchByIdentity.get(identityKey(song)) || [])
                .filter((candidate) => candidate.index !== index && candidate.id !== song.id)
                .map((candidate) => ({ source: 'batch', index: candidate.index, id: candidate.id, title: song.title, artist: song.artist })),
        ];
        const duplicateId = idCounts.get(song.id) > 1;
        let action = existing ? (diffs.length > 0 ? 'update' : 'noop') : 'create';
        if (duplicateId || sameIdentityCandidates.length > 0) action = 'conflict';
        return {
            index,
            id: song.id,
            action,
            duplicate_id: duplicateId,
            duplicate_ids: duplicateId ? [song.id] : [],
            same_title_artist_candidates: sameIdentityCandidates,
            diffs,
            existing,
        };
    });
    return { duplicateIds, results };
}

export async function handlePreview(request, db, headers) {
    const parsed = await readSongsRequest(request, headers);
    if (parsed.response) return parsed.response;
    const preview = await computePreview(parsed.songs, db);
    return json({ code: 200, data: { duplicate_ids: preview.duplicateIds, results: preview.results } }, 200, headers);
}

function buildUpsertStatement(db, songs) {
    const values = songs.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, CAST(strftime('%s', 'now') AS INTEGER) * 1000)`).join(', ');
    const sql = `
        INSERT INTO Songs (
            id, title, artist, album, duration, audio_url, cover_url,
            language, created_at
        ) VALUES ${values}
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            duration = excluded.duration,
            audio_url = excluded.audio_url,
            cover_url = excluded.cover_url,
            language = excluded.language
    `;
    return db.prepare(sql).bind(...songs.flatMap((song) => SONG_FIELDS.map((field) => song[field])));
}

export async function handleBatch(request, db, headers) {
    const parsed = await readJsonObject(request, ['songs', 'force_ids', 'duplicate_ids'], ['songs'], headers);
    if (parsed.response) return parsed.response;
    const validated = validateSongs(parsed.body.songs, headers);
    if (validated.response) return validated.response;
    const songs = validated.songs;
    const songIds = new Set(songs.map((song) => song.id));
    const confirmations = {};
    for (const field of ['force_ids', 'duplicate_ids']) {
        const rawIds = parsed.body[field] ?? [];
        if (!Array.isArray(rawIds)) return badRequest(`${field} must be an array`, headers);
        const seen = new Set();
        for (let index = 0; index < rawIds.length; index += 1) {
            const id = rawIds[index];
            if (typeof id !== 'string' || !songIds.has(id)) return badRequest(`${field}[${index}] must identify a member of songs`, headers);
            if (seen.has(id)) return badRequest(`${field} contains duplicate id: ${id}`, headers);
            seen.add(id);
        }
        confirmations[field] = seen;
    }

    // This is intentionally recomputed in the write request. A prior preview is advisory only.
    const preview = await computePreview(songs, db);
    const changedIds = preview.results
        .filter((item) => item.existing && item.diffs.length > 0 && !confirmations.force_ids.has(item.id))
        .map((item) => item.id);
    const semanticDuplicateIds = preview.results
        .filter((item) => item.same_title_artist_candidates.length > 0 && !confirmations.duplicate_ids.has(item.id))
        .map((item) => item.id);
    if (preview.duplicateIds.length > 0 || changedIds.length > 0 || semanticDuplicateIds.length > 0) {
        return json({
            code: 409,
            message: 'Batch confirmation required',
            data: {
                duplicate_ids: preview.duplicateIds,
                changed_ids: changedIds,
                semantic_duplicate_ids: semanticDuplicateIds,
                results: preview.results,
            },
        }, 409, headers);
    }

    const previewById = new Map(preview.results.map((item) => [item.id, item]));
    const songsToWrite = songs.filter((song) => {
        const item = previewById.get(song.id);
        return !item.existing || item.diffs.length > 0 || confirmations.force_ids.has(song.id);
    });
    if (songsToWrite.length > 0) {
        const statements = chunk(songsToWrite, WRITE_CHUNK_SIZE).map((items) => buildUpsertStatement(db, items));
        await db.batch(statements);
    }
    const rowsById = new Map((await querySongsByIds(db, songs.map((song) => song.id))).map((row) => [row.id, row]));
    const rows = songs.map((song) => rowsById.get(song.id)).filter(Boolean);
    const writtenIds = new Set(songsToWrite.map((song) => song.id));
    const results = songs.map((song, index) => ({
        index,
        id: song.id,
        status: rowsById.has(song.id) ? (writtenIds.has(song.id) ? 'upserted' : 'noop') : 'missing',
        row: rowsById.get(song.id) || null,
    }));
    return json({ code: 200, data: { rows, results } }, 200, headers);
}

export async function handleEditSong(id, request, db, headers) {
    const parsed = await readJsonObject(request, ['id', ...METADATA_FIELDS], [], headers);
    if (parsed.response) return parsed.response;
    if (hasOwn(parsed.body, 'id') && parsed.body.id !== id) return badRequest('Body id must match path id', headers);
    const validated = validateSong(parsed.body, 0, { partial: true });
    if (validated.error) return badRequest(validated.error.replace('songs[0]', 'body'), headers, validated.fields ? { fields: validated.fields } : undefined);
    const updates = METADATA_FIELDS.filter((field) => hasOwn(validated.value, field));
    if (updates.length === 0) return badRequest('At least one supported metadata field is required', headers);
    const existing = await db.prepare('SELECT id FROM Songs WHERE id = ?').bind(id).first();
    if (!existing) return json({ code: 404, message: 'Song not found' }, 404, headers);
    await db.prepare(`UPDATE Songs SET ${updates.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`)
        .bind(...updates.map((field) => validated.value[field]), id).run();
    const updated = await db.prepare(`
        SELECT id, title, artist, album, duration, audio_url, cover_url, language, created_at
        FROM Songs WHERE id = ?
    `).bind(id).first();
    return json({ code: 200, data: updated }, 200, headers);
}
