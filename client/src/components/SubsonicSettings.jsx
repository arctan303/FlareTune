import React from 'react';
import { instanceRequest } from '../instance/api.js';
import { useUIStore } from '../store/useUIStore.js';
import { t, useLocale } from '../i18n/index.js';
import SettingsSection from './SettingsSection.jsx';

export default function SubsonicSettings({ session }) {
  const locale = useLocale();
  const guideUrl = `https://github.com/arctan303/FlareTune/blob/dev/guide/subsonic${locale === 'en' ? '.en' : ''}.md`;
  const [status, setStatus] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const dialog = React.useRef(null);
  const mounted = React.useRef(false);
  const accountId = session.user.accountId;
  const current = () => mounted.current && useUIStore.getState().authSession?.user?.accountId === accountId;
  const refresh = async () => {
    const next = await instanceRequest('account/subsonic');
    if (current()) setStatus(next);
  };
  React.useEffect(() => {
    mounted.current = true;
    refresh().catch(() => { if (current()) setError('客户端连接设置加载失败，请重试。'); });
    return () => { mounted.current = false; };
  }, [accountId]);
  React.useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = () => { if (!busy) { setPassword(''); setOpen(false); } };
  const save = async (enabled) => {
    if (!status || busy) return;
    setBusy(true); setError('');
    try {
      const next = await instanceRequest('account/subsonic', { method: 'PUT',
        body: { enabled, expectedRevision: status.revision, ...(enabled ? { currentPassword: password } : {}) },
        csrfToken: session.csrfToken, expectedAccountId: accountId });
      if (!current()) return;
      setStatus(next); setPassword(''); setOpen(false);
    } catch (cause) {
      if (!current()) return;
      setPassword('');
      setError(cause.status === 401 ? '密码验证失败，请重新输入当前密码。'
        : cause.status === 429 ? '尝试次数较多，请稍后再试。' : '设置未保存，请刷新后重试。');
      try { await refresh(); } catch { /* Keep the error visible. */ }
    } finally { if (current()) setBusy(false); }
  };
  return <SettingsSection title={t('第三方音乐客户端')}>
    <label className="flex min-h-11 items-center justify-between gap-4 text-sm font-semibold">
      <span>{t('允许 Subsonic 客户端连接')}</span>
      <input type="checkbox" role="switch" checked={Boolean(status?.enabled)} disabled={!status || busy}
        onChange={(event) => { if (event.target.checked) { setError(''); setOpen(true); } else save(false); }}
        className="settings-switch" />
    </label>
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs leading-relaxed text-[var(--muted)]">
      <span>{t('修改或重置密码后自动关闭。')}</span>
      <a href={guideUrl} target="_blank" rel="noopener noreferrer"
        className="text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">{t('接入说明')}</a>
    </p>
    {error && !open && <div className="mt-3 text-sm" role="alert"><p className="text-red-600">{t(error)}</p>
      <button type="button" className="mt-2 min-h-11 underline" onClick={() => {
        setError(''); refresh().catch(() => setError('客户端连接设置加载失败，请重试。'));
      }}>{t('重试')}</button></div>}
    <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); close(); }}
      className="fixed inset-0 m-auto w-[min(28rem,calc(100%-2rem))] max-h-[85dvh] overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-6 text-[var(--ink)] shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      aria-labelledby="subsonic-enable-title">
      <form onSubmit={(event) => { event.preventDefault(); save(true); }}>
        <h2 id="subsonic-enable-title" className="text-lg font-bold">{t('开启客户端连接')}</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">{t('为兼容客户端登录，将加密保存密码副本；关闭此功能或修改密码时删除。')}</p>
        <label className="mt-4 block text-sm">{t('当前密码')}
          <input type="password" autoComplete="current-password" autoFocus required value={password} disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" />
        </label>
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{t(error)}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" disabled={busy} onClick={close} className="min-h-11 px-4">{t('取消')}</button>
          <button type="submit" disabled={busy || !password} className="primary-button min-h-11 rounded-xl px-4 disabled:opacity-50">{t(busy ? '正在验证…' : '验证并开启')}</button>
        </div>
      </form>
    </dialog>
  </SettingsSection>;
}
