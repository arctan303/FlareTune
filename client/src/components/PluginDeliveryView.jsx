import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { localizePlugin } from '../plugins/registry.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import { SettingsActions, SettingsButton, SettingsToggle } from './SettingsControls.jsx';
import { activePluginBuild } from '../hooks/usePluginDelivery.js';
import { deliveryErrorMessage } from '../services/pluginDelivery.js';

const buildLabel = status => ({ triggering: '正在提交构建', queued: '等待构建', building: '正在构建与部署',
  deploying: '正在发布新版本', rolling_back: '正在恢复原部署', activation_pending: '部署结果待确认',
  failed: '构建未完成', deployed: '已部署并应用', cancelled: '站内任务已解除' }[status] || '尚无构建记录');
const operationLabel = operation => ({ install: '安装', update: '更新', uninstall: '卸载' }[operation] || operation);
const sourceLabel = status => ({ unpublished: '目录尚未发布', ready: '目录可用', error: '源读取失败' }[status] || '尚未刷新');
const inputClass = 'w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--ink)] placeholder:text-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]';

export function PluginDeliveryStatus({ delivery }) {
  const locale = useLocale();
  const [resolving, setResolving] = React.useState(false);
  const { data, busy, action } = delivery;
  if (!data) return null;
  const locked = busy || activePluginBuild(data.build) || (data.build?.resultUnknown && data.build?.deploymentStarted);
  const submit = path => { void action(path).catch(() => {}); };
  return <SettingsSection title={t('待应用变更')}>
    <div className="space-y-3 text-sm text-[var(--muted)]" aria-live="polite">
      {data.pending.length ? <>
        <p>{t(['deploying', 'rolling_back', 'activation_pending'].includes(data.build?.status) || data.build?.resultUnknown
          ? '请先核实远端构建结果，再修改待应用变更。' : '变更将在构建并部署成功后生效，当前版本继续运行。')}</p>
        <ul className="space-y-2">{data.pending.map(change => <li key={change.id} className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="font-medium text-[var(--ink)]">{localizePlugin([...data.desired, ...data.running].find(row => row.id === change.id)?.manifest, locale)?.name || change.id}</span><span>{t(operationLabel(change.operation))}</span>
          <span>{[change.fromVersion, change.toVersion].filter(Boolean).join(' → ')}</span>
        </li>)}</ul>
        <SettingsActions>
          <SettingsButton disabled={locked || data.build?.resultUnknown} onClick={() => submit('/discard')}>{t('撤销待应用变更')}</SettingsButton>
          <SettingsButton variant="primary" disabled={locked} onClick={() => submit('/build')}>{t(data.build?.status === 'failed' ? '重试构建并部署' : '构建并部署')}</SettingsButton>
        </SettingsActions>
      </> : <p>{t('当前没有待应用的插件变更。')}</p>}
      {data.build && <div className="space-y-1 border-t border-[var(--line)] pt-3">
        <p>{t('最近构建')}{' · '}{t(buildLabel(data.build.status))}</p>
        <p className="break-all text-xs">{data.build.id}</p>
        {data.build.error && <p role="alert">{t(deliveryErrorMessage(data.build.error))}</p>}
        {data.build.status === 'deployed' && <SettingsButton onClick={() => window.location.reload()}>{t('重新加载网页')}</SettingsButton>}
        {data.build.resultUnknown && !data.build.deploymentStarted && <>
          <p>{t('远端构建结果尚未确认，当前插件组合已冻结。可以重试同一组合，或核实远端任务已停止后解除。')}</p>
          <SettingsButton disabled={busy} onClick={() => setResolving(true)}>{t('核实并解除冻结')}</SettingsButton>
        </>}
        {data.build.resultUnknown && data.build.deploymentStarted && <p>{t('发布已经开始，请使用构建环境的受控恢复命令确认或恢复部署。')}</p>}
      </div>}
    </div>
    {resolving && <SettingsEditDialog title={t('核实并解除冻结')} busy={busy} size="small" onClose={() => setResolving(false)}>
      <p className="text-sm text-[var(--muted)]">{t('请先在构建服务中取消相关任务，或确认它们已经结束。此操作只解除站内冻结，不会替你取消远端构建。')}</p>
      <SettingsActions className="mt-4"><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton><SettingsButton disabled={busy} variant="primary" onClick={() => { void action('/build/resolve', 'POST', { confirmedStopped: true }).then(result => { if (result) setResolving(false); }).catch(() => {}); }}>{t('已核实远端任务停止')}</SettingsButton></SettingsActions>
    </SettingsEditDialog>}
  </SettingsSection>;
}

export default function PluginDeliveryView({ delivery }) {
  const { data, busy, action } = delivery;
  const [editing, setEditing] = React.useState(null);
  const [sourceUrl, setSourceUrl] = React.useState('');
  const [hookUrl, setHookUrl] = React.useState('');
  const [buildToken, setBuildToken] = React.useState('');
  const [clearHook, setClearHook] = React.useState(false);
  const locked = busy || activePluginBuild(data.build) || data.build?.resultUnknown;
  const close = () => { setEditing(null); setHookUrl(''); setBuildToken(''); setSourceUrl(''); setClearHook(false); };
  const save = async event => {
    event.preventDefault();
    try {
      const result = editing === 'source'
        ? await action('/sources', 'POST', { url: sourceUrl })
        : await action('', 'PUT', { ...(hookUrl.trim() ? { deployHookUrl: hookUrl.trim() } : {}),
          ...(buildToken.trim() ? { buildToken: buildToken.trim() } : {}), ...(clearHook ? { deployHookUrl: '', mode: 'manual' } : {}) });
      if (result) close();
    } catch { /* The resource displays a fixed safe message. */ }
  };
  const change = (path, method, body) => { void action(path, method, body).catch(() => {}); };
  const token = () => setBuildToken(Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''));
  return <>
    <SettingsSection title={t('插件源')} action={<SettingsButton disabled={locked} onClick={() => setEditing('source')}>{t('添加插件源')}</SettingsButton>}>
      <div className="divide-y divide-[var(--line)] text-sm text-[var(--muted)]">
        {data.sources.map(source => <div key={source.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-[var(--ink)]">{source.name}{source.official && <span className="ml-2 text-xs font-normal text-[var(--muted)]">{t('官方')}</span>}{' · '}<span role="status" className="text-xs font-normal text-[var(--muted)]">{t(sourceLabel(source.status))}</span></p>
            <p className="break-all text-xs">{source.url}</p>
          </div>
          <SettingsActions>
            <SettingsButton disabled={locked} onClick={() => change(`/sources/${encodeURIComponent(source.id)}/refresh`)}>{t('刷新源')}</SettingsButton>
            {!source.official && <SettingsButton disabled={locked} variant="danger" onClick={() => change(`/sources/${encodeURIComponent(source.id)}`, 'DELETE')}>{t('移除源')}</SettingsButton>}
          </SettingsActions>
        </div>)}
      </div>
    </SettingsSection>
    <SettingsSection title={t('构建与部署')} action={<SettingsButton disabled={locked} onClick={() => setEditing('build')}>{t('配置构建')}</SettingsButton>}>
      <div className="space-y-3 text-sm text-[var(--muted)]">
        <p>{t(data.settings.hookConfigured ? '构建触发地址已配置。' : '尚未配置构建触发地址。')}{' · '}{t(data.settings.buildTokenConfigured ? '构建访问密钥已配置。' : '尚未配置构建访问密钥。')}</p>
        {data.settings.needsReconnect && <p role="alert">{t('构建凭据无法解密，请重新填写触发地址和访问密钥。')}</p>}
        <SettingsToggle label={t('变更后自动构建')} checked={data.settings.mode === 'auto'} disabled={locked}
          info={t('仅跟随管理员确认的安装、更新和卸载；个人配置不触发构建。')}
          onChange={event => change('', 'PUT', { mode: event.target.checked ? 'auto' : 'manual' })} />
        <a href="https://github.com/arctan303/FlareTune/blob/codex/plugin-host-dev-20261108/guide/plugin-deployment.md" target="_blank" rel="noreferrer" className="inline-block text-[var(--accent)] hover:underline">{t('查看构建配置指南')}</a>
      </div>
    </SettingsSection>
    <PluginDeliveryStatus delivery={delivery} />
    {editing && <SettingsEditDialog title={t(editing === 'source' ? '添加插件源' : '配置构建')} busy={busy} onClose={close}>
      <form className="space-y-4" onSubmit={save}>
        {editing === 'source' ? <label className="block space-y-2 text-sm"><span>{t('插件目录 JSON 地址')}</span>
          <input type="url" required value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} className={inputClass} placeholder="https://example.com/repository.json" />
        </label> : <>
          <label className="block space-y-2 text-sm"><span>{t('构建触发地址')}</span>
            <input type="password" autoComplete="new-password" value={hookUrl} disabled={clearHook} onChange={event => setHookUrl(event.target.value)} className={inputClass} placeholder={t('留空保留已保存的值')} />
          </label>
          <label className="block space-y-2 text-sm"><span>{t('构建访问密钥')}</span>
            <input type="password" autoComplete="new-password" value={buildToken} onChange={event => setBuildToken(event.target.value)} className={inputClass} placeholder={t('留空保留已保存的值')} />
          </label>
          <SettingsActions>
            <SettingsButton disabled={busy} onClick={token}>{t('生成新密钥')}</SettingsButton>
            {buildToken && <SettingsButton disabled={busy} onClick={() => { void navigator.clipboard.writeText(buildToken).catch(() => {}); }}>{t('复制新密钥')}</SettingsButton>}
          </SettingsActions>
          <SettingsToggle label={t('移除已保存的触发地址')} checked={clearHook} disabled={busy} onChange={event => setClearHook(event.target.checked)} />
        </>}
        {delivery.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(delivery.error)}</p>}
        <SettingsActions><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton><SettingsButton variant="primary" type="submit" disabled={busy}>{t('保存')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
  </>;
}
