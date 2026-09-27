import {
    MAX_BATCH_SONGS,
    MAX_MEDIA_DELETE_PATHS,
    badRequest,
    impactDigest,
    json,
    placeholders,
    readJsonObject,
} from '../utils/adminMusicContracts.js';
import { querySongsByIds } from './adminMusicSongs.js';
import {
    deleteManagedMedia,
    managedMediaPath,
    mediaObjectKey,
    mediaPrefix,
    queryMediaReferences,
    unsafeMediaClassification,
} from './adminMusicMedia.js';
import { buildLyricArtifactMarker, createLyricArtifactStore } from './lyricArtifactStore.js';
import { invalidateLyricsResolutionCache } from './lyricResolution.js';

function validateIds(rawIds) {
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_BATCH_SONGS) {
        return { error: `ids must contain 1..${MAX_BATCH_SONGS} items` };
    }
    const ids = [];
    const seen = new Set();
    for (let index = 0; index < rawIds.length; index += 1) {
        const id = rawIds[index];
        if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 128 || id.includes('/')) {
            return { error: `ids[${index}] must be a non-empty path-safe string of at most 128 characters` };
        }
        if (seen.has(id)) return { error: `ids contains duplicate id: ${id}` };
        seen.add(id);
        ids.push(id);
    }
    return { ids };
}

async function readIdsRequest(request, headers, execute) {
    const fields = execute ? ['ids', 'delete_media', 'impact_digest'] : ['ids'];
    const parsed = await readJsonObject(request, fields, fields, headers);
    if (parsed.response) return parsed;
    if (execute && typeof parsed.body.delete_media !== 'boolean') return { response: badRequest('delete_media must be a boolean', headers) };
    if (execute && (typeof parsed.body.impact_digest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.body.impact_digest))) {
        return { response: badRequest('impact_digest must be a lowercase SHA-256 digest', headers) };
    }
    const idsResult = validateIds(parsed.body.ids);
    if (idsResult.error) return { response: badRequest(idsResult.error, headers) };
    return { ids: idsResult.ids, deleteMedia: parsed.body.delete_media, impactDigest: parsed.body.impact_digest };
}

export async function handleMediaDelete(request, db, env, headers) {
    const parsed = await readJsonObject(request, ['paths'], ['paths'], headers);
    if (parsed.response) return parsed.response;
    if (!Array.isArray(parsed.body.paths) || parsed.body.paths.length < 1 || parsed.body.paths.length > MAX_MEDIA_DELETE_PATHS) {
        return badRequest(`paths must contain 1..${MAX_MEDIA_DELETE_PATHS} items`, headers);
    }
    const prefix = mediaPrefix(env);
    if (!prefix) return json({ code: 500, message: 'MEDIA_PREFIX is invalid' }, 500, headers);
    if (!env.MEDIA_BUCKET) return json({ code: 503, message: 'MEDIA_BUCKET is not bound' }, 503, headers);
    const mediaResult = await deleteManagedMedia(parsed.body.paths, db, env, { prefix });
    const status = mediaResult.failures.length > 0 ? 207 : 200;
    return json({ code: status, data: mediaResult }, status, headers);
}

async function readDeleteImpact(db, ids, prefix) {
    const songsFound = await querySongsByIds(db, ids);
    const songsById = new Map(songsFound.map((song) => [song.id, song]));
    const songs = ids.map((id) => songsById.get(id)).filter(Boolean);
    const missingIds = ids.filter((id) => !songsById.has(id));
    if (songs.length === 0) {
        return {
            songs,
            missingIds,
            affectedPlaylists: [],
            playlistRelations: [],
            lyricTranslations: [],
            media: [],
        };
    }
    const foundIds = songs.map((song) => song.id);
    const marker = placeholders(foundIds.length);
    const [relationResult, translationResult] = await Promise.all([
        db.prepare(`
            SELECT ps.playlist_id, ps.song_id, ps.sort_order, p.name, p.kind AS type, p.account_id
            FROM Member_Playlist_Songs ps
            JOIN Member_Playlists p ON p.id = ps.playlist_id
            WHERE ps.song_id IN (${marker})
            ORDER BY ps.playlist_id, ps.sort_order
        `).bind(...foundIds).all(),
        db.prepare(`
            SELECT song_id, COUNT(*) AS count FROM Lyric_Translations
            WHERE song_id IN (${marker}) GROUP BY song_id ORDER BY song_id
        `).bind(...foundIds).all(),
    ]);
    const playlistRelations = relationResult.results || [];
    const playlistMap = new Map();
    for (const relation of playlistRelations) {
        if (!playlistMap.has(relation.playlist_id)) {
            playlistMap.set(relation.playlist_id, { id: relation.playlist_id, name: relation.name ?? null, type: relation.type ?? null, account_id: relation.account_id });
        }
    }
    const safePaths = [...new Set(songs.flatMap((song) => [
        managedMediaPath(song.audio_url, 'audio') ? song.audio_url : null,
        managedMediaPath(song.cover_url, 'cover') ? song.cover_url : null,
    ]).filter(Boolean))];
    const references = await queryMediaReferences(db, safePaths);
    const deletingIds = new Set(foundIds);
    const media = [];
    for (const song of songs) {
        for (const [field, kind] of [['audio_url', 'audio'], ['cover_url', 'cover']]) {
            const path = song[field];
            if (!managedMediaPath(path, kind)) {
                media.push({ song_id: song.id, field, path: path || null, classification: unsafeMediaClassification(path), shared: false, can_delete: false });
                continue;
            }
            const remainingReferences = (references.get(path) || []).filter((reference) => !deletingIds.has(reference.id));
            const shared = remainingReferences.length > 0;
            media.push({
                song_id: song.id,
                field,
                path,
                object_key: mediaObjectKey(prefix, path),
                classification: shared ? 'managed_shared' : 'managed_unique',
                shared,
                can_delete: !shared,
                remaining_reference_ids: [...new Set(remainingReferences.map((reference) => reference.id))].sort(),
            });
        }
    }
    return {
        songs,
        missingIds,
        affectedPlaylists: [...playlistMap.values()],
        playlistRelations,
        lyricTranslations: translationResult.results || [],
        media,
    };
}

function deleteImpactPayload(impact) {
    return {
        songs: impact.songs,
        missing_ids: impact.missingIds,
        affected_playlists: impact.affectedPlaylists,
        playlist_relations: impact.playlistRelations,
        lyric_translations: impact.lyricTranslations,
        media: impact.media,
    };
}

export async function handleDeletePreview(request, db, env, headers) {
    const parsed = await readIdsRequest(request, headers, false);
    if (parsed.response) return parsed.response;
    const prefix = mediaPrefix(env);
    if (!prefix) return json({ code: 500, message: 'MEDIA_PREFIX is invalid' }, 500, headers);
    const impact = await readDeleteImpact(db, parsed.ids, prefix);
    const payload = deleteImpactPayload(impact);
    return json({ code: 200, data: { ...payload, impact_digest: await impactDigest(payload) } }, 200, headers);
}

const LYRIC_MARKER_CAS_ATTEMPTS = 5;

async function prepareLyricDeletion(store, songId, operationId) {
    for (let attempt = 0; attempt < LYRIC_MARKER_CAS_ATTEMPTS; attempt += 1) {
        const current = await store.get(songId);
        if (current.state === 'found' && current.artifact.status === 'deleting') {
            return { state: 'busy' };
        }
        const marker = buildLyricArtifactMarker(songId, 'deleting', {
            now: Date.now(),
            operationId,
        });
        const written = current.state === 'missing'
            ? await store.createIfAbsent(songId, marker)
            : await store.putIfMatch(songId, marker, current.etag);
        if (written.state === 'created' || written.state === 'updated') {
            return {
                state: 'prepared',
                songId,
                operationId,
                markerEtag: written.etag,
                previous: current,
            };
        }
    }
    return { state: 'conflict' };
}

async function compensateLyricDeletion(store, prepared) {
    try {
        const current = await store.get(prepared.songId);
        if (current.state !== 'found'
            || current.artifact.status !== 'deleting'
            || current.artifact.operationId !== prepared.operationId
            || current.etag !== prepared.markerEtag) {
            return false;
        }
        if (prepared.previous.state === 'missing') {
            await store.delete(prepared.songId);
            return true;
        }
        if (prepared.previous.state === 'legacy') {
            const restoredLegacy = await store.restoreLegacyIfMatch(
                prepared.songId,
                prepared.previous.legacyText,
                current.etag,
            );
            return restoredLegacy.state === 'updated';
        }
        const restored = await store.putIfMatch(
            prepared.songId,
            prepared.previous.artifact,
            current.etag,
        );
        return restored.state === 'updated';
    } catch {
        return false;
    }
}

async function compensateLyricDeletions(store, preparedItems) {
    const failedSongIds = [];
    for (const prepared of [...preparedItems].reverse()) {
        if (!await compensateLyricDeletion(store, prepared)) failedSongIds.push(prepared.songId);
    }
    return failedSongIds;
}

async function finalizeLyricDeletion(store, prepared) {
    const current = await store.get(prepared.songId);
    if (current.state === 'missing') return { state: 'deleted' };
    if (current.state !== 'found'
        || current.artifact.status !== 'deleting'
        || current.artifact.operationId !== prepared.operationId
        || current.etag !== prepared.markerEtag) {
        throw new Error('Lyric deletion marker changed before final cleanup');
    }
    await store.delete(prepared.songId);
    return { state: 'deleted' };
}

export async function cleanupDeletedSongLyricMarker(env, songId) {
    const store = createLyricArtifactStore(env);
    const current = await store.get(songId);
    if (current.state === 'missing') return { state: 'missing', songId };
    if (current.state !== 'found' || current.artifact.status !== 'deleting') {
        return { state: 'not_deleting', songId };
    }
    await store.delete(songId);
    return { state: 'deleted', songId };
}

export async function deleteSongWithLyricLifecycle(env, songId, deleteSong) {
    if (typeof deleteSong !== 'function') throw new TypeError('deleteSong must be a function');
    const store = createLyricArtifactStore(env);
    const operationId = globalThis.crypto.randomUUID();
    const prepared = await prepareLyricDeletion(store, songId, operationId);
    if (prepared.state !== 'prepared') throw new Error('Lyric artifact deletion is already in progress');
    try {
        await deleteSong();
    } catch (error) {
        await compensateLyricDeletion(store, prepared);
        throw error;
    }
    await finalizeLyricDeletion(store, prepared);
    return { state: 'deleted', songId };
}

export async function handleDelete(request, db, env, headers) {
    const parsed = await readIdsRequest(request, headers, true);
    if (parsed.response) return parsed.response;
    const prefix = mediaPrefix(env);
    if (!prefix) return json({ code: 500, message: 'MEDIA_PREFIX is invalid' }, 500, headers);
    const impact = await readDeleteImpact(db, parsed.ids, prefix);
    const impactPayload = deleteImpactPayload(impact);
    const currentImpactDigest = await impactDigest(impactPayload);
    if (currentImpactDigest !== parsed.impactDigest) {
        return json({
            code: 409,
            message: 'Deletion impact changed after preview',
            data: { ...impactPayload, impact_digest: currentImpactDigest },
        }, 409, headers);
    }
    const foundIds = impact.songs.map((song) => song.id);
    const deleteTargets = new Map();
    for (const item of impact.media) {
        if (item.can_delete && item.path && !deleteTargets.has(item.path)) deleteTargets.set(item.path, item);
    }
    if (!env.MEDIA_BUCKET) {
        return json({ code: 503, message: 'MEDIA_BUCKET is not bound', data: deleteImpactPayload(impact) }, 503, headers);
    }

    const lyricStore = createLyricArtifactStore(env);
    const recoveredLyricMarkerIds = [];
    for (const songId of impact.missingIds) {
        try {
            const cleanup = await cleanupDeletedSongLyricMarker(env, songId);
            if (cleanup.state === 'deleted') recoveredLyricMarkerIds.push(songId);
        } catch {
            return json({
                code: 503,
                message: 'Deleted song lyric marker cleanup failed; retry with a fresh preview',
                data: {
                    ...deleteImpactPayload(impact),
                    lyric_cleanup: {
                        recovered_song_ids: recoveredLyricMarkerIds,
                        pending_song_ids: [songId],
                        retryable: true,
                    },
                },
            }, 503, headers);
        }
    }

    const pendingLyricMarkerIds = [];
    if (foundIds.length > 0) {
        const operationId = globalThis.crypto.randomUUID();
        const preparedLyrics = [];
        for (const songId of foundIds) {
            try {
                const prepared = await prepareLyricDeletion(lyricStore, songId, operationId);
                if (prepared.state !== 'prepared') {
                    const compensationFailedSongIds = await compensateLyricDeletions(lyricStore, preparedLyrics);
                    return json({
                        code: 503,
                        message: 'Lyric artifact deletion is busy; retry the song deletion',
                        data: {
                            ...deleteImpactPayload(impact),
                            lyric_cleanup: {
                                failed_song_id: songId,
                                object_key: lyricStore.key(songId),
                                retryable: true,
                                compensation_failed_song_ids: compensationFailedSongIds,
                            },
                        },
                    }, 503, headers);
                }
                preparedLyrics.push(prepared);
            } catch {
                const compensationFailedSongIds = await compensateLyricDeletions(lyricStore, preparedLyrics);
                return json({
                    code: 503,
                    message: 'Lyric artifact deletion preparation failed; retry the song deletion',
                    data: {
                        ...deleteImpactPayload(impact),
                        lyric_cleanup: {
                            failed_song_id: songId,
                            object_key: lyricStore.key(songId),
                            retryable: true,
                            compensation_failed_song_ids: compensationFailedSongIds,
                        },
                    },
                }, 503, headers);
            }
        }
        const marker = placeholders(foundIds.length);
        try {
            await db.batch([
                db.prepare(`DELETE FROM Lyric_Translations WHERE song_id IN (${marker})`).bind(...foundIds),
                db.prepare(`DELETE FROM Songs WHERE id IN (${marker})`).bind(...foundIds),
            ]);
        } catch {
            const compensationFailedSongIds = await compensateLyricDeletions(lyricStore, preparedLyrics);
            return json({
                code: 503,
                message: 'Song database deletion failed; retry the song deletion',
                data: {
                    ...deleteImpactPayload(impact),
                    lyric_cleanup: {
                        failed_song_id: null,
                        retryable: true,
                        reason: 'database_write_failed',
                        compensation_failed_song_ids: compensationFailedSongIds,
                    },
                },
            }, 503, headers);
        }
        for (const songId of foundIds) invalidateLyricsResolutionCache(songId);
        for (const prepared of preparedLyrics) {
            try {
                await finalizeLyricDeletion(lyricStore, prepared);
            } catch {
                pendingLyricMarkerIds.push(prepared.songId);
            }
        }
    }

    const mediaResult = { mode: parsed.deleteMedia ? 'delete' : 'retain', deleted: [], retained: [], skipped: [], failures: [] };
    if (!parsed.deleteMedia) {
        const retained = new Set();
        for (const item of impact.media) {
            if (item.path && !retained.has(item.path)) {
                retained.add(item.path);
                mediaResult.retained.push({ path: item.path, classification: item.classification });
            }
        }
    } else {
        for (const item of impact.media) {
            if (!item.path || item.can_delete) continue;
            mediaResult.skipped.push({ song_id: item.song_id, field: item.field, path: item.path, reason: item.classification });
        }
        if (deleteTargets.size > 0) {
            const cleanup = await deleteManagedMedia([...deleteTargets.keys()], db, env, {
                prefix,
                sharedReason: 'managed_shared_after_delete',
            });
            mediaResult.deleted.push(...cleanup.deleted);
            mediaResult.skipped.push(...cleanup.skipped);
            mediaResult.failures.push(...cleanup.failures);
        }
    }

    const status = pendingLyricMarkerIds.length > 0
        ? 503
        : (mediaResult.failures.length > 0 ? 207 : 200);
    return json({
        code: status,
        ...(pendingLyricMarkerIds.length > 0
            ? { message: 'Songs were deleted, but lyric marker cleanup is pending; retry with a fresh preview' }
            : {}),
        data: {
            deleted_ids: foundIds,
            missing_ids: impact.missingIds,
            affected_playlists: impact.affectedPlaylists,
            deleted_relations: {
                playlist_songs: impact.playlistRelations.length,
                lyric_translations: impact.lyricTranslations.reduce((total, item) => total + Number(item.count || 0), 0),
            },
            media: mediaResult,
            lyric_cleanup: {
                recovered_song_ids: recoveredLyricMarkerIds,
                pending_song_ids: pendingLyricMarkerIds,
                retryable: pendingLyricMarkerIds.length > 0,
            },
        },
    }, status, headers);
}
