import React from 'react';
import { instanceRequest, messageForError } from '../instance/api.js';
import { AUTH_SESSION_INVALIDATED_EVENT } from '../authNavigation.js';
import { useUIStore } from '../store/useUIStore.js';
import { t, useLocale } from '../i18n/index.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import SettingsSkeleton from './SettingsSkeleton.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';
import { useSettingsResource } from '../hooks/useSettingsResource.js';

const inputClass = 'mt-1.5 block min-h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)] transition-colors';

export function googleReturnMessage() {
  const tag = new URLSearchParams(window.location.search).get('google');
  const messages = {
    unbound: '此 Google 账号尚未绑定可用的 FlareTune 账号，请先使用本站密码登录并绑定。',
    failed: 'Google 登录失败或已过期，请重试。',
    binding_failed: 'Google 绑定失败：账号已绑定，或本次验证已失效。请刷新后重试。',
    cancelled: 'Google 授权已取消。',
  };
  return messages[tag] || '';
}

export function GoogleSignInButton() {
  useLocale();
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(() => googleReturnMessage());
  React.useEffect(() => {
    let active = true;
    instanceRequest('auth/google/status').then(result => { if (active) setEnabled(result.enabled); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const start = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await instanceRequest('auth/google/start', { method: 'POST', body: {} });
      window.location.assign(result.url);
    } catch (cause) { setError(messageForError(cause)); setBusy(false); }
  };
  if (!enabled && !error) return null;
  return (
    <div className="instance-login__google-wrap mt-2">
      {enabled && (
        <>
          <div className="instance-login__divider" aria-hidden="true">
            <span>{t('或')}</span>
          </div>
          <button
            type="button" onClick={start} disabled={busy}
            className="instance-google-btn flex min-h-[48px] w-full items-center justify-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-5 text-sm font-semibold text-[var(--ink)] shadow-sm transition-all duration-150 hover:bg-[var(--surface)] hover:border-[var(--line-strong,var(--line))] disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" className="shrink-0" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            <span>{t(busy ? '正在连接 Google…' : '使用 Google 登录')}</span>
          </button>
        </>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
    </div>
  );
}

export function GoogleAccountSettings({ session }) {
  useLocale();
  const [busy, setBusy] = React.useState(false);
  const [action, setAction] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [message, setMessage] = React.useState(() => googleReturnMessage());
  const accountId = session.user.accountId;
  const load = React.useCallback(() => instanceRequest('account/google'), [accountId]);
  const { data: status, loading, error: loadError, refresh } = useSettingsResource(load);
  const close = () => { if (busy) return; setAction(''); setPassword(''); setMessage(''); };
  const submit = async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await instanceRequest(`account/google/${action}`, { method: 'POST', body: { currentPassword: password },
        csrfToken: session.csrfToken, expectedAccountId: accountId });
      setPassword('');
      if (useUIStore.getState().authSession.user?.accountId !== accountId) return;
      if (action === 'bind') window.location.assign(result.url);
      else window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
    } catch (cause) {
      setMessage(cause.code === 'invalid_credentials' ? '当前密码不正确。' : messageForError(cause));
      setPassword(''); setBusy(false);
    }
  };
  return <SettingsSection title={t('Google 登录')}>
    {!status && loading ? <SettingsSkeleton compact rows={1} label="正在读取…" /> : status && <div className="settings-content-enter">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="min-w-0 break-all text-xs text-[var(--muted)]">{status.bound ? (status.email || t('已绑定 Google 账号')) : t('尚未绑定 Google 账号')}</p>
        <SettingsButton variant={status.bound ? 'danger' : 'secondary'}
          disabled={busy || !status.ready || (!status.bound && !status.configured)}
          onClick={() => { setMessage(''); setAction(status.bound ? 'unbind' : 'bind'); }}
        >
          {t(status.bound ? '解绑 Google' : '绑定 Google')}
        </SettingsButton>
      </div>
      {!status.ready && <p className="mt-2 text-xs text-[var(--muted)]">{t('请管理员先完成数据库补充迁移。')}</p>}
      {status.ready && !status.configured && <p className="mt-2 text-xs text-[var(--muted)]">{t('管理员尚未配置此地址的 Google 登录。')}</p>}
    </div>}
    {loadError && <div role="alert" className="mt-3 space-y-2 text-xs text-red-600">
      <p>{t('无法读取 Google 绑定状态，请重试。')}</p>
      <SettingsButton disabled={loading} onClick={() => void refresh().catch(() => {})}>{t('重试')}</SettingsButton>
    </div>}
    {message && <p role="status" className="mt-3 text-xs">{t(message)}</p>}
    {action && <SettingsEditDialog title={t('验证当前密码')} onClose={close} busy={busy} size="small">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-[var(--muted)] leading-relaxed">{t(action === 'unbind' ? '解绑后将退出所有设备，需要重新登录。' : '验证本站密码后，前往 Google 绑定此账号。')}</p>
        <label className="block text-xs font-semibold">{t('当前密码')}<input autoFocus type="password" required autoComplete="current-password"
          className={inputClass} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {message && <p role="alert" className="text-xs text-red-600">{t(message)}</p>}
        <SettingsActions className="pt-3 border-t border-[var(--line)]">
          <SettingsButton closeDialog variant="quiet" disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在验证…' : '继续')}</SettingsButton>
        </SettingsActions>
      </form>
    </SettingsEditDialog>}
  </SettingsSection>;
}

export function GoogleAdminSettings({ session }) {
  useLocale();
  const [draft, setDraft] = React.useState(null);
  const [secret, setSecret] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const load = React.useCallback(async () => {
    const result = await instanceRequest('admin/google');
    return { ...result, callbackOrigin: result.callbackOrigin || window.location.origin };
  }, [session.user.accountId]);
  const { data: config, setData: setConfig, loading, error: loadError, refresh } = useSettingsResource(load);
  const close = () => { if (!busy) { setDraft(null); setSecret(''); setMessage(''); } };
  const edit = (enabled = config.enabled) => { setMessage(''); setSecret(''); setDraft({ ...config, enabled }); };
  const persist = async (next, clientSecret = '') => {
    if (busy) return; setBusy(true); setMessage('');
    try {
      const result = await instanceRequest('admin/google', { method: 'PUT', body: { enabled: next.enabled, clientId: next.clientId,
        callbackOrigin: next.callbackOrigin.trim(), clientSecret, revision: next.revision }, csrfToken: session.csrfToken,
        expectedAccountId: session.user.accountId });
      if (useUIStore.getState().authSession.user?.accountId !== session.user.accountId) return;
      setConfig(result); setDraft(null);
    } catch (cause) {
      setMessage(cause.code === 'configuration_changed' ? '配置已在其他页面更改，请刷新后重试。'
        : cause.code === 'google_secret_required' ? '请填写此 Client ID 对应的 Client Secret。' : '保存失败，请检查 Google 凭据和回调来源后重试。');
    } finally { setSecret(''); setBusy(false); }
  };
  const toggle = enabled => {
    if (enabled && (!config.clientId || !config.secretReady)) edit(true);
    else persist({ ...config, enabled });
  };
  const update = (field, value) => setDraft(current => ({ ...current, [field]: value }));
  return <SettingsSection title={t('Google 登录')} action={config && <SettingsActions>
    {config?.ready && <SettingsButton disabled={busy} onClick={() => edit()}>{t('修改配置')}</SettingsButton>}
    {config && <input type="checkbox" role="switch" aria-label={t('启用 Google 登录')} className="settings-switch"
      checked={Boolean(config?.enabled)} disabled={!config?.ready || busy || Boolean(draft)} onChange={event => toggle(event.target.checked)} />}
  </SettingsActions>}>
    {!config && loading ? <SettingsSkeleton compact rows={1} label="正在读取…" /> : config && !config.ready && <p className="text-xs text-[var(--muted)]">{t('请管理员先完成数据库补充迁移。')}</p>}
    {loadError && <div role="alert" className="mt-3 space-y-2 text-xs text-red-600">
      <p>{t('无法读取 Google 登录配置，请重试。')}</p>
      <SettingsButton disabled={loading} onClick={() => void refresh().catch(() => {})}>{t('重试')}</SettingsButton>
    </div>}
    {message && !draft && <p role="alert" className="mt-3 text-xs text-red-600">{t(message)}</p>}
    {draft && <SettingsEditDialog title={t('修改 Google 登录配置')} message={message} busy={busy} onClose={close}>
      <form onSubmit={event => { event.preventDefault(); persist(draft, secret); }} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 text-xs font-semibold">Client ID<input className={inputClass} value={draft.clientId} disabled={busy} maxLength={255}
            onChange={event => update('clientId', event.target.value.trim())} placeholder="….apps.googleusercontent.com" /></label>
          <label className="block min-w-0 text-xs font-semibold">Client Secret<input type="password" autoComplete="off" className={inputClass} value={secret} disabled={busy} maxLength={512}
            onChange={event => setSecret(event.target.value)} placeholder={t(draft.secretConfigured ? '留空保留已有密钥' : '请输入 Google Client Secret')} /></label>
        </div>
        {draft.secretConfigured && !draft.secretReady && <p role="alert" className="text-xs text-red-600">{t('已有密钥无法解密，请重新录入 Client Secret。')}</p>}
        <label className="block text-xs font-semibold">{t('回调来源')}<input type="url" required className={inputClass} value={draft.callbackOrigin} disabled={busy}
          onChange={event => update('callbackOrigin', event.target.value)} /></label>
        <p className="text-xs text-[var(--muted)] leading-relaxed">{t('将以下完整地址添加到 Google 控制台的 Authorized redirect URIs。')}</p>
        <code className="block break-all rounded-xl bg-[var(--surface)] p-3 text-xs font-mono">{draft.callbackOrigin.replace(/\/+$/, '')}/auth/google/callback</code>
        <SettingsActions className="pt-3 border-t border-[var(--line)]">
          <SettingsButton closeDialog variant="quiet" disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在保存…' : '保存 Google 配置')}</SettingsButton>
        </SettingsActions>
      </form>
    </SettingsEditDialog>}
  </SettingsSection>;
}
