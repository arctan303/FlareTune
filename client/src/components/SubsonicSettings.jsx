import React from 'react';
import { instanceRequest } from '../instance/api.js';
import { useUIStore } from '../store/useUIStore.js';
import { t, useLocale } from '../i18n/index.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import SettingsSkeleton from './SettingsSkeleton.jsx';
import { SettingsActions, SettingsButton, SettingsToggle } from './SettingsControls.jsx';
import { useSettingsResource } from '../hooks/useSettingsResource.js';

export default function SubsonicSettings({ session }) {
  const locale = useLocale();
  const guideUrl = `https://github.com/arctan303/FlareTune/blob/dev/guide/subsonic${locale === 'en' ? '.en' : ''}.md`;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const mounted = React.useRef(false);
  const accountId = session.user.accountId;
  const current = () => mounted.current && useUIStore.getState().authSession?.user?.accountId === accountId;
  const load = React.useCallback(() => instanceRequest('account/subsonic'), [accountId]);
  const { data: status, setData: setStatus, loading, error: loadError, refresh } = useSettingsResource(load);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [accountId]);
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
    {!status && loading ? <SettingsSkeleton compact rows={1} label="正在读取…" /> : status && <SettingsToggle
      label={t('允许 Subsonic 客户端连接')} checked={Boolean(status.enabled)} disabled={busy}
        onChange={(event) => { if (event.target.checked) { setError(''); setOpen(true); } else save(false); }}
      />}
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs leading-relaxed text-[var(--muted)]">
      <span>{t('修改或重置密码后自动关闭。')}</span>
      <a href={guideUrl} target="_blank" rel="noopener noreferrer"
        className="text-[var(--accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">{t('接入说明')}</a>
    </p>
    {(error || loadError) && !open && <div className="mt-3 text-sm" role="alert"><p className="text-red-600">{t(error || '客户端连接设置加载失败，请重试。')}</p>
      <SettingsButton disabled={loading} onClick={() => {
        setError(''); void refresh().catch(() => {});
      }}>{t('重试')}</SettingsButton></div>}
    {open && <SettingsEditDialog title={t('开启客户端连接')} onClose={close} busy={busy} size="small">
      <form onSubmit={(event) => { event.preventDefault(); save(true); }}>
        <p className="mt-3 text-sm text-[var(--muted)]">{t('为兼容客户端登录，将加密保存密码副本；关闭此功能或修改密码时删除。')}</p>
        <label className="mt-4 block text-sm">{t('当前密码')}
          <input type="password" autoComplete="current-password" autoFocus required value={password} disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3" />
        </label>
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{t(error)}</p>}
        <SettingsActions className="mt-5">
          <SettingsButton closeDialog variant="quiet" disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={busy || !password}>{t(busy ? '正在验证…' : '验证并开启')}</SettingsButton>
        </SettingsActions>
      </form>
    </SettingsEditDialog>}
  </SettingsSection>;
}
