import { InstanceApiError } from '../instance/api.js';

export function pluginEndpoint(path = '', query = {}) {
  if (typeof path !== 'string' || path.length > 4096 || !/^(?:[a-zA-Z0-9_%.-]+(?:\/[a-zA-Z0-9_%.-]+)*)?$/.test(path)) throw new TypeError('Invalid plugin endpoint');
  for (const segment of path ? path.split('/') : []) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new TypeError('Invalid plugin endpoint'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/?#\x00-\x1f]/.test(decoded) || /%[0-9a-f]{2}/i.test(decoded)) throw new TypeError('Invalid plugin endpoint');
  }
  const params = new URLSearchParams();
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new TypeError('Invalid plugin query');
  for (const [key, value] of Object.entries(query)) {
    if (!/^[a-zA-Z][\w.-]{0,63}$/.test(key)) throw new TypeError('Invalid plugin query');
    if (value == null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > 2048) throw new TypeError('Invalid plugin query');
    params.set(key, String(value));
  }
  return path + (params.size ? `?${params}` : '');
}

// Keep request authority alive until the body (including an SSE stream) ends.
// The caller cannot choose an origin, plugin namespace or authentication header.
export function createPluginTransport({ pluginId, session, buildDigest, signal: lifetimeSignal, isCurrent,
  sessionStore, pluginStore, fetchImpl, onBuildMismatch = () => {} }) {
  const retired = () => new DOMException('Plugin session ended', 'AbortError');
  async function response(path = '', { method = 'GET', body, signal, admin = false, query = {}, rawBody = false, contentType } = {}) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new TypeError('Invalid plugin method');
    if (!isCurrent()) throw retired();
    if (admin && session.user.role !== 'admin') throw retired();
    const endpoint = pluginEndpoint(path, query);
    const controller = new AbortController();
    const sources = [...new Set([signal, lifetimeSignal].filter(Boolean))];
    const abort = () => controller.abort();
    const check = () => { if (!isCurrent()) abort(); };
    const subscriptions = [sessionStore.subscribe?.(check), pluginStore.subscribe?.(check)].filter(Boolean);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      for (const dispose of subscriptions) dispose();
      for (const source of sources) source.removeEventListener('abort', abort);
    };
    for (const source of sources) { if (source.aborted) abort(); else source.addEventListener('abort', abort, { once: true }); }
    const assertCurrent = () => { if (!isCurrent() || controller.signal.aborted) throw retired(); };
    try {
      assertCurrent();
      const headers = { Accept: 'application/json, text/event-stream', 'X-FlareTune-Expected-Account': session.user.accountId,
        ...(buildDigest ? { 'X-FlareTune-Plugin-Build': buildDigest } : {}) };
      if (method !== 'GET') Object.assign(headers, { 'X-Requested-With': 'FlareTune', 'X-CSRF-Token': session.csrfToken,
        'Content-Type': rawBody ? contentType || 'application/octet-stream' : 'application/json' });
      const result = await fetchImpl(`/api/${admin ? 'admin' : 'account'}/plugins/${pluginId}${endpoint ? `/${endpoint}` : ''}`, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers,
        ...(body === undefined ? {} : { body: rawBody ? body : JSON.stringify(body) }),
      });
      assertCurrent();
      if (result.status === 409) {
        const error = await result.clone().json().catch(() => null);
        if (error?.error === 'PLUGIN_BUILD_MISMATCH') onBuildMismatch();
      }
      if (!result.body) { cleanup(); return result; }
      const reader = result.body.getReader();
      const stream = new ReadableStream({
        async pull(target) {
          try {
            assertCurrent(); const next = await reader.read(); assertCurrent();
            if (next.done) { cleanup(); target.close(); } else target.enqueue(next.value);
          } catch (error) { cleanup(); controller.abort(); void reader.cancel().catch(() => {}); target.error(error); }
        },
        async cancel(reason) { cleanup(); controller.abort(); await reader.cancel(reason).catch(() => {}); },
      });
      return new Response(stream, { status: result.status, statusText: result.statusText, headers: result.headers });
    } catch (error) { cleanup(); controller.abort(); throw error; }
  }
  async function json(path, options) {
    const result = await response(path, options);
    let data;
    try { data = await result.json(); } catch (error) { if (error?.name === 'AbortError') throw error; throw new InstanceApiError(result.status, 'invalid_response'); }
    if (!result.ok) { const error = new InstanceApiError(result.status, data?.error || 'request_failed'); error.data = data; throw error; }
    if (!isCurrent()) throw retired();
    return data;
  }
  return Object.freeze({ response, json });
}
