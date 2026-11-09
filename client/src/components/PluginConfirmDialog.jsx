import React from 'react';
import { t } from '../i18n/index.js';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';

export default function PluginConfirmDialog({ installed, operation, deferred = false, deliveryMode, busy, error, onClose, onConfirm }) {
  const upgrading = operation === 'upgrade';
  const title = upgrading ? '完成插件更新' : operation === 'update' ? '更新插件' : installed ? '卸载插件' : '安装插件';
  return <SettingsEditDialog title={t(title)} busy={busy} size="small" onClose={onClose} closeOnBackdrop>
    <p className="text-sm leading-relaxed text-[var(--muted)]">{t(upgrading
      ? '将执行当前已部署插件的数据更新。失败时保留原状态；代码回退不会自动回退数据。'
      : deferred && installed
      ? '卸载将在构建并部署成功后生效，并保留插件数据和配置。'
      : deferred
      ? '插件代码会在站点执行，请确认信任其来源。变更在构建并部署成功后生效，已有配置会保留。'
      : installed
      ? '卸载作用于整个站点，保留插件数据并撤销后续访问。设备已缓冲的内容可能继续播放。'
      : '安装作用于整个站点。请核对插件说明中的连接权限和数据范围；必需依赖需先安装。')}</p>
    {deferred && <p className="mt-3 text-sm text-[var(--muted)]">{t(deliveryMode === 'auto' ? '确认后自动提交构建并部署。' : '确认后加入待应用变更，可稍后统一构建。')}</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
    <SettingsActions className="mt-5">
      <SettingsButton closeDialog variant="quiet" disabled={busy}>{t('取消')}</SettingsButton>
      <SettingsButton variant={!upgrading && installed ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
        {busy ? t('正在保存…') : t(title)}
      </SettingsButton>
    </SettingsActions>
  </SettingsEditDialog>;
}
