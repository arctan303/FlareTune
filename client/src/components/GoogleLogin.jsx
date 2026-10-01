import React from 'react';
import { instanceRequest, messageForError } from '../instance/api.js';
import { AUTH_SESSION_INVALIDATED_EVENT } from '../authNavigation.js';
import { useUIStore } from '../store/useUIStore.js';
import { t, useLocale } from '../i18n/index.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';

const inputClass = 'mt-1.5 block min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3.5 text-sm text-[var(--ink)]';
const buttonClass = 'primary-button min-h-11 rounded-xl px-5 text-sm font-semibold disabled:opacity-60';

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
  return <div className="mt-4 space-y-3">
    {enabled && <button type="button" onClick={start} disabled={busy}
      className="min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-5 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface)] disabled:opacity-60">
      {t(busy ? '正在连接 Google…' : '使用 Google 登录')}
    </button>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
  </div>;
}

export function GoogleAccountSettings({ session }) {
  useLocale();
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [action, setAction] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [message, setMessage] = React.useState(() => googleReturnMessage());
  const dialog = React.useRef(null);
  const accountId = session.user.accountId;
  React.useEffect(() => {
    let active = true;
    instanceRequest('account/google').then(result => { if (active) setStatus(result); }).catch(() => { if (active) setMessage('无法读取 Google 绑定状态，请刷新重试。'); });
    return () => { active = false; };
  }, [accountId]);
  React.useEffect(() => { if (action) dialog.current?.showModal(); }, [action]);
  const close = () => { if (busy) return; dialog.current?.close(); setAction(''); setPassword(''); };
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
    {!status ? <p role="status">{t('正在读取…')}</p> : <>
      <div className="flex items-center justify-between gap-4">
      <p className="min-w-0 break-all text-sm text-[var(--muted)]">{status.bound ? (status.email || t('已绑定 Google 账号')) : t('尚未绑定 Google 账号')}</p>
      <button type="button" className={`${buttonClass} shrink-0`} disabled={busy || !status.ready || (!status.bound && !status.configured)}
        onClick={() => { setMessage(''); setAction(status.bound ? 'unbind' : 'bind'); }}>{t(status.bound ? '解绑 Google' : '绑定 Google')}</button>
      </div>
      {!status.ready && <p className="mt-2 text-sm text-[var(--muted)]">{t('请管理员先完成数据库补充迁移。')}</p>}
      {status.ready && !status.configured && <p className="mt-2 text-sm text-[var(--muted)]">{t('管理员尚未配置此地址的 Google 登录。')}</p>}
    </>}
    {message && <p role="status" className="mt-3 text-sm">{t(message)}</p>}
    {action && <dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} aria-label={t('验证当前密码')}
      className="fixed inset-0 m-auto max-h-[85dvh] w-[min(92vw,28rem)] overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-6 text-[var(--ink)] shadow-2xl backdrop:bg-black/45">
      <form onSubmit={submit} className="space-y-4">
        <h2 className="text-lg font-semibold">{t('验证当前密码')}</h2>
        <p className="text-sm text-[var(--muted)]">{t(action === 'unbind' ? '解绑后将退出所有设备，需要重新登录。' : '验证本站密码后，前往 Google 绑定此账号。')}</p>
        <label className="block text-sm">{t('当前密码')}<input autoFocus type="password" required autoComplete="current-password"
          className={inputClass} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {message && <p role="alert" className="text-sm text-red-600">{t(message)}</p>}
        <div className="flex gap-3"><button className={buttonClass} disabled={busy}>{t(busy ? '正在验证…' : '继续')}</button>
          <button type="button" onClick={close} disabled={busy} className="min-h-11 px-4">{t('取消')}</button></div>
      </form>
    </dialog>}
  </SettingsSection>;
}

export function GoogleAdminSettings({ session }) {
  useLocale();
  const [config, setConfig] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [secret, setSecret] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  React.useEffect(() => {
    let active = true;
    instanceRequest('admin/google').then(result => { if (active) setConfig({ ...result, callbackOrigin: result.callbackOrigin || window.location.origin }); })
      .catch(() => { if (active) setMessage('无法读取 Google 登录配置，请刷新重试。'); });
    return () => { active = false; };
  }, [session.user.accountId]);
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
  return <SettingsSection title={<div className="flex min-h-11 items-center justify-between gap-4">
    <span className="min-w-0">{t('Google 登录')}</span>
    <div className="flex shrink-0 items-center gap-3">
    {config?.ready && <button type="button" disabled={busy} className={buttonClass} onClick={() => edit()}>{t('修改配置')}</button>}
    <input type="checkbox" role="switch" aria-label={t('启用 Google 登录')} className="settings-switch"
      checked={Boolean(config?.enabled)} disabled={!config?.ready || busy || Boolean(draft)} onChange={event => toggle(event.target.checked)} />
    </div>
  </div>}>
    {!config ? <p role="status">{t('正在读取…')}</p> : !config.ready && <p>{t('请管理员先完成数据库补充迁移。')}</p>}
    {message && !draft && <p role="alert" className="mt-3 text-sm text-red-600">{t(message)}</p>}
    {draft && <SettingsEditDialog title={t('修改 Google 登录配置')} message={message} busy={busy} onClose={close}>
      <form onSubmit={event => { event.preventDefault(); persist(draft, secret); }} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 text-sm">Client ID<input className={inputClass} value={draft.clientId} disabled={busy} maxLength={255}
            onChange={event => update('clientId', event.target.value.trim())} placeholder="….apps.googleusercontent.com" /></label>
          <label className="block min-w-0 text-sm">Client Secret<input type="password" autoComplete="off" className={inputClass} value={secret} disabled={busy} maxLength={512}
            onChange={event => setSecret(event.target.value)} placeholder={t(draft.secretConfigured ? '留空保留已有密钥' : '请输入 Google Client Secret')} /></label>
        </div>
        {draft.secretConfigured && !draft.secretReady && <p role="alert" className="text-sm text-red-600">{t('已有密钥无法解密，请重新录入 Client Secret。')}</p>}
        <label className="block text-sm">{t('回调来源')}<input type="url" required className={inputClass} value={draft.callbackOrigin} disabled={busy}
          onChange={event => update('callbackOrigin', event.target.value)} /></label>
        <p className="text-sm text-[var(--muted)]">{t('将以下完整地址添加到 Google 控制台的 Authorized redirect URIs。')}</p>
        <code className="block break-all rounded-xl bg-[var(--surface)] p-3 text-sm">{draft.callbackOrigin.replace(/\/+$/, '')}/auth/google/callback</code>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" disabled={busy} className="min-h-11 px-4" onClick={close}>{t('取消')}</button>
          <button type="submit" disabled={busy} className={buttonClass}>{t(busy ? '正在保存…' : '保存 Google 配置')}</button>
        </div>
      </form>
    </SettingsEditDialog>}
  </SettingsSection>;
}
