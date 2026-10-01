import React from 'react';
import SelectControl from './SelectControl.jsx';
import { t } from '../i18n/index.js';
import { getAiProviders, createAiProvider, updateAiProvider, deleteAiProvider, getAiProviderModels, saveAiFeatureModel } from '../instance/adminApi.js';
import { AI_PROTOCOLS, AI_SOURCES } from '../../../shared/aiProtocols.js';
import { providerDraft, changeProviderSource, providerNeedsKey, providerLabel, featureDraft, changeFeatureProvider, changeFeatureModel, modelListError } from '../services/aiProviderDraft.js';

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const buttonClass = 'primary-button min-h-11 rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-50';
const cardClass = 'wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4';
const sectionClass = 'wallpaper-content-surface space-y-4 rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-5 shadow-xs sm:p-7';

function FeatureModelCard({ feature, label, data, csrfToken, refresh }) {
  const assignment = data.features[feature];
  const [draft, setDraft] = React.useState(() => featureDraft(assignment));
  const [models, setModels] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const requestRef = React.useRef(0);
  const modelFieldRef = React.useRef(null);
  const provider = data.providers.find(item => item.id === draft.providerId);
  React.useEffect(() => { setDraft(featureDraft(assignment)); }, [assignment.revision]);
  React.useEffect(() => {
    requestRef.current += 1; setModels([]); setLoading(false);
    return () => { requestRef.current += 1; };
  }, [draft.providerId, provider?.revision]);
  const disabled = !data.ready || saving;
  async function readModels() {
    const requestId = ++requestRef.current;
    setLoading(true); setMessage('');
    try {
      const result = await getAiProviderModels(provider.id, provider.revision, csrfToken);
      if (requestId !== requestRef.current) return;
      setModels(result.models);
      if (!result.models.length || result.hasMore) setMessage('列表为空或未列出全部模型，仍可手动填写模型 ID。');
    } catch (error) { if (requestId === requestRef.current) setMessage(modelListError(error)); }
    finally { if (requestId === requestRef.current) setLoading(false); }
  }
  async function save(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      await saveAiFeatureModel({ feature, ...draft, providerId: draft.providerId || null, expectedRevision: assignment.revision, providerRevision: provider?.revision || 0 }, csrfToken);
      await refresh(); setMessage('功能使用方案已保存。');
    } catch (error) { setMessage(error?.status === 409 ? '配置已更新，请刷新后确认再保存。' : '功能使用方案保存失败，请检查填写内容。'); }
    finally { setSaving(false); }
  }
  return <form onSubmit={save} className={`${cardClass} space-y-3`}>
    <h3 className="text-sm font-semibold text-[var(--ink)]">{t(label)}</h3>
    <label className="block space-y-1 text-xs font-semibold">{t('供应商')}<SelectControl aria-label={`${t(label)} ${t('供应商')}`} className={inputClass} disabled={disabled} value={draft.providerId} onChange={event => { requestRef.current += 1; setDraft(changeFeatureProvider(draft, event.target.value)); setMessage(''); }}>
      <option value="">{t('原有部署配置')}</option>{data.providers.map(item => <option value={item.id} key={item.id}>{providerLabel(item)} · {item.source === 'custom' ? t('自定义供应商') : AI_SOURCES[item.source].name}{!item.hasKey ? ` · ${t('密钥需重新录入')}` : ''}</option>)}
    </SelectControl></label>
    {draft.providerId && <>
      <div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold">{t('模型')}</span><button type="button" className="min-h-11 text-xs text-[var(--accent)] disabled:opacity-50" disabled={disabled || loading || !provider?.hasKey} onClick={() => void readModels()}>{loading ? t('正在获取模型…') : t('获取模型')}</button></div>
      <div ref={modelFieldRef} className="model-input">
        <input aria-label={`${t(label)} ${t('模型 ID')}`} className={`${inputClass}${models.length ? ' pr-12' : ''}`} required maxLength={160} disabled={disabled} value={draft.model} onChange={event => setDraft(changeFeatureModel(draft, event.target.value))} placeholder={t('获取模型后选择，或手动填写模型 ID')} />
        {models.length > 0 && <SelectControl aria-label={`${t(label)} ${t('选择模型')}`} className="model-input__choices" menuAnchorRef={modelFieldRef} disabled={disabled} value={models.includes(draft.model) ? draft.model : ''} onChange={event => setDraft(changeFeatureModel(draft, event.target.value))}>
          <option value="" disabled>{t('选择模型')}</option>{models.map(model => <option key={model} value={model}>{model}</option>)}
        </SelectControl>}
      </div>
      <label className="flex min-h-11 w-full items-center justify-between gap-3 text-sm text-[var(--ink)]"><span>{t('此模型支持视觉')}</span><input type="checkbox" role="switch" className="settings-switch" disabled={disabled || !draft.model.trim()} checked={draft.supportsImages} onChange={event => setDraft({ ...draft, supportsImages: event.target.checked })} /></label>
      <p className="text-xs text-[var(--muted)]">{t('仅对当前模型声明视觉能力；更换模型后需重新确认。')}</p>
    </>}
    <button type="submit" className={buttonClass} disabled={disabled || Boolean(draft.providerId && (!provider || !draft.model.trim()))}>{saving ? t('保存中…') : t('保存配置')}</button>
    {message && <p role="status" className="text-xs text-[var(--muted)]">{t(message)}</p>}
  </form>;
}

export default function AiProfilesPanel({ csrfToken }) {
  const [data, setData] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const dialogRef = React.useRef(null);
  const existing = editing?.provider || null;
  const needsKey = draft && providerNeedsKey(draft, existing);
  const refresh = React.useCallback(async () => { const result = await getAiProviders(csrfToken); setData(result); }, [csrfToken]);
  React.useEffect(() => { void refresh().catch(() => setMessage('供应商配置暂时无法读取，请确认开发 Worker 已更新。')); }, [refresh]);
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (editing && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [editing]);
  function startEdit(source, provider = null) { setMessage(''); setDraft(providerDraft(source, provider)); setEditing({ source, provider }); }
  const closeEditor = () => { setEditing(null); setDraft(null); };
  async function saveProvider(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (existing) await updateAiProvider(existing.id, draft, existing.revision, csrfToken);
      else await createAiProvider(draft, csrfToken);
      closeEditor(); await refresh(); setMessage('供应商已保存。');
    } catch (error) { setMessage(error?.code === 'ai_provider_migration_required' ? '请先在实例设置中升级数据库。'
      : error?.code === 'setup_secret_unavailable' ? '请先配置实例的初始化密钥（SETUP_SECRET）。'
        : error?.code === 'ai_profile_key_required' ? '连接发生变化或密钥已失效，请重新输入 API Key。'
          : error?.status === 409 ? '供应商已更新，请刷新后重试。' : '供应商保存失败，请检查填写内容。'); }
    finally { setBusy(false); }
  }
  async function remove(provider) {
    if (!window.confirm(`${t('删除供应商')}“${provider.name}”？`)) return;
    setBusy(true); setMessage('');
    try { await deleteAiProvider(provider.id, provider.revision, csrfToken); await refresh(); setMessage('供应商已删除。'); }
    catch (error) { setMessage(error?.status === 409 ? '供应商正在使用或已更新，请先切换对应功能或刷新。' : '删除失败，请刷新后重试。'); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    <section className={sectionClass}>
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-bold text-[var(--ink)]">{t('供应商配置')}</h2><button type="button" className={buttonClass} disabled={busy || !data?.ready} onClick={() => startEdit('deepseek')}>{t('添加供应商')}</button></div>
      {data && !data.credentialReady && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{t('请先配置实例的初始化密钥（SETUP_SECRET）。')}</p>}
      {data?.ready === false && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{t('请先在实例设置中升级数据库。旧配置仍可继续使用。')}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data?.providers.map(provider => <div key={provider.id} className={`${cardClass} space-y-3`}>
          <strong className="block break-words text-sm text-[var(--ink)]">{providerLabel(provider)}</strong>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]"><span>{provider.source === 'custom' ? t('自定义供应商') : AI_SOURCES[provider.source].name}</span><span>{provider.hasKey ? t('密钥已配置') : t('密钥需重新录入')}</span></div>
          <div className="flex gap-3 text-xs"><button type="button" className="min-h-11 text-[var(--accent)] disabled:opacity-50" disabled={busy || !data?.ready} onClick={() => startEdit(provider.source, provider)}>{t('编辑')}</button><button type="button" className="min-h-11 text-[var(--muted)] disabled:opacity-50" disabled={busy || !data?.ready} onClick={() => void remove(provider)}>{t('删除')}</button></div>
        </div>)}
      </div>
      {data && !data.providers.length && <p className="text-xs text-[var(--muted)]">{t('尚未添加供应商，点击“添加供应商”开始配置。')}</p>}
    </section>
    <section className={sectionClass}>
      <h2 className="text-base font-bold text-[var(--ink)]">{t('功能使用方案')}</h2>
      <div className="grid gap-4 lg:grid-cols-2">{data && [['assistant', '音乐助手'], ['lyrics', '歌词 AI']].map(([feature, label]) => <FeatureModelCard key={feature} feature={feature} label={label} data={data} csrfToken={csrfToken} refresh={refresh} />)}</div>
    </section>
    {message && !editing && <p role="status" className="text-sm text-[var(--muted)]">{t(message)}</p>}
    {editing && <dialog ref={dialogRef} aria-label={t('配置供应商')} onCancel={event => { event.preventDefault(); if (!busy) closeEditor(); }} className="w-[min(92vw,32rem)] max-h-[85vh] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-0 text-[var(--ink)] shadow-2xl backdrop:bg-black/45">
      <form onSubmit={saveProvider} className="max-h-[85vh] space-y-4 overflow-y-auto p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{existing ? t('编辑供应商') : t('添加供应商')}</h3><button type="button" onClick={closeEditor} disabled={busy} className="min-h-11 text-sm text-[var(--muted)]">{t('关闭')}</button></div>
        <label className="block space-y-1 text-xs font-semibold">{t('接入方案')}<SelectControl aria-label={t('接入方案')} className={inputClass} disabled={busy || Boolean(existing)} value={draft.source} onChange={event => setDraft(changeProviderSource(draft, event.target.value))}>{Object.entries(AI_SOURCES).map(([source, preset]) => <option key={source} value={source}>{source === 'custom' ? t('自定义供应商') : preset.name}</option>)}</SelectControl></label>
        <label className="block space-y-1 text-xs font-semibold">{t('显示名称')}<input className={inputClass} disabled={busy} maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder={draft.source === 'custom' ? t('自定义供应商') : AI_SOURCES[draft.source].name} /></label>
        {draft.source === 'custom' && <>
          <label className="block space-y-1 text-xs font-semibold">{t('API 协议')}<SelectControl aria-label={t('API 协议')} className={inputClass} value={draft.protocol} onChange={event => setDraft({ ...draft, protocol: event.target.value, apiKey: '' })}>{Object.entries(AI_PROTOCOLS).map(([protocol, label]) => <option key={protocol} value={protocol}>{t(label)}</option>)}</SelectControl></label>
          <label className="block space-y-1 text-xs font-semibold">{t('API 基础地址')}<input className={inputClass} type="url" required maxLength={2048} value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://example.com/v1" /><span className="block font-normal text-[var(--muted)]">{t('填写 HTTPS 基础地址，包含版本前缀，不包含具体请求路径。')}</span></label>
        </>}
        <label className="block space-y-1 text-xs font-semibold">API Key<input className={inputClass} type="password" autoComplete="new-password" required={needsKey} maxLength={4096} value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={needsKey ? t('请输入 API Key') : t('留空保留已保存的密钥')} /></label>
        <div className="flex gap-3"><button type="submit" className={buttonClass} disabled={busy}>{busy ? t('保存中…') : t('保存配置')}</button><button type="button" disabled={busy} onClick={closeEditor} className="min-h-11 rounded-xl px-4 py-2 text-xs text-[var(--muted)]">{t('取消')}</button></div>
        {message && <p role="alert" className="text-sm text-rose-600">{t(message)}</p>}
      </form>
    </dialog>}
  </div>;
}
