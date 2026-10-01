import SelectControl from './SelectControl.jsx';
import { t } from '../i18n/index.js';
import React from 'react';
import { RefreshCw, KeyRound, Check, Copy, UserPlus, X, Edit3 } from 'lucide-react';
import { useUIStore } from '../store/useUIStore.js';
import { getAdminMigrationStatus, runAdminMigration } from '../instance/api.js';
import { validLocalPassword } from '../instance/state.js';
import AdminCatalogSection from './AdminCatalogSection.jsx';
import PageBackButton from './PageBackButton.jsx';
import AiProfilesPanel from './AiProfilesPanel.jsx';
import Section from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import IngestDevicesPanel from './IngestDevicesPanel.jsx';
import { GoogleAdminSettings } from './GoogleLogin.jsx';
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
    if (!validLocalPassword(password)) {
      onMessage('临时密码至少需要 8 个字符，且不能超过 1024 字节。');
      return;
    }
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
                {account.role === 'admin' ? t("系统管理员") : t("普通成员")}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                account.status === 'active'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              }`}>
                {account.status === 'active' ? t("启用中") : t("已停用")}
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
            <span>{editOpen ? t("收起") : t("编辑")}</span>
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
            <span>{resetOpen ? t("收起重置") : t("重置密码")}</span>
          </button>
        </div>
      </div>

      {/* 编辑表单：折叠展开 */}
      {editOpen && (
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto] sm:items-end pt-3 border-t border-[var(--line)] animate-[fade-in_0.15s_ease-out]">
          <Field label={t("显示名称")}>
            <input className={inputClass} maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("用户昵称")} />
          </Field>
          <Field label={t("角色")}>
            <SelectControl aria-label={t("角色")} className={inputClass} value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="member">{t("普通成员")}</option>
              <option value="admin">{t("系统管理员")}</option>
            </SelectControl>
          </Field>
          <Field label={t("状态")}>
            <SelectControl aria-label={t("状态")} className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="active">{t("启用")}</option>
              <option value="disabled">{t("停用")}</option>
            </SelectControl>
          </Field>
          <div className="flex items-center gap-1.5">
            <button className={buttonClass} type="submit" disabled={busy}>{t("保存")}</button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-xl px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
            >{t("取消")}</button>
          </div>
        </form>
      )}

      {/* 密码重置表单：折叠展开 */}
      {resetOpen && (
        <form onSubmit={reset} className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-[var(--surface-raised)] border border-[var(--line)] p-3 animate-[fade-in_0.15s_ease-out]">
          <div className="flex-1 min-w-[200px]">
            <Field label={t("一次性临时密码")} hint={t("至少 8 个字符。")}>
              <input className={inputClass} type="password" name="temporaryPassword" autoComplete="new-password" minLength={8} maxLength={1024} required placeholder={t("输入新的临时密码")} />
            </Field>
          </div>
          <div className="flex items-center gap-1.5">
            <button className={buttonClass} type="submit" disabled={busy}>{t("确认重置")}</button>
            <button
              type="button"
              onClick={() => setResetOpen(false)}
              className="rounded-xl px-3 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer"
            >{t("取消")}</button>
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
      const [next, nextStatus] = await Promise.all([getAdminOverview(csrfToken), getAdminMigrationStatus(csrfToken)]);
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
      setStatus(await getAdminMigrationStatus(csrfToken));
      setMessage(t("数据库已升级到当前版本。"));
    } catch (error) {
      setMessage(error?.code === 'backup_required'
        ? '检测到旧共享歌单。请备份 D1，并在维护页面使用初始化密钥升级。'
        : adminErrorMessage(error));
    } finally { setBusy(false); }
  }

  async function saveSetting(event, key, override) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const value = override !== undefined ? override : key === 'cors.allowed_origins' ? parseExactHttpsOrigins(draft[key] || '') : draft[key];
      const result = await putAdminSetting(key, value, overview.settings[key].revision, csrfToken);
      setOverview((current) => ({ ...current, settings: { ...current.settings, [key]: result } }));
      setMessage(t("设置已成功保存。"));
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
      setMessage(t("已移除旧配置中的中文翻译准则；可按新目标语言重新填写。"));
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
      setMessage(t("助手配置已成功保存。"));
      setAssistantEditorOpen(false);
    } catch (error) { setMessage(adminErrorMessage(error)); }
    finally { setBusy(false); }
  }

  async function createAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!validLocalPassword(data.get('temporaryPassword'))) {
      setMessage(t("临时密码至少需要 8 个字符，且不能超过 1024 字节。"));
      return;
    }
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
      setMessage(t("账号已创建。请通过安全渠道交付临时密码；首次登录须改密。"));
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
        <button className={buttonClass} type="submit" disabled={busy}>{t("保存设置")}</button>
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
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-[var(--ink)]">{t("系统管理")}</h1>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-50 cursor-pointer shadow-2xs"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />{t("刷新数据")}</button>
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
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />{t("刷新")}</button>
        </div>
      )}

      {message && (
        <div role="status" className="rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 text-xs">
          {t(message)}
        </div>
      )}

      {authSession.user?.role !== 'admin' ? (
        <Section title={t("无权访问")}>{t("只有管理员可以打开系统管理。")}</Section>
      ) : loading ? (
        <p role="status" className="text-xs text-[var(--muted)] py-8 text-center">{t("正在加载实例设置…")}</p>
      ) : !overview ? (
        <Section title={t("无法加载")}>{t("请确认服务可用后刷新重试。")}</Section>
      ) : (
        <>
          {/* 独立展示时的横排 Tab 栏（嵌入设置页时由左侧二级侧栏接管导航，但保留 tabs 保证结构与契约完整） */}
          {!isEmbedded && (
            <nav aria-label={t("系统管理分类")} className="flex flex-wrap gap-1.5 border-b border-[var(--line)] pb-3">
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
              <Section title={t("实例名称")}>
                <div className="flex flex-wrap items-center justify-between gap-4"><strong className="text-base text-[var(--ink)]">{overview.settings['instance.name']?.value || t("未命名实例")}</strong><button type="button" className={buttonClass} onClick={() => { setMessage(''); setNameEditorOpen(true); }}>{t("修改名称")}</button></div>
              </Section>
              {nameEditorOpen && <SettingsEditDialog title={t("修改实例名称")} message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'instance.name': overview.settings['instance.name']?.value || '' })); setNameEditorOpen(false); }}>
                {setting('instance.name', t("名称"), t("最多 80 个字符。"))}
              </SettingsEditDialog>}
            </div>
          )}

          {/* 访问 */}
          {(tab === 'access' || tab === 'instance' || tab === 'system') && (
            <div className="space-y-6">
              <Section title={t("附加允许来源")}>
                <div className="flex flex-wrap items-center justify-between gap-4"><div className="min-w-0 text-sm text-[var(--ink)]">{overview.settings['cors.allowed_origins']?.value?.length ? <><strong>{overview.settings['cors.allowed_origins'].value.length}{' '}{t("个来源")}</strong><p className="mt-1 break-all text-xs text-[var(--muted)]">{overview.settings['cors.allowed_origins'].value.slice(0, 2).join(' · ')}</p></> : <span className="text-[var(--muted)]">{t("没有附加来源")}</span>}</div><button type="button" className={buttonClass} onClick={() => { setMessage(''); setOriginsEditorOpen(true); }}>{t("管理来源")}</button></div>
              </Section>
              {originsEditorOpen && <SettingsEditDialog title={t("管理附加允许来源")} message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'cors.allowed_origins': (overview.settings['cors.allowed_origins']?.value || []).join('\n') })); setOriginsEditorOpen(false); }}>
                {setting('cors.allowed_origins', t("精确 HTTPS Origin（每行一个）"), t("例如 https://music.example.com；不接受通配符、路径或末尾斜杠。"), true)}
              </SettingsEditDialog>}
            </div>
          )}

          {/* AI 与助手 */}
          {tab === 'assistant' && (
            <div className="space-y-6">
              <AiProfilesPanel csrfToken={csrfToken} />
              <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-5">
                <label className="flex min-h-11 w-full items-center justify-between gap-3 text-sm font-semibold">
                  <span>{t('允许助手图片输入')}</span>
                  <input type="checkbox" role="switch" className="settings-switch" disabled={busy} checked={overview.settings['assistant.images_enabled']?.value === true}
                    onChange={event => void saveSetting(event, 'assistant.images_enabled', event.target.checked)} />
                </label><p className="mt-2 text-xs text-[var(--muted)]">{t('关闭后不再向模型发送新图或历史图片，已有图片仍仅本人可查看。')}</p>
              </section>

              <Section title={t("助手资料")}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1.5 text-sm"><p><span className="text-[var(--muted)]">{t("名称：")}</span><strong>{overview.assistant?.name || t("小A")}</strong></p><p className="line-clamp-2 max-w-xl text-xs text-[var(--muted)]">{t(overview.assistant?.description || '暂无描述')}</p></div>
                  <button type="button" className={buttonClass} onClick={() => { setMessage(''); setAssistantDraft({ ...overview.assistant }); setAssistantEditorOpen(true); }}>{t("编辑助手资料")}</button>
                </div>
              </Section>
              {assistantEditorOpen && <SettingsEditDialog title={t("编辑助手资料")} message={message} busy={busy} onClose={() => { setAssistantDraft({ ...overview.assistant }); setAssistantEditorOpen(false); }}>
                <form onSubmit={saveAssistant} className="grid gap-4 sm:grid-cols-2">
                  {[
                    ['name', t("助手名称"), 80], ['avatar_icon', t("图标标识"), 80],
                    ['welcome_message', t("欢迎语"), 1000], ['description', t("描述"), 500],
                    ['persona', t("人设"), 12000], ['system_rules', t("系统准则"), 24000],
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
                          [key]: overview.defaults?.assistant?.[key] || current[key] }))}>{t("重置为系统默认")}{label}
                      </button>}
                    </div>
                  ))}
                  <div className="sm:col-span-2">
                    <Field label={t("温度（0～2）")} hint={t("越低越严谨，越高越有创造力。")}>
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
                    <button type="submit" className={buttonClass} disabled={busy}>{t("保存助手配置")}</button>
                  </div>
                </form>
              </SettingsEditDialog>}

              <Section title={t("歌词 AI")}>
                <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
                  <div className="space-y-1.5">
                    <p><span className="text-[var(--muted)]">{t("目标译文：")}</span>{getLanguageLabel(draft['lyrics.ai']?.targetLanguage)}</p>
                    <p className="text-xs text-[var(--muted)]">{[
                      draft['lyrics.ai']?.completionEnabled ? t("歌词 AI 已开启") : t("歌词 AI 已关闭"),
                      draft['lyrics.ai']?.completionEnabled && (draft['lyrics.ai']?.automaticCompletionEnabled ? t("自动补全已开启") : t("仅手动补全")),
                      draft['lyrics.ai']?.cleanDirtyLyrics && t("清理脏歌词"),
                      draft['lyrics.ai']?.translateLyrics && t("翻译"),
                      draft['lyrics.ai']?.detectLanguage && t("识别歌曲语言"),
                    ].filter(Boolean).map((value) => t(value)).join(' · ')}</p>
                  </div>
                  <button type="button" className={buttonClass} onClick={() => { setMessage(''); setLyricAiEditorOpen(true); }}>{t("编辑歌词 AI")}</button>
                </div>
              </Section>
              {lyricAiEditorOpen && <SettingsEditDialog title={t("编辑歌词 AI")} message={message} busy={busy} onClose={() => {
                setDraft((current) => ({ ...current, 'lyrics.ai': overview.settings['lyrics.ai'].value }));
                setLyricAiEditorOpen(false);
              }}>
                <form onSubmit={(event) => void saveSetting(event, 'lyrics.ai')} className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                  <Field label={t("目标译文语言")} hint={t("实例内所有用户共用一份译文；修改后旧译文不会自动变成新语言。")}><SelectControl aria-label={t("目标译文语言")} className={inputClass} value={draft['lyrics.ai']?.targetLanguage || 'zh'} onChange={(event) => setLyricTargetLanguage(event.target.value)}>
                    {ALL_LANGUAGES.filter(({ code }) => !['instrumental', 'other'].includes(code)).map(({ code, label }) => <option key={code} value={code}>{t(label)}</option>)}
                  </SelectControl></Field>
                  <Field label={t("温度（0～2）")}><input className={inputClass} type="number" min="0" max="2" step="0.1" value={draft['lyrics.ai']?.temperature ?? 0.2} onChange={(event) => setLyricAiField('temperature', Number(event.target.value))} /></Field>
                  <div className="min-w-0 space-y-2">
                    <label htmlFor="lyrics-ai-style-rules" className="block text-xs font-semibold text-[var(--ink)]">{t("歌词处理准则")}</label>
                    <textarea id="lyrics-ai-style-rules" className={`${inputClass} min-h-64 resize-y`} maxLength={8000} value={draft['lyrics.ai']?.styleRules || ''} onChange={(event) => setLyricAiField('styleRules', event.target.value)} />
                    <button type="button" className="text-xs font-medium text-[var(--accent)] hover:underline" onClick={() => setLyricAiField('styleRules', overview.defaults?.lyrics?.styleRules || '')}>{t("重置为系统默认准则")}</button>
                  </div>
                  <fieldset className="min-w-0 space-y-4">
                    <legend className="text-xs font-semibold text-[var(--ink)]">{t("处理功能")}</legend>
                    <div className="space-y-4 text-sm">
                      {[
                        ['completionEnabled', t("启用歌词 AI 补全（关闭后工作台入口隐藏）")],
                        ['automaticCompletionEnabled', t("播放时自动补全缺少目标语言译文的歌词")],
                        ['cleanDirtyLyrics', t("清理非演唱歌词整行")],
                        ['translateLyrics', t("生成目标语言译文")],
                        ['detectLanguage', t("识别并更新歌曲语言")],
                        ['referenceExistingTranslation', t("将同语言旧译文作为翻译参考")],
                      ].map(([key, label]) => <label key={key} className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5" checked={Boolean(draft['lyrics.ai']?.[key])} onChange={(event) => setLyricAiField(key, event.target.checked)} /><span>{label}</span></label>)}
                    </div>
                  </fieldset>
                  <div className="flex justify-end border-t border-[var(--line)] pt-5 sm:col-span-2">
                    <button type="submit" className={buttonClass} disabled={busy}>{t("保存歌词 AI 设置")}</button>
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
                    <h2 className="text-sm font-bold text-[var(--ink)]">{t("账号列表")}</h2>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--line)] text-[var(--muted)] font-mono font-medium">
                      {overview.accounts?.length || 0}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--muted)] mt-1">{t("临时密码需在首次登录后修改；最后一位可用管理员不可停用或降权。")}</p>
                </div>

                {!isCreatingAccount && (
                  <button
                    type="button"
                    onClick={() => setIsCreatingAccount(true)}
                    className="primary-button inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold cursor-pointer shadow-xs shrink-0"
                  >
                    <UserPlus size={14} />
                    <span>{t("创建新账号")}</span>
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
                        <h3 className="text-xs font-bold text-[var(--ink)]">{t("创建新成员账号")}</h3>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsCreatingAccount(false)}
                      className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5 transition-colors cursor-pointer"
                      title={t("关闭创建卡片")}
                      aria-label={t("关闭创建卡片")}
                    >
                      <X size={15} />
                    </button>
                  </div>

                  <form onSubmit={createAccount} className="grid gap-3.5 sm:grid-cols-2">
                    <Field label={t("用户名")}>
                      <input className={inputClass} name="username" pattern={'[a-z0-9_.\\-]{3,64}'} minLength={3} maxLength={64} autoComplete="off" required placeholder={t("如 alex_turner")} />
                    </Field>
                    <Field label={t("显示名称")}>
                      <input className={inputClass} name="displayName" maxLength={80} autoComplete="off" placeholder={t("用户昵称")} />
                    </Field>
                    <Field label={t("角色")}>
                      <SelectControl aria-label={t("角色")} className={inputClass} name="role">
                        <option value="member">{t("普通成员")}</option>
                        <option value="admin">{t("系统管理员")}</option>
                      </SelectControl>
                    </Field>
                    <Field label={t("一次性临时密码")} hint={t("至少 8 个字符。")}>
                      <input className={inputClass} type="password" name="temporaryPassword" autoComplete="new-password" minLength={8} maxLength={1024} required placeholder={t("初始临时密码")} />
                    </Field>
                    <div className="sm:col-span-2 pt-2 flex items-center gap-2">
                      <button className={buttonClass} type="submit" disabled={busy}>{t("确认创建账号")}</button>
                      <button
                        type="button"
                        onClick={() => setIsCreatingAccount(false)}
                        className="rounded-xl px-4 py-2 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5 transition-colors cursor-pointer"
                      >{t("取消")}</button>
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
                  <div className="wallpaper-content-surface p-8 text-center rounded-2xl border border-[var(--line)] bg-[var(--surface)] text-xs text-[var(--muted)]">{t("暂无账号数据。")}</div>
                )}
              </div>
            </div>
          )}

          {/* 系统 */}
          {tab === 'system' && (
            <div className="space-y-6">
              <GoogleAdminSettings key={authSession.user.accountId} session={authSession} />
              <IngestDevicesPanel />
              <Section title={t("运行概况")}>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div className="wallpaper-content-surface p-4 rounded-2xl bg-[var(--surface)] border border-[var(--line)]">
                    <dt className="text-xs text-[var(--muted)]">{t("应用版本")}</dt>
                    <dd className="mt-1 text-sm font-bold text-[var(--ink)]">FlareTune {__APP_VERSION__}</dd>
                  </div>
                  <div className="wallpaper-content-surface p-4 rounded-2xl bg-[var(--surface)] border border-[var(--line)]">
                    <dt className="text-xs text-[var(--muted)]">{t("实例状态")}</dt>
                    <dd className="mt-1 text-sm font-bold flex items-center gap-1.5">
                      <span className={`w-2 h-2 rounded-full ${status?.state === 'ready' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                      <span className={status?.state === 'ready' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500'}>
                        {status?.state === 'ready' ? t("就绪 (Ready)") : t("暂时无法验证")}
                      </span>
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
                  <p className="text-xs text-[var(--muted)]">{t("数据库版本")}</p>
                  <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{status?.schemaVersion ?? t("未知")} / {status?.targetVersion ?? t("未知")}</p>
                  {Number.isSafeInteger(status?.schemaVersion) && Number.isSafeInteger(status?.targetVersion)
                    && (status.schemaVersion < status.targetVersion || status.supplementalPending) && <button className={`${buttonClass} mt-3`} type="button" disabled={busy} onClick={() => void upgradeDatabase()}>{t("升级数据库")}</button>}
                  {status?.schemaVersion === status?.targetVersion && !status?.supplementalPending && <p className="mt-2 text-xs text-[var(--muted)]">{t("数据库已是当前版本。")}</p>}
                  {status?.supplementalPending && <p className="mt-2 text-xs text-[var(--muted)]">{t("有可用的 AI 接入配置迁移。")}</p>}
                </div>
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
