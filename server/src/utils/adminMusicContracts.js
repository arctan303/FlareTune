export const MAX_BATCH_SONGS = 50;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const MAX_MEDIA_DELETE_PATHS = 100;
export const WRITE_CHUNK_SIZE = 9;
export const LOOKUP_CHUNK_SIZE = 50;
export const DEFAULT_MEDIA_PREFIX = 'media';

export const SONG_FIELDS = Object.freeze([
    'id',
    'title',
    'artist',
    'album',
    'duration',
    'audio_url',
    'cover_url',
    'language',
]);
export const METADATA_FIELDS = Object.freeze(SONG_FIELDS.filter((field) => field !== 'id'));
export const TEXT_FIELDS = new Set(['artist', 'album', 'audio_url', 'cover_url']);

export const MEDIA_TYPES = Object.freeze({
    audio: Object.freeze({
        mp3: 'audio/mpeg',
        flac: 'audio/flac',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        wma: 'audio/x-ms-wma',
    }),
    cover: Object.freeze({
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
    }),
});

export const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const placeholders = (count) => Array.from({ length: count }, () => '?').join(', ');
export const chunk = (values, size) => {
    const chunks = [];
    for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
    return chunks;
};

export const json = (body, status, headers) => new Response(JSON.stringify(body), {
    status,
    headers: {
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    },
});

export const badRequest = (message, headers, details) => json({ code: 400, message, ...(details ? { details } : {}) }, 400, headers);

export async function readJsonObject(request, allowedFields, requiredFields, headers) {
    let body;
    try {
        body = await request.json();
    } catch {
        return { response: badRequest('Invalid JSON body', headers) };
    }
    if (!isObject(body)) return { response: badRequest('JSON body must be an object', headers) };
    const unknown = Object.keys(body).filter((field) => !allowedFields.includes(field));
    if (unknown.length > 0) return { response: badRequest('Unknown fields', headers, { fields: unknown }) };
    const missing = requiredFields.filter((field) => !hasOwn(body, field));
    if (missing.length > 0) return { response: badRequest('Missing fields', headers, { fields: missing }) };
    return { body };
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

export async function impactDigest(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
