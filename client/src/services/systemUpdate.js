import { instanceRequest, InstanceApiError, getInstanceStatus } from '../instance/api.js';
import { runtimeFetch, isDemoRuntime } from './runtimeFetch.js';
import { getLocale } from '../i18n/index.js';

export const SYSTEM_UPDATE_STATUS_EVENT = 'tune-system-update-status-refresh';

export async function recheckSystemUpdateStatus({ signal, isCurrent = () => true, fetchImpl = runtimeFetch, target = globalThis.window } = {}) {
  if (isDemoRuntime || signal?.aborted || !isCurrent()) return false;
  try {
    const status = await getInstanceStatus((url, init) => fetchImpl(url, { ...init, signal }));
    if (signal?.aborted || !isCurrent() || status.state !== 'maintenance' || status.reason !== 'system_update_running') return false;
    const EventConstructor = target?.Event || globalThis.Event;
    if (typeof target?.dispatchEvent !== 'function' || typeof EventConstructor !== 'function') return false;
    target.dispatchEvent(new EventConstructor(SYSTEM_UPDATE_STATUS_EVENT));
    return true;
  } catch { return false; }
}

export function systemUpdateRequest(session, path = '', { method = 'GET', body, signal, fetchImpl = runtimeFetch } = {}) {
  if (isDemoRuntime || !session?.authenticated || session.mustChangePassword || session.user?.role !== 'admin') {
    return Promise.reject(new InstanceApiError(403, 'forbidden'));
  }
  return instanceRequest(`admin/system-update${path}`, {
    method, body, csrfToken: session.csrfToken, expectedAccountId: session.user.accountId,
    fetchImpl: (url, init) => fetchImpl(url, { ...init, signal,
      headers: { ...init.headers, 'Accept-Language': getLocale(), 'X-FlareTune-Expected-Account': session.user.accountId } }),
  });
}

const errors = Object.freeze({
  forbidden: '仅管理员可更新系统。',
  network_unavailable: '无法连接更新服务，请重试。',
  invalid_response: '更新服务暂时不可用，请重试。',
  SYSTEM_UPDATE_REVISION_MISMATCH: '更新状态已变化，请刷新后重试。',
  SYSTEM_UPDATE_CHANGED: '更新状态已变化，请刷新后重试。',
  SYSTEM_UPDATE_NOT_CONFIGURED: '请先配置更新通道。',
  SYSTEM_UPDATE_BUSY: '更新正在进行，请等待当前任务完成。',
  SYSTEM_UPDATE_IN_PROGRESS: '更新正在进行，请等待当前任务完成。',
  SYSTEM_UPDATE_PLUGIN_PENDING: '请先完成或撤销待应用的插件变更。',
  SYSTEM_UPDATE_PENDING_PLUGIN_CHANGES: '请先完成或撤销待应用的插件变更。',
  SYSTEM_UPDATE_PLUGIN_BUILD_BUSY: '请先完成或核实当前插件构建。',
  SYSTEM_UPDATE_RELEASE_CHANGED: '可用版本已变化，请重新检查更新。',
  SYSTEM_UPDATE_RELEASE_UNAVAILABLE: '无法取得可用版本，请稍后重新检查。',
  SYSTEM_UPDATE_RELEASE_FETCH_FAILED: '无法取得可用版本，请稍后重新检查。',
  SYSTEM_UPDATE_FETCH_FAILED: '无法取得可用版本，请稍后重新检查。',
  SYSTEM_UPDATE_MANIFEST_INVALID: '版本信息未通过校验，当前版本保持不变。',
  SYSTEM_UPDATE_RELEASE_INVALID: '版本信息未通过校验，当前版本保持不变。',
  SYSTEM_UPDATE_INCOMPATIBLE: '此版本暂不兼容当前实例，请查看更新说明。',
  SYSTEM_UPDATE_HOST_INCOMPATIBLE: '此版本暂不兼容当前实例，请查看更新说明。',
  SYSTEM_UPDATE_VERSION_UNSUPPORTED: '此版本暂不兼容当前实例，请查看更新说明。',
  SYSTEM_UPDATE_PLUGIN_INCOMPATIBLE: '此版本与已安装插件不兼容，请先核对插件版本。',
  SYSTEM_UPDATE_RUNTIME_UNAVAILABLE: '当前运行版本暂时无法核实，请刷新后重试。',
  SYSTEM_UPDATE_CANDIDATE_INVALID: '版本信息未通过校验，当前版本保持不变。',
  SYSTEM_UPDATE_ALREADY_CURRENT: '当前已是此版本，请重新检查更新。',
  SYSTEM_UPDATE_TARGET_CHANGED: '更新目标已变化，请刷新后核实。',
  SYSTEM_UPDATE_JOB_CHANGED: '更新任务已变化，请刷新后核实。',
  SYSTEM_UPDATE_NOT_NEWER: '当前已是此版本，请重新检查更新。',
  SYSTEM_UPDATE_TRIGGER_FAILED: '构建提交结果尚未确认，请继续核实同一更新任务。',
  SYSTEM_UPDATE_DEPLOYMENT_UNCONFIRMED: '新版本的部署结果尚未确认，请继续核实同一任务。',
  SYSTEM_UPDATE_RETRY_FORBIDDEN: '此任务暂不能重试，请刷新核实状态。',
  SYSTEM_UPDATE_RETRY_UNAVAILABLE: '此任务暂不能重试，请刷新核实状态。',
  SYSTEM_UPDATE_RESULT_UNKNOWN: '新版本的部署结果尚未确认，请继续核实同一任务。',
  SYSTEM_UPDATE_CREDENTIALS_UNAVAILABLE: '更新凭据不可用，请重新配置更新通道。',
  SYSTEM_UPDATE_SECRET_UNAVAILABLE: '更新凭据不可用，请重新配置更新通道。',
  SYSTEM_UPDATE_INVALID_INPUT: '请检查更新通道的输入内容。',
  invalid_input: '请检查更新通道的输入内容。',
});

export const systemUpdateErrorMessage = error => errors[error?.code || error] || '系统更新未完成，请刷新核实状态。';
