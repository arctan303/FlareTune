import { instanceRequest, InstanceApiError } from '../instance/api.js';
import { runtimeFetch, isDemoRuntime } from './runtimeFetch.js';

export function pluginsRequest(session, { admin = false, id, installed, revision, signal, fetchImpl = runtimeFetch } = {}) {
  if (isDemoRuntime) return Promise.reject(new InstanceApiError(403, 'PLUGIN_DEMO_DISABLED'));
  if (signal?.aborted) return Promise.reject(new DOMException('Plugin session ended', 'AbortError'));
  const writing = id !== undefined;
  return instanceRequest(`${admin || writing ? 'admin' : 'account'}/plugins${writing ? `/${encodeURIComponent(id)}` : ''}`, {
    method: writing ? 'PUT' : 'GET',
    ...(writing ? { body: { installed, revision } } : {}),
    csrfToken: session.csrfToken, expectedAccountId: session.user.accountId,
    fetchImpl: (url, init) => fetchImpl(url, { ...init, signal,
      headers: { ...init.headers, 'X-FlareTune-Expected-Account': session.user.accountId } }),
  });
}
