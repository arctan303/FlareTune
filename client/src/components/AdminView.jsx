import React from 'react';
import { RefreshCw, KeyRound, Check, Copy, UserPlus, X, Edit3 } from 'lucide-react';
import { useUIStore } from '../store/useUIStore.js';
import { getInstanceStatus, runAdminMigration } from '../instance/api.js';
import AdminCatalogSection from './AdminCatalogSection.jsx';
import PageBackButton from './PageBackButton.jsx';
import AiProfilesPanel from './AiProfilesPanel.jsx';
import Section from './SettingsSection.jsx';
import IngestDevicesPanel from './IngestDevicesPanel.jsx';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';
import {
  adminErrorMessage, createManagedAccount, getAdminOverview, parseExactHttpsOrigins,
  patchManagedAccount, putAdminSetting, putAssistant, resetManagedPassword,
} from '../instance/adminApi.js';

const tabs = [
  ['general', '常规'], ['access', '访问'], ['assistant', 'AI 与助手'], ['catalog', '曲库'],
  ['accounts', '账号'], ['system', '系统'],
];
const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-xs text-[var(--ink)] placeholder:text-[var(--muted)] outline-none focus:border-[var(--accent)] transition-colors';
const buttonClass = 'primary-button rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-50 cursor-pointer shadow-xs';

function SettingsEditDialog({ title, onClose, children, message, busy }) {
  const dialogRef = React.useRef(null);
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    dialog.showModal();
    dialog.querySelector('input, textarea, select')?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={dialogRef} aria-label={title} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} className="w-[min(92vw,48rem)] max-h-[85vh] rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-0 text-[var(--ink)] shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--line)] bg-[var(--surface-raised)] px-5 py-4"><h2 className="text-lg font-semibold">{title}</h2><button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-2 py-1 text-sm text-[var(--muted)] hover:bg-[var(--surface)] disabled:opacity-50" aria-label="关闭编辑">关闭</button></div>
      <div className="max-h-[calc(85vh-4rem)] overflow-y-auto p-5 sm:p-6">{message && <div role="alert" className="mb-4 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-600">{message}</div>}{children}</div>
    </dialog>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1.5 text-xs text-[var(--ink)]">
      <span className="font-semibold">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-[var(--muted)] leading-relaxed">{hint}</span>}
    </label>
  );
}

function AccountRow({ account, csrfToken, onSaved, onMessage, busy, setBusy }) {
  const [resetOpen, setResetOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [displayName, setDisplayName] = React.useState(account.displayName || '');
  const [role, setRole] = React.useState(account.role);
  const [status, setStatus] = React.useState(account.status);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    onMessage('');
    try {
      const result = await patchManagedAccount(account.accountId,
        { displayName, role, status, expectedUpdatedAt: account.updatedAt }, csrfToken);
      onSaved(result.account);
      setEditOpen(false);
      onMessage('账号已更新。');
    } catch (error) { onMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  async function reset(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = new FormData(form).get('temporaryPassword');
    setBusy(true);
    onMessage('');
    try {
      await resetManagedPassword(account.accountId, password, csrfToken);
      form.reset();
      setResetOpen(false);
      onMessage(`已重置 ${account.username} 的临时密码；请通过安全渠道交给本人，首次登录须改密。`);
    } catch (error) { onMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  const cancelEdit = () => {
    setDisplayName(account.displayName || '');
    setRole(account.role);
    setStatus(account.status);
    setEditOpen(false);
  };

  return (
    <div className={`wallpaper-content-surface rounded-2xl border transition-all ${
      editOpen || resetOpen
        ? 'border-[var(--line-strong)] bg-[var(--surface-raised)] shadow-xs'
        : 'border-[var(--line)] bg-[var(--surface)] hover:border-[var(--line-strong)]'
    } p-3.5 sm:p-4 space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-[var(--surface-raised)] border border-[var(--line)] flex items-center justify-center font-bold text-xs text-[var(--accent)] shrink-0">
            {(account.username || 'U').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <strong className="text-xs font-bold text-[var(--ink)]">{account.username}</strong>
              {account.displayName && (
                <span className="text-xs text-[var(--muted)] truncate">({account.displayName})</span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                account.role === 'admin'
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold'
                  : 'bg-[var(--line)] text-[var(--muted)]'
              }`}>
                {account.role === 'admin' ? '系统管理员' : '普通成员'}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                account.status === 'active'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              }`}>
                {account.status === 'active' ? '启用中' : '已停用'}
              </span>
            </div>
          </div>
        </div>

        {/* 操作按钮组 */}
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              editOpen
                ? 'bg-current/10 text-[var(--ink)] font-semibold'
                : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5'
            }`}
            onClick={() => {
              setEditOpen((v) => !v);
              if (!editOpen) setResetOpen(false);
            }}
            aria-expanded={editOpen}
          >
            <Edit3 size={12} />
            <span>{editOpen ? '收起' : '编辑'}</span>
          </button>

          <button
            type="button"
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              resetOpen
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold'
                : 'text-[var(--accent)] hover:opacity-80 hover:bg-[var(--accent)]/10'
            }`}
            onClick={() => {
              setResetOpen((v) => !v);
              if (!resetOpen) setEditOpen(false);
            }}
            aria-expanded={resetOpen}
          >
            <KeyRound size={12} />
            <span>{resetOpen ? '收起重置' : '重置密码'}</span>
          </button>
        </div>
      </div>

      {/* 编辑表单：折叠展开 */}
      {editOpen && (
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto] sm:items-end pt-3 border-t border-[var(--line)] animate-[fade-in_0.15s_ease-out]">
          <Field label="显示名称">
            <input className={inputClass} maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="用户昵称" />
          </Field>
          <Field label="角色">
            <select className={inputClass} value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="member">普通成员</option>
              <option value="admin">系统管理员</option>
            </select>
          </Field>
          <Field label="状态">
            <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="active">启用</option>
              <option value="disabled">停用</option>
            </select>
          </Field>
          <div className="flex items-center gap-1.5">
            <button className={buttonClass} type="submit" disabled={busy}>保存</button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-xl px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
            >
              取消
            </button>
          </div>
        </form>
      )}

      {/* 密码重置表单：折叠展开 */}
      {resetOpen && (
        <form onSubmit={reset} className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] p-3 animate-[fade-in_0.15s_ease-out]">
          <div className="flex-1 min-w-[200px]">
            <Field label="一次性临时密码" hint="至少 15 个字符；不会保存在浏览器。">
              <input className={inputClass} type="password" name="temporaryPassword" autoComplete="new-password" minLength={15} maxLength={1024} required placeholder="输入新的临时密码" />
            </Field>
          </div>
          <div className="flex items-center gap-1.5">
            <button className={buttonClass} type="submit" disabled={busy}>确认重置</button>
            <button
              type="button"
              onClick={() => setResetOpen(false)}
              className="rounded-xl px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function AdminView({ onBack, embeddedTab, onTabChange }) {
  const authSession = useUIStore((state) => state.authSession);
  const csrfToken = authSession.csrfToken;
  const [tab, setTab] = React.useState(embeddedTab || 'general');
  const [overview, setOverview] = React.useState(null);
  const [draft, setDraft] = React.useState({});
  const [assistantDraft, setAssistantDraft] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [isCreatingAccount, setIsCreatingAccount] = React.useState(false);
  const [assistantEditorOpen, setAssistantEditorOpen] = React.useState(false);
  const [lyricAiEditorOpen, setLyricAiEditorOpen] = React.useState(false);
  const [nameEditorOpen, setNameEditorOpen] = React.useState(false);
  const [originsEditorOpen, setOriginsEditorOpen] = React.useState(false);

  // Sync internal tab if controlled by embeddedTab prop
  React.useEffect(() => {
    if (embeddedTab && embeddedTab !== tab) {
      setTab(embeddedTab);
    }
  }, [embeddedTab, tab]);

  const handleTabChange = (nextTab) => {
    setTab(nextTab);
    onTabChange?.(nextTab);
  };

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const [next, nextStatus] = await Promise.all([getAdminOverview(csrfToken), getInstanceStatus()]);
      setOverview(next);
      setDraft(Object.fromEntries(Object.entries(next.settings).map(([key, item]) =>
        [key, key === 'cors.allowed_origins' ? item.value.join('\n') : item.value])));
      setAssistantDraft(next.assistant);
      setStatus(nextStatus);
    } catch (error) { setMessage(adminErrorMessage(error)); }
    finally { setLoading(false); }
  }, [csrfToken]);

  React.useEffect(() => { if (authSession.user?.role === 'admin') void refresh(); else setLoading(false); }, [authSession.user?.role, refresh]);

  async function upgradeDatabase() {
    setBusy(true);
    setMessage('');
    try {
      const result = await runAdminMigration(csrfToken);
      if (result.status === 'in_progress' || result.status === 'lease_busy') {
        window.location.reload();
        return;
      }
      setStatus(await getInstanceStatus());
      setMessage('数据库已升级到当前版本。');
    } catch (error) {
      setMessage(error?.code === 'backup_required'
        ? '检测到旧共享歌单。请备份 D1，并在维护页面使用初始化密钥升级。'
        : adminErrorMessage(error));
    } finally { setBusy(false); }
  }

  async function saveSetting(event, key) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const value = key === 'cors.allowed_origins' ? parseExactHttpsOrigins(draft[key] || '') : draft[key];
      const result = await putAdminSetting(key, value, overview.settings[key].revision, csrfToken);
      setOverview((current) => ({ ...current, settings: { ...current.settings, [key]: result } }));
      setMessage('设置已成功保存。');
      if (key === 'lyrics.ai') setLyricAiEditorOpen(false);
      if (key === 'instance.name') setNameEditorOpen(false);
      if (key === 'cors.allowed_origins') setOriginsEditorOpen(false);
    } catch (error) { setMessage(error instanceof Error && !('status' in error) ? error.message : adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  const setLyricAiField = (key, value) => setDraft((current) => ({
    ...current,
    'lyrics.ai': { ...current['lyrics.ai'], [key]: value },
  }));

  const setLyricTargetLanguage = (targetLanguage) => {
    const legacy = overview.settings['lyrics.ai'];
    const clearLegacyChineseRules = legacy.revision === 0 && targetLanguage !== 'zh'
      && draft['lyrics.ai']?.styleRules === legacy.value.styleRules;
    setDraft((current) => ({ ...current, 'lyrics.ai': {
      ...current['lyrics.ai'], targetLanguage,
      ...(clearLegacyChineseRules ? { styleRules: '' } : {}),
    } }));
    if (clearLegacyChineseRules && legacy.value.styleRules) {
      setMessage('已移除旧配置中的中文翻译准则；可按新目标语言重新填写。');
    }
  };

  async function saveAssistant(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const { revision, ...patch } = assistantDraft;
      const result = await putAssistant({ ...patch, temperature: Number(patch.temperature) }, revision, csrfToken);
      setAssistantDraft(result);
      setOverview((current) => ({ ...current, assistant: result }));
      setMessage('助手配置已成功保存。');
      setAssistantEditorOpen(false);
    } catch (error) { setMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  async function createAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage('');
    try {
      const result = await createManagedAccount({
        username: data.get('username'), displayName: data.get('displayName'),
        role: data.get('role'), temporaryPassword: data.get('temporaryPassword'),
      }, csrfToken);
      form.reset();
      setIsCreatingAccount(false);
      setOverview((current) => ({ ...current, accounts: [...current.accounts, result.account] }));
      setMessage('账号已创建。请通过安全渠道交付临时密码；首次登录须改密。');
    } catch (error) { setMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  const setting = (key, label, hint, multiline = false) => (
    <form onSubmit={(event) => saveSetting(event, key)} className="space-y-4">
      <Field label={label} hint={hint}>
        {multiline ? (
          <textarea
            className={`${inputClass} min-h-28 font-mono`}
            value={draft[key] || ''}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
            spellCheck={false}
          />
        ) : (
          <input
            className={inputClass}
            value={draft[key] || ''}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
            maxLength={key === 'instance.name' ? 80 : 2048}
          />
        )}
      </Field>
      <div>
        <button className={buttonClass} type="submit" disabled={busy}>保存设置</button>
      </div>
    </form>
  );

  const isEmbedded = Boolean(embeddedTab);

  return (
    <div className={`admin-view space-y-6 pb-24 text-[var(--ink)] ${!isEmbedded ? 'mx-auto max-w-5xl' : ''}`}>
      {/* 独立查看时的顶栏与刷新按钮 */}
      {!isEmbedded && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {onBack && (
              <PageBackButton onClick={onBack} className="mb-4" />
            )}
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-[var(--ink)]">系统管理</h1>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-50 cursor-pointer shadow-2xs"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 刷新数据
          </button>
        </div>
      )}

      {/* 嵌入设置页时的小顶栏（带刷新） */}
      {isEmbedded && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
      )}

      {message && (
        <div role="status" className="rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 text-xs">
          {message}
        </div>
      )}

      {authSession.user?.role !== 'admin' ? (
        <Section title="无权访问">只有管理员可以打开系统管理。</Section>
      ) : loading ? (
        <p role="status" className="text-xs text-[var(--muted)] py-8 text-center">正在加载实例设置…</p>
      ) : !overview ? (
        <Section title="无法加载">请确认服务可用后刷新重试。</Section>
      ) : (
        <>
          {/* 独立展示时的横排 Tab 栏（嵌入设置页时由左侧二级侧栏接管导航，但保留 tabs 保证结构与契约完整） */}
          {!isEmbedded && (
            <nav aria-label="系统管理分类" className="flex flex-wrap gap-1.5 border-b border-[var(--line)] pb-3">
              {tabs.map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-current={tab === id ? 'page' : undefined}
                  onClick={() => handleTabChange(id)}
                  className={`rounded-xl px-3.5 py-1.5 text-xs font-medium transition-all cursor-pointer ${
                    tab === id
                      ? 'bg-[var(--surface-raised)] font-bold text-[var(--accent)] border border-[var(--line)] shadow-2xs'
                      : 'text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}

          {/* 常规 */}
          {(tab === 'general' || tab === 'instance' || tab === 'system') && (
            <div className="space-y-6">
              <Section title="实例名称">
                <div className="flex flex-wrap items-center justify-between gap-4"><strong className="text-base text-[var(--ink)]">{overview.settings['instance.name']?.value || '未命名实例'}</strong><button type="button" className={buttonClass} onClick={() => { setMessage(''); setNameEditorOpen(true); }}>修改名称</button></div>
              </Section>
              {nameEditorOpen && <SettingsEditDialog title="修改实例名称" message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'instance.name': overview.settings['instance.name']?.value || '' })); setNameEditorOpen(false); }}>
                {setting('instance.name', '名称', '最多 80 个字符。')}
              </SettingsEditDialog>}
            </div>
          )}

          {/* 访问 */}
          {(tab === 'access' || tab === 'instance' || tab === 'system') && (
            <div className="space-y-6">
              <Section title="附加允许来源">
                <div className="flex flex-wrap items-center justify-between gap-4"><div className="min-w-0 text-sm text-[var(--ink)]">{overview.settings['cors.allowed_origins']?.value?.length ? <><strong>{overview.settings['cors.allowed_origins'].value.length} 个来源</strong><p className="mt-1 break-all text-xs text-[var(--muted)]">{overview.settings['cors.allowed_origins'].value.slice(0, 2).join(' · ')}</p></> : <span className="text-[var(--muted)]">没有附加来源</span>}</div><button type="button" className={buttonClass} onClick={() => { setMessage(''); setOriginsEditorOpen(true); }}>管理来源</button></div>
              </Section>
              {originsEditorOpen && <SettingsEditDialog title="管理附加允许来源" message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'cors.allowed_origins': (overview.settings['cors.allowed_origins']?.value || []).join('\n') })); setOriginsEditorOpen(false); }}>
                {setting('cors.allowed_origins', '精确 HTTPS Origin（每行一个）', '例如 https://music.example.com；不接受通配符、路径或末尾斜杠。', true)}
              </SettingsEditDialog>}
            </div>
          )}

          {/* AI 与助手 */}
          {tab === 'assistant' && (
            <div className="space-y-6">
              <AiProfilesPanel csrfToken={csrfToken} />

              <Section title="助手资料">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1.5 text-sm"><p><span className="text-[var(--muted)]">名称：</span><strong>{overview.assistant?.name || '小A'}</strong></p><p className="line-clamp-2 max-w-xl text-xs text-[var(--muted)]">{overview.assistant?.description || '暂无描述'}</p></div>
                  <button type="button" className={buttonClass} onClick={() => { setMessage(''); setAssistantDraft({ ...overview.assistant }); setAssistantEditorOpen(true); }}>编辑助手资料</button>
                </div>
              </Section>
              {assistantEditorOpen && <SettingsEditDialog title="编辑助手资料" message={message} busy={busy} onClose={() => { setAssistantDraft({ ...overview.assistant }); setAssistantEditorOpen(false); }}>
                <form onSubmit={saveAssistant} className="grid gap-4 sm:grid-cols-2">
                  {[
                    ['name', '助手名称', 80], ['avatar_icon', '图标标识', 80],
                    ['welcome_message', '欢迎语', 1000], ['description', '描述', 500],
                    ['persona', '人设', 12000], ['system_rules', '系统准则', 24000],
                  ].map(([key, label, max]) => (
                    <div key={key} className={['persona', 'system_rules', 'description', 'welcome_message'].includes(key) ? 'sm:col-span-2' : ''}>
                      <Field label={label}>
                        {['persona', 'system_rules', 'description', 'welcome_message'].includes(key) ? (
                          <textarea
                            className={`${inputClass} min-h-24`}
                            maxLength={max}
                            required
                            value={assistantDraft?.[key] || ''}
                            onChange={(event) => setAssistantDraft((current) => ({ ...current, [key]: event.target.value }))}
                          />
                        ) : (
                          <input
                            className={inputClass}
                            maxLength={max}
                            required
                            value={assistantDraft?.[key] || ''}
                            onChange={(event) => setAssistantDraft((current) => ({ ...current, [key]: event.target.value }))}
                          />
                        )}
                      </Field>
                      {['persona', 'system_rules'].includes(key) && <button type="button"
                        className="mt-2 text-xs text-[var(--accent)]"
                        onClick={() => setAssistantDraft((current) => ({ ...current,
                          [key]: overview.defaults?.assistant?.[key] || current[key] }))}>
                        重置为系统默认{label}
                      </button>}
                    </div>
                  ))}
                  <div className="sm:col-span-2">
                    <Field label="温度（0～2）" hint="数值越低越严谨，数值越高越有创造力。默认推荐 0.7。">
                      <div className="flex items-center gap-3">
                        <input
                          className="flex-1 accent-[var(--accent)] cursor-pointer"
                          type="range"
                          min="0"
                          max="2"
                          step="0.1"
                          required
                          value={assistantDraft?.temperature ?? 0.7}
                          onChange={(event) => setAssistantDraft((current) => ({ ...current, temperature: event.target.value }))}
                        />
                        <span className="font-mono text-xs w-8 text-right font-bold text-[var(--accent)]">
                          {Number(assistantDraft?.temperature ?? 0.7).toFixed(1)}
                        </span>
                      </div>
                    </Field>
                  </div>
                  <div className="sm:col-span-2 pt-2">
                    <button type="submit" className={buttonClass} disabled={busy}>保存助手配置</button>
                  </div>
                </form>
              </SettingsEditDialog>}

              <Section title="歌词 AI">
                <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
                  <div className="space-y-1.5">
                    <p><span className="text-[var(--muted)]">目标译文：</span>{getLanguageLabel(draft['lyrics.ai']?.targetLanguage)}</p>
                    <p className="text-xs text-[var(--muted)]">{[
                      draft['lyrics.ai']?.completionEnabled ? '歌词 AI 已开启' : '歌词 AI 已关闭',
                      draft['lyrics.ai']?.completionEnabled && (draft['lyrics.ai']?.automaticCompletionEnabled ? '自动补全已开启' : '仅手动补全'),
                      draft['lyrics.ai']?.cleanDirtyLyrics && '清理脏歌词',
                      draft['lyrics.ai']?.translateLyrics && '翻译',
                      draft['lyrics.ai']?.detectLanguage && '识别歌曲语言',
                    ].filter(Boolean).join(' · ')}</p>
                  </div>
                  <button type="button" className={buttonClass} onClick={() => { setMessage(''); setLyricAiEditorOpen(true); }}>编辑歌词 AI</button>
                </div>
              </Section>
              {lyricAiEditorOpen && <SettingsEditDialog title="编辑歌词 AI" message={message} busy={busy} onClose={() => {
                setDraft((current) => ({ ...current, 'lyrics.ai': overview.settings['lyrics.ai'].value }));
                setLyricAiEditorOpen(false);
              }}>
                <form onSubmit={(event) => void saveSetting(event, 'lyrics.ai')} className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                  <Field label="目标译文语言" hint="实例内所有用户共用一份译文；修改后旧译文不会自动变成新语言。"><select className={inputClass} value={draft['lyrics.ai']?.targetLanguage || 'zh'} onChange={(event) => setLyricTargetLanguage(event.target.value)}>
                    {ALL_LANGUAGES.filter(({ code }) => !['instrumental', 'other'].includes(code)).map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
                  </select></Field>
                  <Field label="温度（0～2）"><input className={inputClass} type="number" min="0" max="2" step="0.1" value={draft['lyrics.ai']?.temperature ?? 0.2} onChange={(event) => setLyricAiField('temperature', Number(event.target.value))} /></Field>
                  <div className="min-w-0 space-y-2">
                    <label htmlFor="lyrics-ai-style-rules" className="block text-xs font-semibold text-[var(--ink)]">歌词处理准则</label>
                    <textarea id="lyrics-ai-style-rules" className={`${inputClass} min-h-64 resize-y`} maxLength={8000} value={draft['lyrics.ai']?.styleRules || ''} onChange={(event) => setLyricAiField('styleRules', event.target.value)} />
                    <button type="button" className="text-xs font-medium text-[var(--accent)] hover:underline" onClick={() => setLyricAiField('styleRules', overview.defaults?.lyrics?.styleRules || '')}>重置为系统默认准则</button>
                    <p className="text-[11px] leading-relaxed text-[var(--muted)]">补充翻译、清理和语言判断的风格要求；结果格式、时间轴与写入校验由系统固定。</p>
                  </div>
                  <fieldset className="min-w-0 space-y-4">
                    <legend className="text-xs font-semibold text-[var(--ink)]">处理功能</legend>
                    <div className="space-y-4 text-sm">
                      {[
                        ['completionEnabled', '启用歌词 AI 补全（关闭后工作台入口隐藏）'],
                        ['automaticCompletionEnabled', '播放时自动补全缺少目标语言译文的歌词'],
                        ['cleanDirtyLyrics', '清理非演唱歌词整行'],
                        ['translateLyrics', '生成目标语言译文'],
                        ['detectLanguage', '识别并更新歌曲语言'],
                        ['referenceExistingTranslation', '将同语言旧译文作为翻译参考'],
                      ].map(([key, label]) => <label key={key} className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5" checked={Boolean(draft['lyrics.ai']?.[key])} onChange={(event) => setLyricAiField(key, event.target.checked)} /><span>{label}</span></label>)}
                    </div>
                  </fieldset>
                  <div className="flex justify-end border-t border-[var(--line)] pt-5 sm:col-span-2">
                    <button type="submit" className={buttonClass} disabled={busy}>保存歌词 AI 设置</button>
                  </div>
                </form>
              </SettingsEditDialog>}
            </div>
          )}

          {/* 曲库 */}
          {tab === 'catalog' && <AdminCatalogSection />}

          {/* 账号 */}
          {tab === 'accounts' && (
            <div className="space-y-4">
              {/* 顶部操作与概览栏 */}
              <div className="wallpaper-content-surface flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5 rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] shadow-2xs">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-[var(--ink)]">账号列表</h2>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--line)] text-[var(--muted)] font-mono font-medium">
                      {overview.accounts?.length || 0}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--muted)] mt-1">
                    不开放公开注册。临时密码仅用于首次登录，成员登录后须立刻修改。最后一位可用管理员不可被停用或降权。
                  </p>
                </div>

                {!isCreatingAccount && (
                  <button
                    type="button"
                    onClick={() => setIsCreatingAccount(true)}
                    className="primary-button inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold cursor-pointer shadow-xs shrink-0"
                  >
                    <UserPlus size={14} />
                    <span>创建新账号</span>
                  </button>
                )}
              </div>

              {/* 创建账号卡片（默认收起，点击创建新账号时展开） */}
              {isCreatingAccount && (
                <div className="rounded-2xl border border-[var(--accent)]/40 bg-[var(--surface-raised)] p-5 space-y-4 shadow-sm animate-[fade-in_0.2s_ease-out]">
                  <div className="flex items-center justify-between border-b border-[var(--line)] pb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] flex items-center justify-center shrink-0">
                        <UserPlus size={15} />
                      </div>
                      <div>
                        <h3 className="text-xs font-bold text-[var(--ink)]">创建新成员账号</h3>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsCreatingAccount(false)}
                      className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5 transition-colors cursor-pointer"
                      title="关闭创建卡片"
                      aria-label="关闭创建卡片"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  <form onSubmit={createAccount} className="grid gap-3.5 sm:grid-cols-2">
                    <Field label="用户名">
                      <input className={inputClass} name="username" pattern={'[a-z0-9_.\\-]{3,64}'} minLength={3} maxLength={64} autoComplete="off" required placeholder="如 alex_turner" />
                    </Field>
                    <Field label="显示名称">
                      <input className={inputClass} name="displayName" maxLength={80} autoComplete="off" placeholder="用户昵称" />
                    </Field>
                    <Field label="角色">
                      <select className={inputClass} name="role">
                        <option value="member">普通成员</option>
                        <option value="admin">系统管理员</option>
                      </select>
                    </Field>
                    <Field label="一次性临时密码" hint="至少 15 个字符；不会保存在浏览器。">
                      <input className={inputClass} type="password" name="temporaryPassword" autoComplete="new-password" minLength={15} maxLength={1024} required placeholder="初始临时密码" />
                    </Field>
                    <div className="sm:col-span-2 pt-2 flex items-center gap-2">
                      <button className={buttonClass} type="submit" disabled={busy}>确认创建账号</button>
                      <button
                        type="button"
                        onClick={() => setIsCreatingAccount(false)}
                        className="rounded-xl px-4 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5 transition-colors cursor-pointer"
                      >
                        取消
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* 现有账号列表 */}
              <div className="space-y-2.5">
                {overview.accounts?.length ? (
                  overview.accounts.map((account) => (
                    <AccountRow
                      key={`${account.accountId}:${account.updatedAt}`}
                      account={account}
                      csrfToken={csrfToken}
                      busy={busy}
                      setBusy={setBusy}
                      onMessage={setMessage}
                      onSaved={(saved) => setOverview((current) => ({
                        ...current,
                        accounts: current.accounts.map((item) => (item.accountId === saved.accountId ? saved : item)),
                      }))}
                    />
                  ))
                ) : (
                  <div className="wallpaper-content-surface p-8 text-center rounded-2xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--muted)]">
                    暂无账号数据。
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 系统 */}
          {tab === 'system' && (
            <div className="space-y-6">
              <IngestDevicesPanel />
              <Section title="运行概况">
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div className="wallpaper-content-surface p-4 rounded-2xl bg-[var(--surface)] border border-[var(--line)]">
                    <dt className="text-xs text-[var(--muted)]">应用版本</dt>
                    <dd className="mt-1 text-sm font-bold text-[var(--ink)]">FlareTune {__APP_VERSION__}</dd>
                  </div>
                  <div className="wallpaper-content-surface p-4 rounded-2xl bg-[var(--surface)] border border-[var(--line)]">
                    <dt className="text-xs text-[var(--muted)]">实例状态</dt>
                    <dd className="mt-1 text-sm font-bold flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${status?.state === 'ready' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                      <span className={status?.state === 'ready' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500'}>
                        {status?.state === 'ready' ? '就绪 (Ready)' : '暂时无法验证'}
                      </span>
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
                  <p className="text-xs text-[var(--muted)]">数据库版本</p>
                  <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{status?.schemaVersion ?? '未知'} / {status?.targetVersion ?? '未知'}</p>
                  {Number.isSafeInteger(status?.schemaVersion) && Number.isSafeInteger(status?.targetVersion)
                    && status.schemaVersion < status.targetVersion && <button className={`${buttonClass} mt-3`} type="button" disabled={busy} onClick={() => void upgradeDatabase()}>升级数据库</button>}
                  {status?.schemaVersion === status?.targetVersion && <p className="mt-2 text-xs text-[var(--muted)]">数据库已是当前版本。</p>}
                </div>
                <p className="mt-4 text-[11px] text-[var(--muted)] leading-relaxed">
                  此处显示应用迁移账本版本；存储和其他底层健康状态仍需结合实际运行检查。
                </p>
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
