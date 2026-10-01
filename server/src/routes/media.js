import { mediaPrefix } from '../services/adminMusicMedia.js';
import { resolveInstanceState } from '../instance/state.js';
import { getSessionAfterReadyCheck, tokenFromCookie } from '../auth/local/index.js';

const baseHeaders = () => new Headers({
  'Accept-Ranges': 'bytes',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
});

export function resolveMediaObjectKey(pathname, env) {
  if (!pathname.startsWith('/media/')) return null;
  const prefix = mediaPrefix(env);
  if (!prefix) return null;
  const rawSegments = pathname.slice('/media/'.length).split('/');
  if (rawSegments.length === 0 || rawSegments.some((segment) => !segment)) return null;

  const segments = [];
  try {
    for (const rawSegment of rawSegments) {
      const segment = decodeURIComponent(rawSegment);
      if (
        !segment
        || segment === '.'
        || segment === '..'
        || segment.includes('/')
        || segment.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(segment)
      ) return null;
      segments.push(segment);
    }
  } catch {
    return null;
  }
  return `${prefix}/${segments.join('/')}`;
}

function applyObjectHeaders(object, headers, { partialRequested = false } = {}) {
  object.writeHttpMetadata?.(headers);
  // R2 object metadata is untrusted for the authorization boundary. It must
  // never replace the private response policy after session validation.
  headers.set('Cache-Control', 'private, no-store');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (Number.isFinite(object.size)) headers.set('Content-Length', String(object.size));

  const offset = Number(object.range?.offset);
  const length = Number(object.range?.length);
  if (partialRequested && Number.isFinite(offset) && Number.isFinite(length) && length > 0 && Number.isFinite(object.size)) {
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return 206;
  }
  return 200;
}

const denied = (status, extraHeaders = {}) => new Response(null, { status, headers: {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  ...extraHeaders,
} });

export async function handleMediaRoute(request, pathname, env) {
  try {
    const instance = await resolveInstanceState(env?.DB, Date.now(), { cacheSchema: true });
    if (instance.state !== 'ready') return denied(503);
    const token = tokenFromCookie(request.headers.get('Cookie'));
    if (!token) return denied(401);
    const session = await getSessionAfterReadyCheck({ db: env.DB, token });
    if (!session) return denied(401);
    if (session.mode !== 'normal' || !['admin', 'member'].includes(session.account?.role)) return denied(403);
  } catch {
    return denied(503);
  }
  return serveMediaObject(request, pathname, env);
}

// Only handleMediaRoute is wired to the public Worker entrypoint.
export async function serveMediaObject(request, pathname, env) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return denied(405, { Allow: 'GET, HEAD' });
  }
  if (!env?.MEDIA_BUCKET) return denied(503);

  const key = resolveMediaObjectKey(pathname, env);
  if (!key) return denied(404);

  const object = request.method === 'HEAD'
    ? await env.MEDIA_BUCKET.head(key)
    : await env.MEDIA_BUCKET.get(key, { range: request.headers });
  if (!object) return denied(404);

  const headers = baseHeaders();
  const status = applyObjectHeaders(object, headers, {
    partialRequested: request.method === 'GET' && request.headers.has('Range'),
  });
  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}
