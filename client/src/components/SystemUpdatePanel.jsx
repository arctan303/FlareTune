import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { useSystemUpdate, activeSystemUpdate, retryableSystemUpdate } from '../hooks/useSystemUpdate.js';
import { systemUpdateErrorMessage } from '../services/systemUpdate.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import SettingsSkeleton from './SettingsSkeleton.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';

const inputClass = 'settings-field w-full';
const stageLabel = status => ({
  queued: '等待更新构建', building: '正在构建更新', backup: '正在建立恢复点', uploaded: '新版本已准备，等待发布',
  deploying: '正在发布系统更新', migrating: '正在完成数据库更新', verifying: '正在核验新版本',
  deployed: '系统更新已完成', activation_pending: '系统更新结果待确认', rolling_back: '正在恢复原系统部署',
  rolled_back: '已恢复原系统部署', failed: '系统更新未完成',
}[status] || '系统更新状态未知');

export function systemUpdateAvailable(data) {
  const target = data?.latest, current = data?.current;
  if (!target?.id || !target?.version || !current?.version) return false;
  const next = target.version.split('.').map(Number), before = current.version.split('.').map(Number);
  if (next.length !== 3 || before.length !== 3 || [...next, ...before].some(value => !Number.isSafeInteger(value) || value < 0)) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== before[index]) return next[index] > before[index];
  }
  return target.channel === 'candidate' && target.host?.sourceDigest !== current.sourceDigest;
}

export function SystemUpdateView({ update }) {
  const locale = useLocale();
  const { data, loading, busy, error, demo, refresh, action } = update;
  const [editing, setEditing] = React.useState(false);
  const [hookUrl, setHookUrl] = React.useState('');
  const [buildToken, setBuildToken] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [selected, setSelected] = React.useState(null);
  const [formError, setFormError] = React.useState('');
  const [checking, setChecking] = React.useState(false);
  const job = data?.job;
  const active = activeSystemUpdate(job), retryable = retryableSystemUpdate(job);
  const verifying = job?.status === 'activation_pending' || active && job?.resumable === true;
  const locked = busy || active;
  const available = systemUpdateAvailable(data);
  const blocking = data?.blockingReason;
  const canStart = available && data?.configured && !blocking && data?.latest?.migration?.compatible === true;
  const openConfiguration = () => { setHookUrl(''); setBuildToken(''); setCopied(false); setFormError(''); setEditing(true); };
  const closeConfiguration = () => { setEditing(false); setHookUrl(''); setBuildToken(''); setCopied(false); setFormError(''); };
  const save = async event => {
    event.preventDefault();
    if (busy || active) return;
    const body = {};
    if (hookUrl.trim()) body.deployHookUrl = hookUrl.trim();
    if (buildToken.trim()) body.buildToken = buildToken.trim();
    if ((!data?.configuration?.hookConfigured && !body.deployHookUrl) || (!data?.configuration?.tokenConfigured && !body.buildToken)) {
      setFormError('请填写构建触发地址和访问密钥。'); return;
    }
    if (await action('', 'PUT', body)) closeConfiguration();
  };
  const generate = () => {
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    setBuildToken(Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')); setCopied(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(buildToken); setCopied(true); }
    catch { setFormError('无法复制，请手动复制新密钥。'); }
  };
  const check = async () => {
    setChecking(true);
    try { await action('/check'); } finally { setChecking(false); }
  };
  const start = async event => {
    event.preventDefault();
    if (!selected || locked || !canStart || data?.latest?.id !== selected.id) return;
    if (await action('/start', 'POST', { releaseId: selected.id })) setSelected(null);
  };
  if (demo) return <SettingsSection title={t('系统更新')}><p className="text-sm text-[var(--muted)]">{t('演示模式不连接真实更新通道。')}</p></SettingsSection>;
  if (!data) return loading ? <SettingsSkeleton cards={1} rows={2} label="正在读取系统更新…" /> : <SettingsSection title={t('系统更新')}>
    <p role="alert" className="text-sm text-[var(--danger)]">{t(error || '无法读取系统更新状态。')}</p>
    <SettingsActions><SettingsButton disabled={loading || busy} onClick={() => void refresh()}>{t('重试')}</SettingsButton></SettingsActions>
  </SettingsSection>;
  const candidate = data.latest?.channel === 'candidate';
  const selectedNotes = selected?.notes?.[locale === 'zh' || locale === 'zh-Hant' ? 'zh' : 'en'] || selected?.notes?.en || selected?.notes?.zh || '';
  const selectedChanged = selected && data.latest?.id !== selected.id;
  const jobError = job?.error?.code || job?.error;
  return <>
    <SettingsSection title={t('系统更新')} meta={loading ? t('正在刷新…') : null}
      action={<SettingsButton disabled={locked} onClick={openConfiguration}>{t('配置更新通道')}</SettingsButton>}>
      <div className="space-y-4 text-sm">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs text-[var(--muted)]">{t('当前系统版本')}</dt><dd className="mt-1 font-medium text-[var(--ink)]">{data.current?.version ? `FlareTune ${data.current.version}` : t('未知')}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">{t(candidate ? '待正式发布版本' : '最新稳定版本')}</dt>
            <dd className="mt-1 font-medium text-[var(--ink)]">{data.latest?.version ? `FlareTune ${data.latest.version}` : t('尚未检查')}</dd></div>
        </dl>
        <p className="text-[var(--muted)]">{t(data.configured ? '更新通道已配置' : '更新通道尚未配置')}</p>
        {!data.configured && <p className="text-[var(--muted)]">{t('完成一次通道配置后，即可在这里确认系统升级。')}</p>}
        {blocking && <p role="status" className="text-[var(--muted)]">{t(systemUpdateErrorMessage(blocking))}</p>}
        {error && <p role="alert" className="text-[var(--danger)]">{t(error)}</p>}
        {job && <div className="space-y-2 border-t border-[var(--line)] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{t('最近系统更新')}{job.target?.version && ` · ${job.target.version}`}</span>
            <span role="status" aria-live="polite" className={job.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}>{t(stageLabel(job.status))}</span>
          </div>
          {job.status === 'activation_pending' && <p className="text-[var(--muted)]">{t('部署结果尚未确认，当前目标已锁定。继续核实同一任务不会创建新的升级目标。')}</p>}
          {job.resumable === true && active && job.status !== 'activation_pending' && <p className="text-[var(--muted)]">{t('更新暂时没有继续推进，可继续核实同一任务。')}</p>}
          {job.status === 'rolled_back' && <p className="text-[var(--muted)]">{t('原系统部署已恢复，数据不会随代码自动回退。')}</p>}
          {jobError && job.status === 'failed' && <p role="alert" className="text-[var(--danger)]">{t(systemUpdateErrorMessage(jobError))}</p>}
          {job.status === 'deployed' && <p className="text-[var(--muted)]">{t('新版本已核验，可重新加载网页。')}</p>}
          <SettingsActions>
            {retryable && <SettingsButton disabled={busy} onClick={() => void action('/retry', 'POST', { taskId: job.taskId })}>{t(verifying ? '继续核实更新' : '重试本次更新')}</SettingsButton>}
            {active && <SettingsButton disabled={busy || loading} onClick={() => void refresh()}>{t('刷新状态')}</SettingsButton>}
            {job.status === 'deployed' && <SettingsButton onClick={() => window.location.reload()}>{t('重新加载网页')}</SettingsButton>}
          </SettingsActions>
        </div>}
        <SettingsActions>
          <SettingsButton disabled={locked || loading} onClick={() => void check()}>{t(checking ? '正在检查更新…' : '检查更新')}</SettingsButton>
          {available && <SettingsButton variant="primary" disabled={locked || !canStart}
            onClick={() => setSelected(data.latest)}>{t('升级系统')}</SettingsButton>}
          {!available && data.latest && !active && <span role="status" className="text-xs text-[var(--muted)]">{t('未发现可升级版本')}</span>}
          {error && <SettingsButton disabled={busy || loading} onClick={() => void refresh()}>{t('刷新状态')}</SettingsButton>}
        </SettingsActions>
      </div>
    </SettingsSection>
    {editing && <SettingsEditDialog title={t('配置更新通道')} busy={busy} onClose={closeConfiguration} message={formError || error}>
      <form onSubmit={save} className="space-y-4">
        <label className="block space-y-2 text-sm"><span>{t('构建触发地址')}</span>
          <input className={inputClass} type="password" autoComplete="new-password" value={hookUrl} disabled={busy}
            placeholder={t('留空保留已保存的值')} onChange={event => { setHookUrl(event.target.value); setFormError(''); }} /></label>
        <label className="block space-y-2 text-sm"><span>{t('构建访问密钥')}</span>
          <input className={inputClass} type="password" autoComplete="new-password" value={buildToken} disabled={busy}
            placeholder={t('留空保留已保存的值')} onChange={event => { setBuildToken(event.target.value); setCopied(false); setFormError(''); }} /></label>
        <SettingsActions><SettingsButton disabled={busy} onClick={generate}>{t('生成新密钥')}</SettingsButton>
          {buildToken && <SettingsButton disabled={busy} onClick={() => void copy()}>{t(copied ? '新密钥已复制' : '复制新密钥')}</SettingsButton>}</SettingsActions>
        <p className="text-xs text-[var(--muted)]">{t('保存通道不会启动升级。新密钥还需在构建环境中配置。')}</p>
        <SettingsActions><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={locked}>{t('保存')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
    {selected && <SettingsEditDialog title={t('确认系统升级')} busy={busy} onClose={() => setSelected(null)} message={error}>
      <form onSubmit={start} className="space-y-4">
        <p className="text-base font-semibold">{data.current?.version || t('未知')}{' → '}{selected.version}</p>
        {selected.channel === 'candidate' && <p role="status" className="text-sm text-[var(--muted)]">{t('这是为本实例确认的待发布版本，尚未正式发布。')}</p>}
        {selectedNotes && <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{selectedNotes}</div>}
        <p className="text-sm text-[var(--muted)]">{t('升级保留已安装插件的版本、配置和数据；不会顺带安装或更新插件。')}</p>
        <p className="text-sm text-[var(--muted)]">{t('更新期间可能短时暂停服务。任务开始后，关闭网页不会取消更新。')}</p>
        {selectedChanged && <p role="alert" className="text-sm text-[var(--danger)]">{t('可用版本已变化，请重新检查更新。')}</p>}
        <SettingsActions><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={locked || !canStart || !!selectedChanged}>{t(busy ? '正在提交更新…' : '确认升级')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
  </>;
}

export default function SystemUpdatePanel({ session }) {
  const update = useSystemUpdate(session);
  if (!session?.authenticated || session.mustChangePassword || session.user?.role !== 'admin') return null;
  return <SystemUpdateView key={`${session.user.accountId}:${session.csrfToken}`} update={update} />;
}
