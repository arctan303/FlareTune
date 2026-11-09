import { SettingsInput, SettingsTextarea, SettingsWriteButton } from './SettingsReadOnly.jsx';
import SelectControl from './SelectControl.jsx';
import { t } from '../i18n/index.js';
import React from 'react';
import { RefreshCw, Check, Copy, UserPlus, X, Edit3, Globe, Bot, Languages, RotateCcw, Sliders } from 'lucide-react';
import { useUIStore } from '../store/useUIStore.js';
import { getAdminMigrationStatus, runAdminMigration } from '../instance/api.js';
import { validLocalPassword } from '../instance/state.js';
import AdminCatalogSection from './AdminCatalogSection.jsx';
import PageBackButton from './PageBackButton.jsx';
import Section from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import SettingsSkeleton from './SettingsSkeleton.jsx';
import { SettingsActions, SettingsButton, SettingsToggle } from './SettingsControls.jsx';
import DatabaseMigrationStatus from './DatabaseMigrationStatus.jsx';
import AccountRow from './AdminAccountRow.jsx';
import { Field, inputClass, buttonClass } from './AdminSettingsFields.jsx';
import IngestDevicesPanel from './IngestDevicesPanel.jsx';
import { GoogleAdminSettings } from './GoogleLogin.jsx';
import { ALL_LANGUAGES, getLanguageLabel } from '../constants/language.js';
import {
  adminErrorMessage, createManagedAccount, getAdminOverview, parseExactHttpsOrigins,
  putAdminSetting,
} from '../instance/adminApi.js';

const tabs = [
  ['general', '常规'], ['access', '访问'], ['catalog', '曲库'],
  ['accounts', '账号'], ['system', '系统'],
];
export default function AdminView({ onBack, embeddedTab, onTabChange }) {
  const authSession = useUIStore((state) => state.authSession);
  const csrfToken = authSession.csrfToken;
  const [tab, setTab] = React.useState(embeddedTab || 'general');
  const [overview, setOverview] = React.useState(null);
  const [draft, setDraft] = React.useState({});
  const [status, setStatus] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [isCreatingAccount, setIsCreatingAccount] = React.useState(false);
  const [nameEditorOpen, setNameEditorOpen] = React.useState(false);
  const [originsEditorOpen, setOriginsEditorOpen] = React.useState(false);
  const editorState = React.useRef({});
  editorState.current = { nameEditorOpen, originsEditorOpen };
  const refreshRequest = React.useRef(0);
  const settingRevision = React.useRef({});
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
    const request = ++refreshRequest.current;
    setLoading(true);
    setMessage('');
    try {
      const [next, nextStatus] = await Promise.all([getAdminOverview(csrfToken), getAdminMigrationStatus(csrfToken)]);
      if (request !== refreshRequest.current) return;
      setOverview(next);
      setDraft(current => Object.fromEntries(Object.entries(next.settings).map(([key, item]) => {
        const editing = key === 'instance.name' ? editorState.current.nameEditorOpen
            : key === 'cors.allowed_origins' && editorState.current.originsEditorOpen;
        return [key, editing ? current[key] : key === 'cors.allowed_origins' ? item.value.join('\n') : item.value];
      })));
      setStatus(nextStatus);
    } catch (error) { if (request === refreshRequest.current) setMessage(adminErrorMessage(error)); }
    finally { if (request === refreshRequest.current) setLoading(false); }
  }, [csrfToken]);

  React.useEffect(() => {
    setOverview(null);
    if (authSession.user?.role === 'admin') void refresh(); else setLoading(false);
    return () => { refreshRequest.current += 1; };
  }, [authSession.user?.accountId, authSession.user?.role, refresh]);

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
      const expectedRevision = settingRevision.current[key] ?? overview.settings[key].revision;
      const result = await putAdminSetting(key, value, expectedRevision, csrfToken);
      refreshRequest.current += 1;
      setLoading(false);
      setOverview((current) => ({ ...current, settings: { ...current.settings, [key]: result } }));
      setMessage(t("设置已成功保存。"));
      if (key === 'instance.name') setNameEditorOpen(false);
      if (key === 'cors.allowed_origins') setOriginsEditorOpen(false);
    } catch (error) { setMessage(error instanceof Error && !('status' in error) ? error.message : adminErrorMessage(error)); }
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
          <SettingsTextarea
            className={`${inputClass} min-h-28 font-mono`}
            value={draft[key] || ''}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
            spellCheck={false}
          />
        ) : (
          <SettingsInput
            className={inputClass}
            value={draft[key] || ''}
            onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
            maxLength={key === 'instance.name' ? 80 : 2048}
          />
        )}
      </Field>
      <SettingsActions className="pt-3 border-t border-[var(--line)]">
        <SettingsButton closeDialog variant="quiet" disabled={busy}>{t('取消')}</SettingsButton>
        <SettingsButton variant="primary" type="submit" disabled={busy}>{t(busy ? "正在保存…" : "保存设置")}</SettingsButton>
      </SettingsActions>
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
          <SettingsButton
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy}
            >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />{t("刷新数据")}</SettingsButton>
        </div>
      )}



      {message && (
        <div role="status" className="rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 text-xs">
          {t(message)}
        </div>
      )}

      {authSession.user?.role !== 'admin' ? (
        <Section title={t("无权访问")}>{t("只有管理员可以打开系统管理。")}</Section>
      ) : loading && !overview ? (
        <SettingsSkeleton cards={3} rows={2} label="正在加载实例设置…" />
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
                  {t(label)}
                </button>
              ))}
            </nav>
          )}

          {/* 常规 */}
          {(tab === 'general' || tab === 'instance') && (
            <div className="space-y-6">
              <Section
                title={t("实例名称")}
                action={
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading || busy}
                    aria-label={t("刷新数据")}
                    title={t("刷新数据")}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer transition-all shadow-2xs disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={loading ? 'animate-spin text-[var(--accent)]' : ''} />
                  </button>
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <strong className="text-base text-[var(--ink)]">{overview.settings['instance.name']?.value || t("未命名实例")}</strong>
                  <SettingsButton type="button" onClick={() => { setMessage(''); settingRevision.current['instance.name'] = overview.settings['instance.name'].revision; setNameEditorOpen(true); }} className="inline-flex items-center gap-1.5">
                    <Edit3 size={13} className="shrink-0" />
                    <span>{t("修改名称")}</span>
                  </SettingsButton>
                </div>
              </Section>
              {nameEditorOpen && <SettingsEditDialog title={t("修改实例名称")} message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'instance.name': overview.settings['instance.name']?.value || '' })); setNameEditorOpen(false); }}>
                {setting('instance.name', t("名称"), t("最多 80 个字符。"))}
              </SettingsEditDialog>}
            </div>
          )}

          {/* 访问 */}
          {(tab === 'access' || tab === 'instance') && (
            <div className="space-y-6">
              <Section title={t("附加允许来源")}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 text-sm text-[var(--ink)]">{overview.settings['cors.allowed_origins']?.value?.length ? <><strong>{overview.settings['cors.allowed_origins'].value.length}{' '}{t("个来源")}</strong><p className="mt-1 break-all text-xs text-[var(--muted)]">{overview.settings['cors.allowed_origins'].value.slice(0, 2).join(' · ')}</p></> : <span className="text-[var(--muted)]">{t("没有附加来源")}</span>}</div>
                  <SettingsButton type="button" onClick={() => { setMessage(''); settingRevision.current['cors.allowed_origins'] = overview.settings['cors.allowed_origins'].revision; setOriginsEditorOpen(true); }} className="inline-flex items-center gap-1.5">
                    <Globe size={13} className="shrink-0" />
                    <span>{t("管理来源")}</span>
                  </SettingsButton>
                </div>
              </Section>
              {originsEditorOpen && <SettingsEditDialog title={t("管理附加允许来源")} message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'cors.allowed_origins': (overview.settings['cors.allowed_origins']?.value || []).join('\n') })); setOriginsEditorOpen(false); }}>
                {setting('cors.allowed_origins', t("精确 HTTPS Origin（每行一个）"), t("例如 https://music.example.com；不接受通配符、路径或末尾斜杠。"), true)}
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
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-[var(--ink)]">{t("账号列表")}</h2>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--line)] text-[var(--muted)] font-mono font-medium">
                    {overview.accounts?.length || 0}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading || busy}
                    aria-label={t("刷新数据")}
                    title={t("刷新数据")}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer transition-all shadow-2xs disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={loading ? 'animate-spin text-[var(--accent)]' : ''} />
                  </button>
                  <SettingsButton
                    type="button"
                    variant="primary"
                    onClick={() => { setMessage(''); setIsCreatingAccount(true); }}
                    className="inline-flex items-center gap-1.5"
                  >
                    <UserPlus size={14} />
                    <span>{t("创建新账号")}</span>
                  </SettingsButton>
                </div>
              </div>

              {/* 创建账号弹窗 */}
              {isCreatingAccount && (
                <SettingsEditDialog title={t("创建新成员账号")} message={message} busy={busy} onClose={() => setIsCreatingAccount(false)}>
                  <form onSubmit={createAccount} className="grid gap-3.5 sm:grid-cols-2">
                    <Field label={t("用户名")}>
                      <SettingsInput className={inputClass} name="username" pattern={'[a-z0-9_.\\-]{3,64}'} minLength={3} maxLength={64} autoComplete="off" required placeholder={t("如 alex_turner")} />
                    </Field>
                    <Field label={t("显示名称")}>
                      <SettingsInput className={inputClass} name="displayName" maxLength={80} autoComplete="off" placeholder={t("用户昵称")} />
                    </Field>
                    <Field label={t("角色")}>
                      <SelectControl aria-label={t("角色")} className={inputClass} name="role">
                        <option value="member">{t("普通成员")}</option>
                        <option value="admin">{t("系统管理员")}</option>
                      </SelectControl>
                    </Field>
                    <Field label={t("一次性临时密码")}>
                      <SettingsInput className={inputClass} type="password" name="temporaryPassword" autoComplete="new-password" minLength={8} maxLength={1024} required placeholder={t("初始临时密码（至少 8 位）")} />
                    </Field>
                    <SettingsActions className="sm:col-span-2 pt-3 border-t border-[var(--line)]">
                      <SettingsButton closeDialog variant="quiet" disabled={busy}>{t("取消")}</SettingsButton>
                      <SettingsWriteButton className={buttonClass} type="submit" disabled={busy}>{t("确认创建账号")}</SettingsWriteButton>
                    </SettingsActions>
                  </form>
                </SettingsEditDialog>
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
              <Section
                title={t("实例与网络配置")}
                action={
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    disabled={loading || busy}
                    aria-label={t("刷新数据")}
                    title={t("刷新数据")}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer transition-all shadow-2xs disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={loading ? 'animate-spin text-[var(--accent)]' : ''} />
                  </button>
                }
              >
                <div className="divide-y divide-[var(--line)]">
                  <div className="flex flex-wrap items-center justify-between gap-4 py-3 first:pt-0">
                    <div>
                      <span className="block text-xs font-semibold text-[var(--muted)]">{t("实例名称")}</span>
                      <strong className="text-sm font-bold text-[var(--ink)] mt-0.5 block">{overview.settings['instance.name']?.value || t("未命名实例")}</strong>
                    </div>
                    <SettingsButton
                      type="button"
                      onClick={() => { setMessage(''); settingRevision.current['instance.name'] = overview.settings['instance.name'].revision; setNameEditorOpen(true); }}
                      className="inline-flex items-center gap-1.5"
                    >
                      <Edit3 size={13} className="shrink-0" />
                      <span>{t("修改名称")}</span>
                    </SettingsButton>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-4 py-3 last:pb-0">
                    <div className="min-w-0">
                      <span className="block text-xs font-semibold text-[var(--muted)]">{t("附加允许来源 (CORS)")}</span>
                      <div className="mt-0.5 text-xs text-[var(--ink)]">
                        {overview.settings['cors.allowed_origins']?.value?.length ? (
                          <>
                            <strong className="font-semibold">{overview.settings['cors.allowed_origins'].value.length} {t("个来源")}</strong>
                            <p className="mt-0.5 break-all text-[11px] text-[var(--muted)]">{overview.settings['cors.allowed_origins'].value.slice(0, 3).join(' · ')}</p>
                          </>
                        ) : (
                          <span className="text-[var(--muted)]">{t("未配置附加来源")}</span>
                        )}
                      </div>
                    </div>
                    <SettingsButton
                      type="button"
                      onClick={() => { setMessage(''); settingRevision.current['cors.allowed_origins'] = overview.settings['cors.allowed_origins'].revision; setOriginsEditorOpen(true); }}
                      className="inline-flex items-center gap-1.5"
                    >
                      <Globe size={13} className="shrink-0" />
                      <span>{t("管理来源")}</span>
                    </SettingsButton>
                  </div>
                </div>
              </Section>
              {nameEditorOpen && <SettingsEditDialog title={t("修改实例名称")} message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'instance.name': overview.settings['instance.name']?.value || '' })); setNameEditorOpen(false); }}>
                {setting('instance.name', t("名称"), t("最多 80 个字符。"))}
              </SettingsEditDialog>}
              {originsEditorOpen && <SettingsEditDialog title={t("管理附加允许来源")} message={message} busy={busy} onClose={() => { setDraft((current) => ({ ...current, 'cors.allowed_origins': (overview.settings['cors.allowed_origins']?.value || []).join('\n') })); setOriginsEditorOpen(false); }}>
                {setting('cors.allowed_origins', t("精确 HTTPS Origin（每行一个）"), t("例如 https://music.example.com；不接受通配符、路径或末尾斜杠。"), true)}
              </SettingsEditDialog>}

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
                <DatabaseMigrationStatus status={status} busy={busy} onUpgrade={() => void upgradeDatabase()} />
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
