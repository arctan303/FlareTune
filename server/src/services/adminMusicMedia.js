import {
    DEFAULT_MEDIA_PREFIX,
    LOOKUP_CHUNK_SIZE,
    MAX_MEDIA_BYTES,
    MEDIA_TYPES,
    badRequest,
    chunk,
    json,
    placeholders,
} from '../utils/adminMusicContracts.js';

export function mediaRoute(path) {
    const match = path.match(/^\/api\/admin\/media\/(audio|cover)\/([0-9a-f]{16})\.([a-z0-9]+)$/);
    if (!match) return null;
    const [, kind, id, extension] = match;
    const contentType = MEDIA_TYPES[kind][extension];
    if (!contentType) return null;
    return { kind, id, extension, contentType, relativePath: `${kind}/${id}.${extension}` };
}

export function mediaPrefix(env) {
    const raw = env.MEDIA_PREFIX === undefined ? DEFAULT_MEDIA_PREFIX : env.MEDIA_PREFIX;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 255 || raw !== raw.trim() || raw.startsWith('/') || raw.includes('\\')) return null;
    const segments = raw.split('/');
    if (segments.some((segment) => !segment || segment.length > 64 || segment === '.' || segment === '..' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment))) return null;
    return segments.join('/');
}

export const mediaObjectKey = (prefix, relativePath) => `${prefix}/${relativePath}`;

class MediaValidationError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'MediaValidationError';
        this.status = status;
    }
}

const startsWithBytes = (bytes, signature) => signature.every((value, index) => bytes[index] === value);

function signatureLength(extension) {
    if (extension === 'wma') return 16;
    if (extension === 'png') return 8;
    if (extension === 'webp' || extension === 'wav' || extension === 'm4a') return 12;
    if (['flac', 'ogg'].includes(extension)) return 4;
    return 3;
}

function matchesMediaSignature(bytes, extension, contentType) {
    if (MEDIA_TYPES.audio[extension] !== contentType && MEDIA_TYPES.cover[extension] !== contentType) return false;
    if (extension === 'jpg' || extension === 'jpeg') return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    if (extension === 'png') return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (extension === 'webp') return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]);
    if (extension === 'flac') return startsWithBytes(bytes, [0x66, 0x4c, 0x61, 0x43]);
    if (extension === 'wav') return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes.subarray(8), [0x57, 0x41, 0x56, 0x45]);
    if (extension === 'ogg') return startsWithBytes(bytes, [0x4f, 0x67, 0x67, 0x53]);
    if (extension === 'm4a') return startsWithBytes(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70]);
    if (extension === 'aac') return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
    if (extension === 'wma') return startsWithBytes(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
    if (extension === 'mp3') {
        if (startsWithBytes(bytes, [0x49, 0x44, 0x33])) return true;
        const version = (bytes[1] >> 3) & 0x03;
        const layer = (bytes[1] >> 1) & 0x03;
        const bitrate = bytes[2] >> 4;
        const sampleRate = (bytes[2] >> 2) & 0x03;
        return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
            && version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3;
    }
    return false;
}

export function createMediaValidationStream(input, { extension, contentType, maxBytes = MAX_MEDIA_BYTES }) {
    if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0)) throw new TypeError('maxBytes must be a positive safe integer');
    const requiredBytes = signatureLength(extension);
    const header = new Uint8Array(requiredBytes);
    const pending = [];
    let headerLength = 0;
    let byteCount = 0;
    let signatureVerified = false;
    let validationError = null;
    const fail = (status, message) => {
        validationError = new MediaValidationError(status, message);
        throw validationError;
    };
    const stream = input.pipeThrough(new TransformStream({
        transform(chunkValue, controller) {
            let bytes;
            if (chunkValue instanceof Uint8Array) bytes = chunkValue;
            else if (chunkValue instanceof ArrayBuffer) bytes = new Uint8Array(chunkValue);
            else if (ArrayBuffer.isView(chunkValue)) bytes = new Uint8Array(chunkValue.buffer, chunkValue.byteOffset, chunkValue.byteLength);
            else return fail(415, 'Media body must be a binary stream');

            if (byteCount + bytes.byteLength > maxBytes) return fail(413, 'Media exceeds size limit');
            byteCount += bytes.byteLength;
            if (bytes.byteLength === 0) return;
            if (signatureVerified) {
                controller.enqueue(bytes);
                return;
            }

            pending.push(bytes);
            const take = Math.min(requiredBytes - headerLength, bytes.byteLength);
            header.set(bytes.subarray(0, take), headerLength);
            headerLength += take;
            if (headerLength < requiredBytes) return;
            if (!matchesMediaSignature(header, extension, contentType)) {
                return fail(415, 'Media signature does not match extension and Content-Type');
            }
            signatureVerified = true;
            for (const pendingChunk of pending) controller.enqueue(pendingChunk);
            pending.length = 0;
        },
        flush() {
            if (byteCount === 0) return fail(400, 'Media request body must not be empty');
            if (!signatureVerified) return fail(415, 'Media signature does not match extension and Content-Type');
        },
    }));
    return { stream, byteCount: () => byteCount, error: () => validationError };
}

export async function handleMediaPut(route, request, env, headers) {
    if (!env.MEDIA_BUCKET) return json({ code: 503, message: 'MEDIA_BUCKET is not bound' }, 503, headers);
    const prefix = mediaPrefix(env);
    if (!prefix) return json({ code: 500, message: 'MEDIA_PREFIX is invalid' }, 500, headers);
    if (request.body === null) return badRequest('Media request body is required', headers);
    const rawLength = request.headers.get('content-length');
    let contentLength = null;
    if (rawLength !== null) {
        if (!/^\d+$/.test(rawLength)) return badRequest('Invalid Content-Length', headers);
        contentLength = Number(rawLength);
        if (!Number.isSafeInteger(contentLength)) return badRequest('Invalid Content-Length', headers);
        if (contentLength === 0) return badRequest('Media request body must not be empty', headers);
        if (contentLength > MAX_MEDIA_BYTES) return json({ code: 413, message: 'Media exceeds 100 MB limit' }, 413, headers);
    }
    const suppliedType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (suppliedType !== route.contentType) {
        return json({ code: 415, message: 'Content-Type does not match media extension', data: { expected: route.contentType } }, 415, headers);
    }

    const objectKey = mediaObjectKey(prefix, route.relativePath);
    const validated = createMediaValidationStream(request.body, {
        extension: route.extension,
        contentType: route.contentType,
        maxBytes: MAX_MEDIA_BYTES,
    });
    let object;
    try {
        object = await env.MEDIA_BUCKET.put(objectKey, validated.stream, { httpMetadata: { contentType: route.contentType } });
    } catch (error) {
        const validationError = validated.error() || ((error instanceof MediaValidationError || error?.name === 'MediaValidationError') ? error : null);
        if (validationError) {
            return json({ code: validationError.status, message: validationError.message }, validationError.status, headers);
        }
        return json({ code: 502, message: 'Media upload failed' }, 502, headers);
    }
    const size = Number(object?.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_MEDIA_BYTES || size !== validated.byteCount()) {
        return json({
            code: size > MAX_MEDIA_BYTES ? 413 : 502,
            message: size > MAX_MEDIA_BYTES ? 'Media exceeds 100 MB limit' : 'Media upload size could not be verified',
        }, size > MAX_MEDIA_BYTES ? 413 : 502, headers);
    }
    return json({
        code: 200,
        data: {
            path: route.relativePath,
            object_key: objectKey,
            size,
            etag: object.etag || object.httpEtag || '',
        },
    }, 200, headers);
}

export function managedMediaPath(value, kind) {
    if (typeof value !== 'string' || !value) return false;
    const extensions = Object.keys(MEDIA_TYPES[kind]).join('|');
    return new RegExp(`^${kind}\/[0-9a-f]{16}\.(${extensions})$`).test(value);
}

function managedMediaKind(value) {
    if (managedMediaPath(value, 'audio')) return 'audio';
    if (managedMediaPath(value, 'cover')) return 'cover';
    return null;
}

export function unsafeMediaClassification(value) {
    if (typeof value !== 'string' || !value) return 'absent';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('/') || value.startsWith('\\')) return 'unsafe_absolute';
    return 'unsafe_out_of_prefix';
}

export async function queryMediaReferences(db, paths) {
    const references = new Map(paths.map((path) => [path, []]));
    for (const pathChunk of chunk(paths, LOOKUP_CHUNK_SIZE)) {
        const marker = placeholders(pathChunk.length);
        const result = await db.prepare(`
            SELECT id, audio_url, cover_url FROM Songs
            WHERE audio_url IN (${marker}) OR cover_url IN (${marker})
        `).bind(...pathChunk, ...pathChunk).all();
        for (const song of result.results || []) {
            for (const field of ['audio_url', 'cover_url']) {
                const path = song[field];
                if (references.has(path)) references.get(path).push({ id: song.id, field });
            }
        }
    }
    return references;
}

export async function deleteManagedMedia(paths, db, env, { prefix, sharedReason = 'referenced' } = {}) {
    const result = { deleted: [], skipped: [], failures: [] };
    const safePaths = [];
    const seen = new Set();
    for (const path of paths) {
        if (!managedMediaKind(path)) {
            result.skipped.push({ path: typeof path === 'string' ? path : null, reason: unsafeMediaClassification(path) });
            continue;
        }
        if (seen.has(path)) {
            result.skipped.push({ path, reason: 'duplicate_path' });
            continue;
        }
        seen.add(path);
        safePaths.push(path);
    }
    if (safePaths.length === 0) return result;

    let references;
    try {
        references = await queryMediaReferences(db, safePaths);
    } catch {
        for (const path of safePaths) {
            result.failures.push({ path, object_key: mediaObjectKey(prefix, path), message: 'reference_recheck_failed' });
        }
        return result;
    }
    for (const path of safePaths) {
        const pathReferences = references.get(path) || [];
        if (pathReferences.length > 0) {
            result.skipped.push({
                path,
                reason: sharedReason,
                remaining_reference_ids: [...new Set(pathReferences.map((reference) => reference.id))],
            });
            continue;
        }
        const objectKey = mediaObjectKey(prefix, path);
        try {
            await env.MEDIA_BUCKET.delete(objectKey);
            result.deleted.push({ path, object_key: objectKey });
        } catch (error) {
            result.failures.push({ path, object_key: objectKey, message: String(error?.message || 'R2 delete failed') });
        }
    }
    return result;
}
