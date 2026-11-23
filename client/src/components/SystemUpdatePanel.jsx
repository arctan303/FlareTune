import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { useSystemUpdate, activeSystemUpdate, activePluginUpdate, retryableSystemUpdate } from '../hooks/useSystemUpdate.js';
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
const pluginStageLabel = build => build.resultUnknown ? '部署结果待确认' : ({
  triggering: '正在提交构建', queued: '等待构建', building: '正在构建与部署',
  deploying: '正在发布新版本', rolling_back: '正在恢复原部署', activation_pending: '部署结果待确认',
  deployed: '已部署并应用', failed: '构建未完成', cancelled: '站内任务已解除', rolled_back: '已恢复原系统部署',
}[build.status] || '系统更新状态未知');
const verificationLabel = result => ({
  pre_claim_failed: '云端构建在开始更新前失败。', build_in_progress: '云端构建正在运行。',
  upload_confirmed: '云端已上传新版本，站内更新仍待完成。',
  deployment_confirmed: '云端正在为新版本提供服务，站内更新仍待完成。',
}[result.status] || ({
  status_access_denied: '当前凭据无法读取云端状态。', status_access_unconfigured: '当前凭据无法读取云端状态。',
  deployment_changed: '当前云端部署与本次更新记录不同。',
}[result.reason] || '暂时无法确认云端状态。'));
const trustedBuildLink = /^https:\/\/dash\.cloudflare\.com\/[a-zA-Z0-9/_-]+$/u;
const isPluginResultUnconfirmed = build => Boolean(build?.resultUnknown || build?.status === 'activation_pending');
const followUpLabel = followUp => ({
  waiting: '等待开始插件更新', running: '正在更新插件', failed: '插件更新未完成',
  deployed: '插件更新已完成', awaiting_verification: '部署结果待确认',
}[followUp.status] || '系统更新状态未知');

function exceedsHost(requirement, capability) {
  return Number.isSafeInteger(requirement) && Number.isSafeInteger(capability) && requirement > capability;
}

function sameRelease(first, second) {
  return first?.id === second?.id && first?.host?.sourceDigest === second?.host?.sourceDigest;
}

function hostSupportsInstalled(data) {
  const nextCapability = data?.latest?.hostApiVersion;
  return !data?.current?.plugins?.some(plugin => exceedsHost(plugin.manifest?.hostApiVersion, nextCapability));
}

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
  const { data, loading, busy, error, demo, refresh, action, verify, verification } = update;
  const [editing, setEditing] = React.useState(false);
  const [hookUrl, setHookUrl] = React.useState('');
  const [buildToken, setBuildToken] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [selected, setSelected] = React.useState(null);
  const [selection, setSelection] = React.useState(null);
  const [formError, setFormError] = React.useState('');
  const [checking, setChecking] = React.useState(false);
  const job = data?.job;
  const active = activeSystemUpdate(job), retryable = retryableSystemUpdate(job);
  const verifying = job?.status === 'activation_pending' || active && job?.resumable === true;
  const pluginUpdates = data?.pluginUpdates;
  const candidates = pluginUpdates?.candidates || [];
  const pluginBuild = pluginUpdates?.build;
  const pluginActive = activePluginUpdate(pluginBuild);
  const pluginUnconfirmed = isPluginResultUnconfirmed(pluginBuild);
  const followUp = job?.followUp;
  const linkedBuild = !!job?.taskId && pluginBuild?.updateTaskId === job.taskId;
  const followUpIncomplete = job?.status === 'deployed' && followUp && followUp.status !== 'deployed';
  const followUpPending = followUpIncomplete && (followUp.status !== 'failed' || followUp.canContinue === true);
  const locked = busy || active || pluginActive || pluginUnconfirmed || followUpPending;
  const available = systemUpdateAvailable(data);
  const blocking = data?.blockingReason;
  const hostCompatible = hostSupportsInstalled(data);
  const canStart = available && data?.configured && !blocking && hostCompatible && data?.latest?.migration?.compatible === true;
  const canStartPlugins = pluginUpdates?.configured && !pluginUpdates.blockedReason;
  const canVerify = typeof verify === 'function' && (active || job?.status === 'failed') && !!(job?.providerBuildId || job?.receipt);
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
    if (!selected || locked || !canStart || !sameRelease(data?.latest, selected)) return;
    if (await action('/start', 'POST', { releaseId: selected.id })) setSelected(null);
  };
  const openSelection = () => setSelection({ release: available ? data.latest : null, includeHost: false,
    pluginRevision: pluginUpdates.revision, candidates, selectedIds: [] });
  const setSelectedPlugin = (id, checked) => setSelection(previous => ({ ...previous,
    selectedIds: checked ? [...previous.selectedIds, id] : previous.selectedIds.filter(value => value !== id) }));
  const selectedPlugins = selection?.candidates.filter(row => selection.selectedIds.includes(row.id)) || [];
  const chosenCapability = selection?.includeHost ? selection.release?.hostApiVersion : data?.current?.hostApiVersion;
  const pluginIncompatible = selectedPlugins.some(row => exceedsHost(row.hostApiVersion, chosenCapability));
  const selectedReleaseChanged = selection?.includeHost && !sameRelease(data?.latest, selection.release);
  const selectionChanged = !!selection && (selectedReleaseChanged || selectedPlugins.length > 0 && pluginUpdates?.revision !== selection.pluginRevision);
  const canSubmitSelection = !!selection && !locked && !selectionChanged && !pluginIncompatible
    && (selection.includeHost || selectedPlugins.length > 0) && (!selection.includeHost || canStart)
    && (!selectedPlugins.length || canStartPlugins);
  const startSelection = async event => {
    event.preventDefault();
    if (!canSubmitSelection) return;
    const body = { releaseId: selection.includeHost ? selection.release.id : null };
    if (selectedPlugins.length) {
      body.pluginRevision = selection.pluginRevision;
      body.plugins = selectedPlugins.map(({ id, sourceId, version }) => ({ id, sourceId, version }));
      body.trustCode = true;
    }
    if (await action('/start', 'POST', body)) setSelection(null);
  };
  if (demo) return <SettingsSection title={t('系统更新')}><p className="text-sm text-[var(--muted)]">{t('演示模式不连接真实更新通道。')}</p></SettingsSection>;
  if (!data) return loading ? <SettingsSkeleton cards={1} rows={2} label="正在读取系统更新…" /> : <SettingsSection title={t('系统更新')}>
    <p role="alert" className="text-sm text-[var(--danger)]">{t(error || '无法读取系统更新状态。')}</p>
    <SettingsActions><SettingsButton disabled={loading || busy} onClick={() => void refresh()}>{t('重试')}</SettingsButton></SettingsActions>
  </SettingsSection>;
  const candidate = data.latest?.channel === 'candidate';
  const releaseForNotes = selected || (selection?.includeHost ? selection.release : null);
  const selectedNotes = releaseForNotes?.notes?.[locale === 'zh' || locale === 'zh-Hant' ? 'zh' : 'en']
    || releaseForNotes?.notes?.en || releaseForNotes?.notes?.zh || '';
  const selectedChanged = selected && !sameRelease(data.latest, selected);
  const jobError = job?.error?.code || job?.error;
  const promotionRejected = job?.status === 'activation_pending' && jobError === 'SYSTEM_UPDATE_PROMOTION_REJECTED';
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
        {available && !blocking && !hostCompatible && <p role="status" className="text-[var(--muted)]">{t('此版本与已安装插件不兼容，请先核对插件版本。')}</p>}
        {error && <p role="alert" className="text-[var(--danger)]">{t(error)}</p>}
        {!!candidates.length && <div className="space-y-1 border-t border-[var(--line)] pt-3">
          <p className="font-medium">{t('可更新的插件')}</p>
          <ul className="space-y-1 text-[var(--muted)]">
            {candidates.map(row => <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 break-words">
              <span>{row.name || row.id}</span><span>{row.currentVersion}{' → '}{row.version}</span>
            </li>)}
          </ul>
          {!canStartPlugins && <p role="status" className="text-[var(--muted)]">{t(pluginUpdates.blockedReason
            ? systemUpdateErrorMessage(pluginUpdates.blockedReason) : '请先配置构建触发地址和构建访问密钥。')}</p>}
        </div>}
        {job && <div className="space-y-2 border-t border-[var(--line)] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{t('最近系统更新')}{job.target?.version && ` · ${job.target.version}`}</span>
            <span role="status" aria-live="polite" className={job.status === 'failed' || promotionRejected ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}>
              {t(promotionRejected ? '发布被拒绝' : stageLabel(job.status))}
            </span>
          </div>
          {job.status === 'activation_pending' && !promotionRejected && <p className="text-[var(--muted)]">{t('部署结果尚未确认，当前目标已锁定。继续核实同一任务不会创建新的升级目标。')}</p>}
          {job.resumable === true && active && job.status !== 'activation_pending' && <p className="text-[var(--muted)]">{t('更新暂时没有继续推进，可继续核实同一任务。')}</p>}
          {job.status === 'rolled_back' && <p className="text-[var(--muted)]">{t('原系统部署已恢复，数据不会随代码自动回退。')}</p>}
          {jobError && (job.status === 'failed' || promotionRejected) && <p role="alert" className="text-[var(--danger)]">{t(systemUpdateErrorMessage(jobError))}</p>}
          {job.status === 'deployed' && !followUpPending && <p className="text-[var(--muted)]">{t('新版本已核验，可重新加载网页。')}</p>}
          {verification?.busy && <p role="status" className="text-[var(--muted)]">{t('正在核实更新状态…')}</p>}
          {verification?.error && <p role="alert" className="text-[var(--danger)]">{t(verification.error)}</p>}
          {verification?.result && <div className="space-y-1 text-[var(--muted)]">
            <p role="status">{t(verificationLabel(verification.result))}</p>
            {trustedBuildLink.test(verification.result.buildUrl || '') && <a className="underline underline-offset-2"
              href={verification.result.buildUrl} target="_blank" rel="noopener noreferrer">{t('在 Cloudflare 查看构建')}</a>}
          </div>}
          <SettingsActions>
            {retryable && <SettingsButton disabled={busy} onClick={() => void action('/retry', 'POST', { taskId: job.taskId })}>{t(verifying && !promotionRejected ? '继续核实更新' : '重试本次更新')}</SettingsButton>}
            {canVerify && <SettingsButton disabled={busy || verification?.busy} onClick={() => void verify(job.taskId)}>{t('核对云端状态')}</SettingsButton>}
            {active && <SettingsButton disabled={busy || loading} onClick={() => void refresh()}>{t('刷新状态')}</SettingsButton>}
            {job.status === 'deployed' && !followUpPending && <SettingsButton onClick={() => window.location.reload()}>{t('重新加载网页')}</SettingsButton>}
          </SettingsActions>
        </div>}
        {followUp && <div className="space-y-2 border-t border-[var(--line)] pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{t('本次选中的插件')}</p>
            <p role="status" aria-live="polite" className="text-[var(--muted)]">{t(followUp.status === 'running' && linkedBuild
              ? pluginStageLabel(pluginBuild) : followUpLabel(followUp))}</p>
          </div>
          <ul className="space-y-1 text-[var(--muted)]">{followUp.plugins.map(row => <li key={row.id} className="break-words">
            {candidates.find(candidate => candidate.id === row.id)?.name
              || data.current?.plugins?.find(plugin => plugin.id === row.id)?.manifest?.name || row.id}{' · '}{row.version}
          </li>)}</ul>
          {(followUp.error || linkedBuild && pluginBuild.error || followUp.status === 'awaiting_verification') && <p role="alert" className="text-[var(--danger)]">
            {t(followUp.status === 'awaiting_verification' ? '请先核实远端构建结果，再修改待应用变更。'
              : systemUpdateErrorMessage(followUp.error || pluginBuild.error))}
          </p>}
          {job.status === 'deployed' && followUp.canContinue === true && followUp.status !== 'awaiting_verification' && <SettingsActions>
            <SettingsButton disabled={busy || pluginActive || pluginUnconfirmed}
              onClick={() => void action('/continue', 'POST', { taskId: job.taskId })}>{t('继续更新插件')}</SettingsButton>
          </SettingsActions>}
        </div>}
        {pluginBuild && !linkedBuild && <div className="space-y-2 border-t border-[var(--line)] pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{t('最近插件更新')}</p>
            <p role="status" aria-live="polite" className="text-[var(--muted)]">{t(pluginStageLabel(pluginBuild))}</p>
          </div>
          {(pluginBuild.error || pluginUnconfirmed) && <p role="alert" className="text-[var(--danger)]">{t(pluginUnconfirmed
            ? '请先核实远端构建结果，再修改待应用变更。' : systemUpdateErrorMessage(pluginBuild.error))}</p>}
          {trustedBuildLink.test(pluginBuild.buildUrl || '') && <a className="underline underline-offset-2"
            href={pluginBuild.buildUrl} target="_blank" rel="noopener noreferrer">{t('在 Cloudflare 查看构建')}</a>}
          {pluginBuild.retryable && !pluginUnconfirmed && <SettingsActions>
            <SettingsButton disabled={locked} onClick={() => void action('/plugin-retry', 'POST', { buildId: pluginBuild.id,
              pluginRevision: pluginUpdates.revision })}>{t('继续更新插件')}</SettingsButton>
          </SettingsActions>}
        </div>}
        <SettingsActions>
          <SettingsButton disabled={locked || loading} onClick={() => void check()}>{t(checking ? '正在检查更新…' : '检查更新')}</SettingsButton>
          {!active && (pluginActive || pluginUnconfirmed || followUpPending) && <SettingsButton disabled={busy || loading}
            onClick={() => void refresh()}>{t('刷新状态')}</SettingsButton>}
          {candidates.length > 0 ? <SettingsButton variant="primary" disabled={locked || !(canStart || canStartPlugins)}
            onClick={openSelection}>{t('选择更新')}</SettingsButton>
            : available && <SettingsButton variant="primary" disabled={locked || !canStart}
              onClick={() => setSelected(data.latest)}>{t('升级系统')}</SettingsButton>}
          {!available && !candidates.length && data.latest && !locked && <span role="status" className="text-xs text-[var(--muted)]">{t('未发现可升级版本')}</span>}
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
    {selection && <SettingsEditDialog title={t('确认本次更新')} busy={busy} onClose={() => setSelection(null)} message={error}>
      <form onSubmit={startSelection} className="space-y-4">
        {selection.release && <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--accent)]" checked={selection.includeHost}
            disabled={locked || !canStart && !selection.includeHost}
            onChange={event => setSelection(previous => ({ ...previous, includeHost: event.target.checked }))} />
          <span className="min-w-0 break-words">{t('基础服务')}{' · '}{data.current?.version || t('未知')}{' → '}{selection.release.version}</span>
        </label>}
        {selection.release && !hostCompatible && <p role="status" className="text-sm text-[var(--muted)]">
          {t('此版本与已安装插件不兼容，请先核对插件版本。')}</p>}
        <fieldset className="space-y-1 border-t border-[var(--line)] pt-2" disabled={locked}>
          <legend className="text-sm font-semibold">{t('可更新的插件')}</legend>
          {selection.candidates.map(row => {
            const chosen = selection.selectedIds.includes(row.id);
            const needsHost = exceedsHost(row.hostApiVersion, chosenCapability);
            return <label key={row.id} className="flex min-h-11 items-start gap-3 py-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]" checked={chosen}
                disabled={locked || !chosen && (!canStartPlugins || needsHost)} onChange={event => setSelectedPlugin(row.id, event.target.checked)} />
              <span className="min-w-0 break-words">
                <span>{row.name || row.id}{' · '}{row.currentVersion}{' → '}{row.version}</span>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">{row.sourceName || row.sourceId}</span>
                {row.sourceUrl && <span className="mt-0.5 block break-all text-xs text-[var(--muted)]">{row.sourceUrl}</span>}
                {needsHost && <span className="mt-0.5 block text-xs text-[var(--muted)]">{t('此插件需要较新的基础服务。')}</span>}
              </span>
            </label>;
          })}
        </fieldset>
        {selection.includeHost && selection.release.channel === 'candidate' && <p role="status" className="text-sm text-[var(--muted)]">
          {t('这是为本实例确认的待发布版本，尚未正式发布。')}
        </p>}
        {selectedNotes && <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{selectedNotes}</div>}
        {!!selectedPlugins.length && <p className="text-sm text-[var(--muted)]">{t('确认即表示信任所选来源，插件代码将在此站点执行。')}</p>}
        {selection.includeHost && !!selectedPlugins.length && <p className="text-sm text-[var(--muted)]">{t('基础服务验证完成后，将继续更新所选插件。')}</p>}
        {selection.includeHost && <p className="text-sm text-[var(--muted)]">{t('更新期间可能短时暂停服务。任务开始后，关闭网页不会取消更新。')}</p>}
        {selectionChanged && <p role="alert" className="text-sm text-[var(--danger)]">{t('可用版本已变化，请重新检查更新。')}</p>}
        <SettingsActions><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={!canSubmitSelection}>{t(busy ? '正在提交更新…' : '确认升级')}</SettingsButton>
        </SettingsActions>
      </form>
    </SettingsEditDialog>}
  </>;
}

export default function SystemUpdatePanel({ session }) {
  const update = useSystemUpdate(session);
  if (!session?.authenticated || session.mustChangePassword || session.user?.role !== 'admin') return null;
  return <SystemUpdateView key={`${session.user.accountId}:${session.csrfToken}`} update={update} />;
}
