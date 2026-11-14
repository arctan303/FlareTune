import { getApiBaseUrl } from '../utils.js';
import { useUIStore } from '../store/useUIStore.js';
import { authenticatedFetch } from './authenticatedFetch.js';
import { getLocale, t } from '../i18n/index.js';

async function lyricRequest(path, { method = 'GET', body, signal, session = useUIStore.getState().authSession,
  fetchImpl = authenticatedFetch } = {}) {
  const response = await fetchImpl(`${getApiBaseUrl()}/api/lyrics${path}`, {
    method, credentials: 'include', cache: 'no-store', signal,
    headers: { Accept: 'application/json', 'Accept-Language': getLocale(), ...(method !== 'GET' ? {
      'Content-Type': 'application/json', 'X-Requested-With': 'FlareTune',
      ...(session?.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}),
      ...(session?.user?.accountId ? { 'X-FlareTune-Expected-Account': session.user.accountId } : {}),
    } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error?.message || t('歌词请求暂时无法完成，请重试。'));
    error.status = response.status;
    error.code = typeof payload?.error === 'string' ? payload.error : payload?.error?.code;
    throw error;
  }
  return payload;
}

export const requestLyricTranslation = (resultRef, options) => lyricRequest('/translation', {
  ...options, method: 'POST', body: { resultRef },
});

export const getLyricSourceOrder = options => lyricRequest('/sources/order', options);
export const putLyricSourceOrder = (order, expectedRevision, options) => lyricRequest('/sources/order', {
  ...options, method: 'PUT', body: { order, expectedRevision },
});
