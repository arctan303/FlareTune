import { instanceRequest, InstanceApiError } from '../instance/api.js';
import { runtimeFetch, isDemoRuntime } from './runtimeFetch.js';
import { getLocale } from '../i18n/index.js';

export function pluginDeliveryRequest(session, path = '', { method = 'GET', body, signal, fetchImpl = runtimeFetch } = {}) {
  if (isDemoRuntime || !session?.authenticated || session.user?.role !== 'admin') {
    return Promise.reject(new InstanceApiError(403, 'forbidden'));
  }
  return instanceRequest(`admin/plugin-delivery${path}`, {
    method, body, csrfToken: session.csrfToken, expectedAccountId: session.user.accountId,
    fetchImpl: (url, init) => fetchImpl(url, { ...init, signal,
      headers: { ...init.headers, 'Accept-Language': getLocale(), 'X-FlareTune-Expected-Account': session.user.accountId } }),
  });
}

export const deliveryErrorMessage = error => ({
  PLUGIN_DELIVERY_REVISION_MISMATCH: '插件变更已被其他操作更新，请刷新后重试。',
  PLUGIN_DELIVERY_CHANGED: '插件变更已被其他操作更新，请刷新后重试。',
  PLUGIN_REVISION_MISMATCH: '插件变更已被其他操作更新，请刷新后重试。',
  PLUGIN_BUILD_BUSY: '构建正在进行，请完成后再修改插件组合。',
  PLUGIN_BUILD_IN_PROGRESS: '构建正在进行，请完成后再修改插件组合。',
  PLUGIN_BUILD_RESULT_UNKNOWN: '请先核实远端构建结果，再修改待应用变更。',
  PLUGIN_BUILD_TIMEOUT: '构建超时，请核实远端任务状态。',
  PLUGIN_BUILD_FAILED: '构建未完成，当前运行版本已保留。',
  PLUGIN_BUILD_ROLLED_BACK: '发布未完成，已核实恢复原部署。插件数据不会自动回退。',
  PLUGIN_DEPLOYMENT_UNCONFIRMED: '新版本发布后的应用结果尚未确认，请核实远端部署。',
  PLUGIN_DEPENDENCY_MISSING: '插件所需依赖尚不可用，请先检查依赖。',
  PLUGIN_DEPENDENCY_INCOMPATIBLE: '插件所需依赖版本不兼容。',
  PLUGIN_REQUIRED_BY: '其他已安装插件依赖此插件，请先卸载依赖它的插件。',
  PLUGIN_BUILD_NOT_CONFIGURED: '请先配置构建触发地址和构建访问密钥。',
  PLUGIN_BUILD_TRIGGER_FAILED: '构建触发失败，待应用变更已保留，可重试。',
  PLUGIN_SOURCE_FETCH_FAILED: '无法读取插件源，请检查地址后重试。',
  PLUGIN_SOURCE_UNAVAILABLE: '无法读取插件源，请检查地址后重试。',
  PLUGIN_SOURCE_EXISTS: '此插件源已经添加。',
  PLUGIN_URL_INVALID: '请输入有效的公开 HTTPS 地址。',
  PLUGIN_DEPLOY_HOOK_INVALID: '请输入 Cloudflare Worker 的有效 Deploy Hook 地址。',
  PLUGIN_SELECTION_INCOMPATIBLE: '所选插件组合的宿主或依赖版本不兼容。',
  PLUGIN_SOURCE_INVALID: '插件源格式无效。',
  PLUGIN_SOURCE_CONFLICT: '插件来源冲突，请检查已安装插件的原始来源。',
  PLUGIN_VERSION_NOT_NEWER: '只能选择同来源的更高版本；相同版本不能替换包内容。',
  invalid_input: '请检查输入内容和链接格式。',
  forbidden: '仅管理员可管理来源与部署。',
}[error?.code || error] || '插件操作失败，请刷新后重试。');
