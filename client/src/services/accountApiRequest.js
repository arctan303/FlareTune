import { authenticatedFetch } from './authenticatedFetch.js';
import { useUIStore } from '../store/useUIStore.js';

export async function requestAccountJson({
  fetchImpl,
  base,
  path,
  init = {},
  ErrorType,
  errorLabel,
}) {
  const method = init.method || 'GET';
  const authSession = useUIStore.getState().authSession;
  const csrfToken = method === 'GET' ? null : authSession?.csrfToken;
  const expectedAccountId = authSession?.user?.accountId;
  const response = await authenticatedFetch(`${base}${path}`, {
    ...init,
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(expectedAccountId ? { 'X-FlareTune-Expected-Account': expectedAccountId } : {}),
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'FlareTune',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }),
      ...(init.headers || {}),
    },
  }, fetchImpl);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new ErrorType(
      payload?.message || `${errorLabel}（${response.status}）`,
      { status: response.status, code: payload?.error, data: payload?.data },
    );
  }
  return payload.data;
}
