import { t } from '../i18n/index.js';
import React from 'react';
import { assignAiProfile, createAiProfile, deleteAiProfile, getAiProfiles,
  updateAiProfile } from '../instance/adminApi.js';

const providerNames = { deepseek: 'DeepSeek', openai: 'OpenAI', gemini: 'Gemini',
  compatible: '标准兼容接口' };
const emptyDraft = { name: '', provider: 'deepseek', model: '', baseUrl: '', apiKey: '' };
const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const buttonClass = 'primary-button rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-50';

export default function AiProfilesPanel({ csrfToken }) {
  const [data, setData] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [draft, setDraft] = React.useState(emptyDraft);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const dialogRef = React.useRef(null);
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (editing && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [editing]);

  const refresh = React.useCallback(async () => {
    try { setData(await getAiProfiles(csrfToken)); }
    catch { setMessage(t("模型方案暂时无法读取，请确认数据库迁移已应用。")); }
  }, [csrfToken]);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const startEdit = (profile = null) => {
    setMessage('');
    setEditing(profile || 'new');
    setDraft(profile ? { name: profile.name, provider: profile.provider,
      model: profile.model, baseUrl: profile.baseUrl, apiKey: '' } : { ...emptyDraft });
  };

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      if (editing === 'new') await createAiProfile(draft, csrfToken);
      else await updateAiProfile(editing.id, draft, editing.revision, csrfToken);
      setEditing(null);
      setDraft({ ...emptyDraft });
      await refresh();
      setMessage(t("模型方案已保存。"));
    } catch (error) {
      setMessage(error?.code === 'setup_secret_unavailable'
        ? '实例缺少 SETUP_SECRET，请先为开发 Worker 配置。'
        : error?.code === 'ai_profile_key_required'
          ? '更换服务商、API 地址或密钥已失效时，请重新输入 API Key。'
        : error?.status === 409 ? '方案已更新，请刷新后重试。' : '模型方案保存失败，请检查填写内容。');
    } finally { setBusy(false); }
  }

  async function remove(profile) {
    if (!window.confirm(`删除模型方案“${profile.name}”？`)) return;
    setBusy(true);
    setMessage('');
    try {
      await deleteAiProfile(profile.id, profile.revision, csrfToken);
      await refresh();
      setMessage(t("模型方案已删除。"));
    } catch (error) {
      setMessage(error?.status === 409 ? '该方案正在使用，先为对应功能选择其他方案。' : '删除失败，请刷新后重试。');
    } finally { setBusy(false); }
  }

  async function assign(feature, profileId) {
    setBusy(true);
    setMessage('');
    try {
      await assignAiProfile(feature, profileId || null,
        data?.assignments[feature]?.revision || 0, csrfToken);
      await refresh();
      setMessage(t("功能使用方案已更新。"));
    } catch { setMessage(t("切换失败，请刷新后重试。")); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    <section className="wallpaper-content-surface space-y-4 rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-5 shadow-xs sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-bold text-[var(--ink)]">{t("模型方案")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">{t("密钥保存后不再回显。")}</p></div>
        <button type="button" className={buttonClass} onClick={() => startEdit()} disabled={busy}>{t("创建方案")}</button>
      </div>
      {data && !data.credentialReady && <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">{t("实例尚未配置 SETUP_SECRET，创建方案前需在开发 Worker 中设置它。")}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {data?.profiles.length ? data.profiles.map((profile) => <div key={profile.id} className="wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><strong className="block truncate text-sm text-[var(--ink)]">{profile.name}</strong><span className="text-xs text-[var(--muted)]">{providerNames[profile.provider]} · {profile.model}</span></div><span className="shrink-0 text-xs text-[var(--muted)]">{profile.hasKey ? t("密钥已配置") : t("密钥需重新录入")}</span></div>
          {profile.baseUrl && <p className="mt-2 break-all text-xs text-[var(--muted)]">{profile.baseUrl}</p>}
          <div className="mt-3 flex gap-3 text-xs"><button type="button" disabled={busy} onClick={() => startEdit(profile)} className="text-[var(--accent)]">{t("编辑")}</button><button type="button" disabled={busy} onClick={() => void remove(profile)} className="text-[var(--muted)]">{t("删除")}</button></div>
        </div>) : <p className="text-sm text-[var(--muted)]">{t("暂无方案，当前功能继续使用原有部署配置。")}</p>}
      </div>
    </section>

    <section className="wallpaper-content-surface space-y-4 rounded-3xl border border-[var(--line)] bg-[var(--surface-raised)] p-5 shadow-xs sm:p-7">
      <div><h2 className="text-base font-bold text-[var(--ink)]">{t("功能使用方案")}</h2><p className="mt-1 text-xs text-[var(--muted)]">{t("“原有部署配置”沿用当前设置。")}</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        {[['assistant', t("音乐助手")], ['lyrics', t("歌词 AI")]].map(([feature, label]) => <label key={feature} className="space-y-2 text-sm text-[var(--ink)]"><span className="font-semibold">{t(label)}</span><select className={inputClass} disabled={!data || busy} value={data?.assignments[feature]?.profileId || ''} onChange={(event) => void assign(feature, event.target.value)}><option value="">{t("原有部署配置")}</option>{data?.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>)}
      </div>
    </section>
    {message && <p role="status" className="text-sm text-[var(--muted)]">{t(message)}</p>}
    {editing && <dialog ref={dialogRef} aria-label={editing === 'new' ? t("创建模型方案") : t("编辑模型方案")} onCancel={(event) => { event.preventDefault(); if (!busy) setEditing(null); }} className="w-[min(92vw,36rem)] max-h-[85vh] rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-0 text-[var(--ink)] shadow-2xl backdrop:bg-black/45">
      <form onSubmit={save} className="max-h-[85vh] space-y-4 overflow-y-auto p-5 sm:p-6">
        <div className="flex items-center justify-between"><h3 className="text-lg font-semibold">{editing === 'new' ? t("创建模型方案") : t("编辑模型方案")}</h3><button type="button" onClick={() => setEditing(null)} disabled={busy} className="text-sm text-[var(--muted)]">{t("关闭")}</button></div>
        <label className="block space-y-1 text-xs font-semibold">{t("方案名称")}<input className={inputClass} required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("例如 DeepSeek 主方案")} /></label>
        <label className="block space-y-1 text-xs font-semibold">{t("服务商")}<select className={inputClass} value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value, baseUrl: '' })}>{Object.entries(providerNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="block space-y-1 text-xs font-semibold">{t("模型名称")}<input className={inputClass} required maxLength={160} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder={t("填写服务商提供的模型 ID")} /></label>
        {(draft.provider === 'compatible' || draft.baseUrl) && <label className="block space-y-1 text-xs font-semibold">{t("API 基础地址")}<input className={inputClass} type="url" required={draft.provider === 'compatible'} maxLength={2048} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://example.com/v1" /><span className="block font-normal text-[var(--muted)]">{t("填写基础地址，不包含 /chat/completions。")}</span></label>}
        {['deepseek', 'openai'].includes(draft.provider) && !draft.baseUrl && <button type="button" className="text-xs text-[var(--accent)]" onClick={() => setDraft({ ...draft, baseUrl: 'https://' })}>{t("使用自定义基础地址")}</button>}
        <label className="block space-y-1 text-xs font-semibold">API Key<input className={inputClass} type="password" autoComplete="new-password" required={editing === 'new' || (editing !== 'new' && (!editing.hasKey || editing.provider !== draft.provider || editing.baseUrl !== draft.baseUrl))} maxLength={4096} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={editing === 'new' || !editing.hasKey ? t("重新输入密钥") : t("同一服务商与地址留空可保留现有密钥")} /></label>
        <div className="flex gap-3"><button type="submit" className={buttonClass} disabled={busy}>{t("保存方案")}</button><button type="button" disabled={busy} onClick={() => setEditing(null)} className="rounded-xl px-4 py-2 text-xs text-[var(--muted)]">{t("取消")}</button></div>
        {message && <p role="alert" className="text-sm text-rose-600">{t(message)}</p>}
      </form>
    </dialog>}
  </div>;
}
