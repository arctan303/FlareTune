// Authenticated catalog media ingestion. The enclosing Worker checks instance
// state, Origin and CSRF; this route independently checks the admin role.
import { mediaPrefix } from '../services/adminMusicMedia.js';

const PREFIX = '/api/admin/catalog/media/';
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MEDIA_TYPES = Object.freeze({
  audio: Object.freeze({
    mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', wma: 'audio/x-ms-wma',
  }),
  cover: Object.freeze({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }),
});

function reply(body, status, headers = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers, ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}
const error = (code, message, status, headers, extraHeaders) => reply({ ok: false, error: code, message }, status, headers, extraHeaders);
const startsWith = (bytes, signature) => signature.every((byte, index) => bytes[index] === byte);

function signatureLength(extension) {
  if (extension === 'wma') return 16;
  if (['png', 'webp', 'wav', 'm4a'].includes(extension)) return 12;
  return 4;
}

function matchesSignature(bytes, extension) {
  if (extension === 'jpg' || extension === 'jpeg') return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (extension === 'png') return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (extension === 'webp') return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]);
  if (extension === 'flac') return startsWith(bytes, [0x66, 0x4c, 0x61, 0x43]);
  if (extension === 'wav') return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x41, 0x56, 0x45]);
  if (extension === 'ogg') return startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]);
  if (extension === 'm4a') return startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70]);
  if (extension === 'aac') return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (extension === 'wma') return startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
  if (extension === 'mp3') {
    if (startsWith(bytes, [0x49, 0x44, 0x33])) return true;
    const version = (bytes[1] >> 3) & 0x03;
    const layer = (bytes[1] >> 1) & 0x03;
    const bitrate = bytes[2] >> 4;
    const sampleRate = (bytes[2] >> 2) & 0x03;
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
      && version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3;
  }
  return false;
}

class MediaBodyError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// The caller never buffers the whole upload. R2 only commits after consuming
// this stream, so invalid signatures and over-limit bodies abort the put.
export function createValidatedMediaStream(input, { extension, maxBytes = MAX_MEDIA_BYTES }) {
  if (!input?.getReader || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid media stream or size limit');
  const reader = input.getReader();
  const required = signatureLength(extension);
  const signature = new Uint8Array(required);
  const pending = [];
  let signatureBytes = 0;
  let byteCount = 0;
  let verified = false;
  let failure = null;
  const fail = (code, message, status) => {
    failure = new MediaBodyError(code, message, status);
    throw failure;
  };
  // A pull-based ReadableStream works on Workers compatibility dates that do
  // not enable the custom-transformer TransformStream constructor.
  const stream = new ReadableStream({
    async pull(controller) {
      // If a chunk is shorter than the signature, continue reading within
      // this pull. Some runtimes do not schedule another pull until enqueue.
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) {
          if (!byteCount) fail('EMPTY_MEDIA_BODY', '媒体请求体不能为空。', 400);
          if (!verified) fail('INVALID_MEDIA_SIGNATURE', '文件内容与媒体格式不匹配。', 415);
          controller.close();
          return;
        }
        if (!(chunk instanceof Uint8Array)) fail('INVALID_MEDIA_BODY', '媒体请求体必须是二进制数据。', 400);
        if (byteCount + chunk.byteLength > maxBytes) fail('MEDIA_TOO_LARGE', '媒体文件超过 100 MiB 上限。', 413);
        byteCount += chunk.byteLength;
        if (!chunk.byteLength) continue;
        if (verified) {
          controller.enqueue(chunk);
          return;
        }
        pending.push(chunk);
        const take = Math.min(required - signatureBytes, chunk.byteLength);
        signature.set(chunk.subarray(0, take), signatureBytes);
        signatureBytes += take;
        if (signatureBytes < required) continue;
        if (!matchesSignature(signature, extension)) fail('INVALID_MEDIA_SIGNATURE', '文件内容与媒体格式不匹配。', 415);
        verified = true;
        for (const pendingChunk of pending) controller.enqueue(pendingChunk);
        pending.length = 0;
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, byteCount: () => byteCount, error: () => failure };
}

export async function handleLocalCatalogMediaRoute(request, url, db, headers = {}, session, env = {}) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (session?.mode !== 'normal' || session?.account?.role !== 'admin') {
    return error('FORBIDDEN', '需要管理员权限。', 403, headers);
  }
  if (request.method !== 'PUT') {
    return error('METHOD_NOT_ALLOWED', '只允许 PUT 上传媒体。', 405, headers, { Allow: 'PUT' });
  }
  const match = /^\/api\/admin\/catalog\/media\/(audio|cover)\/([0-9a-f]{16})\.([a-z0-9]+)$/.exec(url.pathname);
  if (!match || url.search) return error('INVALID_MEDIA_PATH', '媒体路径格式无效。', 400, headers);
  const [, kind, id, extension] = match;
  const contentType = MEDIA_TYPES[kind][extension];
  if (!contentType) return error('UNSUPPORTED_MEDIA_TYPE', '不支持该媒体格式。', 415, headers);
  if (request.headers.get('content-type')?.trim().toLowerCase() !== contentType) {
    return error('MEDIA_CONTENT_TYPE_MISMATCH', `Content-Type 必须是 ${contentType}。`, 415, headers);
  }
  if (!request.body) return error('EMPTY_MEDIA_BODY', '媒体请求体不能为空。', 400, headers);
  const declaredSize = request.headers.get('X-FlareTune-Media-Size');
  const transportSize = request.headers.get('content-length');
  const rawLength = declaredSize ?? transportSize;
  if (rawLength === null) return error('MEDIA_SIZE_REQUIRED', '上传媒体需要明确文件大小。', 411, headers);
  if (declaredSize !== null && transportSize !== null && Number(declaredSize) !== Number(transportSize)) {
    return error('MEDIA_SIZE_MISMATCH', '文件大小与传输长度不一致。', 400, headers);
  }
  if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
    return error('INVALID_CONTENT_LENGTH', 'Content-Length 无效。', 400, headers);
  }
  if (rawLength === '0') return error('EMPTY_MEDIA_BODY', '媒体请求体不能为空。', 400, headers);
  const contentLength = Number(rawLength);
  if (contentLength > MAX_MEDIA_BYTES) {
    return error('MEDIA_TOO_LARGE', '媒体文件超过 100 MiB 上限。', 413, headers);
  }
  if (!env.MEDIA_BUCKET?.put) return error('MEDIA_STORAGE_UNAVAILABLE', '媒体存储暂时不可用。', 503, headers);

  const relativePath = `${kind}/${id}.${extension}`;
  const prefix = mediaPrefix(env);
  if (!prefix) return error('MEDIA_STORAGE_UNAVAILABLE', '媒体存储配置无效。', 503, headers);
  const objectKey = `${prefix}/${relativePath}`;
  const validated = createValidatedMediaStream(request.body, { extension });
  // R2 requires a body with a known length. FixedLengthStream also rejects a
  // declared length that differs from the bytes actually received.
  const fixed = new FixedLengthStream(contentLength);
  const uploadAbort = new AbortController();
  const pumping = validated.stream.pipeTo(fixed.writable, { signal: uploadAbort.signal });
  let object;
  try {
    // If-None-Match: * is atomic at the R2 object boundary; head-then-put is not.
    object = await env.MEDIA_BUCKET.put(objectKey, fixed.readable, {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
      httpMetadata: { contentType },
    });
    if (object) await pumping;
  } catch {
    uploadAbort.abort();
    const failure = validated.error();
    if (failure) await pumping.catch(() => {});
    else void pumping.catch(() => {});
    if (failure) return error(failure.code, failure.message, failure.status, headers);
    return error('MEDIA_UPLOAD_FAILED', '媒体上传失败。', 502, headers);
  }
  if (!object) {
    uploadAbort.abort();
    void pumping.catch(() => {});
    return error('MEDIA_EXISTS', '媒体对象已存在；请使用新的 ID。', 409, headers);
  }
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_MEDIA_BYTES
    || object.size !== contentLength || object.size !== validated.byteCount()) {
    return error('MEDIA_SIZE_UNVERIFIED', '无法确认媒体上传大小。', 502, headers);
  }
  return reply({ ok: true, data: {
    path: relativePath,
    url: `/media/${relativePath}`,
    objectKey,
    size: object.size,
    etag: object.etag || object.httpEtag || '',
  } }, 201, headers);
}
