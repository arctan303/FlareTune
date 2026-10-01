import { normalizeInstanceStatus, normalizeSession } from './state.js';

export class InstanceApiError extends Error {
  constructor(status, code = 'request_failed') {
    super('请求暂时无法完成');
    this.name = 'InstanceApiError';
    this.status = status;
    this.code = code;
  }
}

export async function instanceRequest(path, { method = 'GET', body, csrfToken, expectedAccountId,
  fetchImpl = globalThis.fetch } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Requested-With'] = 'FlareTune';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (expectedAccountId) headers['X-FlareTune-Expected-Account'] = expectedAccountId;
  }
  let response;
  try {
    response = await fetchImpl(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new InstanceApiError(0, 'network_unavailable');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new InstanceApiError(response.status, 'invalid_response');
  }
  if (!response.ok) {
    throw new InstanceApiError(response.status, typeof payload?.error === 'string' ? payload.error : 'request_failed');
  }
  return payload;
}

export const getInstanceStatus = (fetchImpl) => instanceRequest('instance/status', { fetchImpl }).then(normalizeInstanceStatus);
export const getAdminMigrationStatus = (csrfToken, fetchImpl) => instanceRequest('admin/system/migration', { csrfToken, fetchImpl });

export async function getSession(fetchImpl) {
  try {
    return normalizeSession(await instanceRequest('auth/session', { fetchImpl }));
  } catch (error) {
    if (error instanceof InstanceApiError && error.status === 401) return normalizeSession(null);
    throw error;
  }
}

export const verifySetupSecret = (body, fetchImpl) => instanceRequest('auth/verify-setup', { method: 'POST', body, fetchImpl });
export const setupInstance = (body, fetchImpl) => instanceRequest('auth/setup', { method: 'POST', body, fetchImpl });
export const verifyMaintenanceSecret = (body, fetchImpl) => instanceRequest('instance/verify-maintenance', { method: 'POST', body, fetchImpl });
export const runMaintenanceUpgrade = (body, fetchImpl) => instanceRequest('instance/upgrade', { method: 'POST', body, fetchImpl });
export const runAdminMigration = (csrfToken, fetchImpl) => instanceRequest('admin/system/migration', {
  method: 'POST', body: {}, csrfToken, fetchImpl,
});
export const login = (body, fetchImpl) => instanceRequest('auth/login', { method: 'POST', body, fetchImpl });
export const logout = (csrfToken, fetchImpl) => instanceRequest('auth/logout', { method: 'POST', body: {}, csrfToken, fetchImpl });
export const changePassword = (body, csrfToken, fetchImpl) => instanceRequest('auth/change-password', { method: 'POST', body, csrfToken, fetchImpl });
export const updateOwnProfile = (body, csrfToken, accountId, fetchImpl) => instanceRequest('account/profile', {
  method: 'PATCH', body, csrfToken, expectedAccountId: accountId, fetchImpl,
});
export const updateOwnUiLanguage = (uiLanguage, csrfToken, accountId, fetchImpl) => instanceRequest('account/ui-language', {
  method: 'PATCH', body: { uiLanguage }, csrfToken, expectedAccountId: accountId, fetchImpl,
});

export function messageForError(error, context = 'request') {
  if (error?.status === 429) return '尝试次数较多，请稍后再试。';
  if (error?.status === 503 || error?.status === 0) return '服务暂时不可用，请稍后重试。';
  if (context === 'login') return '用户名或密码不正确。';
  if (context === 'verify_setup') return '初始化密钥无效或已过期，请检查后重试。';
  if (context === 'setup') return '无法完成初始化。请检查管理员用户名和密码后重试。';
  if (context === 'change') return '无法修改密码，请检查输入后重试。';
  return '请求暂时无法完成，请重试。';
}
