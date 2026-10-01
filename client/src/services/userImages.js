import { instanceRequest, InstanceApiError } from '../instance/api.js';
import { getApiBaseUrl } from './apiBase.js';
import { useUIStore } from '../store/useUIStore.js';
const current = (accountId) => useUIStore.getState().authSession.user?.accountId === accountId;
export async function uploadUserImage(blob, purpose, session, fetchImpl = globalThis.fetch) {
  if (!current(session.user.accountId)) throw new InstanceApiError(409, 'account_context_changed');
  const response = await fetchImpl(`${getApiBaseUrl()}/api/account/images/upload/${purpose}`, {
    method: 'POST', credentials: 'include', cache: 'no-store', body: blob,
    headers: { 'Content-Type': 'image/webp', 'X-Requested-With': 'FlareTune',
      'X-CSRF-Token': session.csrfToken, 'X-FlareTune-Expected-Account': session.user.accountId },
  });
  if (!current(session.user.accountId)) throw new InstanceApiError(409, 'account_context_changed');
  const value = await response.json();
  if (!response.ok) throw new InstanceApiError(response.status, value.error);
  return value;
}
export async function saveUserImageSlot(purpose, target, imageId, revision, session) {
  if (!current(session.user.accountId)) throw new InstanceApiError(409, 'account_context_changed');
  const value = await instanceRequest(`account/images/slots/${purpose}/${encodeURIComponent(target)}`, {
    method: 'PUT', body: { imageId, revision }, csrfToken: session.csrfToken, expectedAccountId: session.user.accountId,
  });
  if (!current(session.user.accountId)) throw new InstanceApiError(409, 'account_context_changed');
  return value;
}
export function imageErrorMessage(error) {
  if (error?.code === 'user_images_migration_required') return '请管理员先完成数据库补充迁移。';
  if (error?.code === 'revision_conflict') return '图片已在其他页面更新，请刷新后重试。';
  if (error?.code === 'account_context_changed') return '账号状态已变化，已忽略旧请求结果。';
  return '图片保存失败，原图片已保留。';
}
export async function discardUserImage(id, session) {
  if (!current(session.user.accountId)) return;
  try { await instanceRequest(`account/images/${encodeURIComponent(id)}`, { method: 'DELETE', body: {}, csrfToken: session.csrfToken, expectedAccountId: session.user.accountId }); }
  catch { /* Orphan drafts are retried by bounded server cleanup. */ }
}
