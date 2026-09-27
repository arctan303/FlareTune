import { instanceRequest } from './api.js';

export const getAdminOverview = (csrfToken, fetchImpl) => Promise.all([
  instanceRequest('admin/settings', { csrfToken, fetchImpl }),
  instanceRequest('admin/accounts', { csrfToken, fetchImpl }),
]).then(([settings, accounts]) => ({ ...settings, accounts: accounts.accounts }));

export const putAdminSetting = (key, value, expectedRevision, csrfToken, fetchImpl) =>
  instanceRequest('admin/settings', {
    method: 'PUT', body: { key, value, expectedRevision }, csrfToken, fetchImpl,
  });

export const putAssistant = (patch, expectedRevision, csrfToken, fetchImpl) =>
  instanceRequest('admin/assistant', {
    method: 'PUT', body: { patch, expectedRevision }, csrfToken, fetchImpl,
  });

export const getAiProfiles = (csrfToken, fetchImpl) =>
  instanceRequest('admin/ai/profiles', { csrfToken, fetchImpl });

export const createAiProfile = (profile, csrfToken, fetchImpl) =>
  instanceRequest('admin/ai/profiles', { method: 'POST', body: profile, csrfToken, fetchImpl });

export const updateAiProfile = (id, profile, expectedRevision, csrfToken, fetchImpl) =>
  instanceRequest(`admin/ai/profiles/${encodeURIComponent(id)}`, {
    method: 'PUT', body: { profile, expectedRevision }, csrfToken, fetchImpl,
  });

export const deleteAiProfile = (id, expectedRevision, csrfToken, fetchImpl) =>
  instanceRequest(`admin/ai/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE', body: { expectedRevision }, csrfToken, fetchImpl,
  });

export const assignAiProfile = (feature, profileId, expectedRevision, csrfToken, fetchImpl) =>
  instanceRequest('admin/ai/assignments', {
    method: 'PUT', body: { feature, profileId, expectedRevision }, csrfToken, fetchImpl,
  });

export const createManagedAccount = (body, csrfToken, fetchImpl) =>
  instanceRequest('admin/accounts', { method: 'POST', body, csrfToken, fetchImpl });

export const patchManagedAccount = (accountId, body, csrfToken, fetchImpl) =>
  instanceRequest(`admin/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PATCH', body, csrfToken, fetchImpl,
  });

export const resetManagedPassword = (accountId, temporaryPassword, csrfToken, fetchImpl) =>
  instanceRequest(`admin/accounts/${encodeURIComponent(accountId)}/reset-password`, {
    method: 'POST', body: { temporaryPassword }, csrfToken, fetchImpl,
  });

export function parseExactHttpsOrigins(text) {
  const origins = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (origins.length > 32 || new Set(origins).size !== origins.length) {
    throw new Error('最多填写 32 个不重复的来源。');
  }
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('请输入完整 HTTPS 来源，例如 https://example.com。'); }
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
      throw new Error('每行只填写精确 HTTPS 来源，不包含路径、参数或末尾斜杠。');
    }
  }
  return origins;
}

export function adminErrorMessage(error) {
  if (error?.status === 409) return '内容已被其他会话更改，或该账号是最后一位可用管理员。请刷新后确认。';
  if (error?.status === 401) return '会话已失效，请重新登录。';
  if (error?.status === 403) return '当前账号没有管理员权限。';
  if (error?.status === 400) return '输入不符合要求，请检查后重试。';
  if (error?.status === 429) return '操作过于频繁，请稍后再试。';
  return '操作暂时无法完成，请稍后重试。';
}
