import React from 'react';
import { Check } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore.js';
import { changePassword, logout, messageForError, updateOwnProfile, updateOwnUiLanguage } from '../instance/api.js';
import { validLocalPassword } from '../instance/state.js';
import { AUTH_SESSION_INVALIDATED_EVENT } from '../authNavigation.js';
import SettingsSection from './SettingsSection.jsx';
import AccountAvatar from './AccountAvatar.jsx';
import UserImageEditor from './UserImageEditor.jsx';
import SubsonicSettings from './SubsonicSettings.jsx';
import { setUiLanguage, t, useLocale } from '../i18n/index.js';

export default function AccountSettings() {
  useLocale();
  const authSession = useUIStore((state) => state.authSession);
  const setAuthSession = useUIStore((state) => state.setAuthSession);
  const [nickname, setNickname] = React.useState(authSession.user?.displayName || '');
  const [nicknameBusy, setNicknameBusy] = React.useState(false);
  const [languageBusy, setLanguageBusy] = React.useState(false);
  const [languageError, setLanguageError] = React.useState('');
  const [nicknameError, setNicknameError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [errorContext, setErrorContext] = React.useState('password');
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const passwordDialogRef = React.useRef(null);
  const user = authSession.user;
  const name = user?.displayName || user?.username || t('已登录用户');
  const passwordInputClassName = 'mt-1.5 block min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3.5 text-sm text-[var(--ink)]';

  React.useEffect(() => { setNickname(user?.displayName || ''); }, [user?.accountId, user?.displayName]);

  const saveLanguage = async (nextLanguage) => {
    if (languageBusy || nextLanguage === (user?.uiLanguage || 'auto')) return;
    setLanguageBusy(true);
    setLanguageError('');
    try {
      await updateOwnUiLanguage(nextLanguage, authSession.csrfToken, user.accountId);
      if (useUIStore.getState().authSession?.user?.accountId !== user.accountId) return;
      setAuthSession((current) => current.user?.accountId === user.accountId
        ? { ...current, user: { ...current.user, uiLanguage: nextLanguage } } : current);
      setUiLanguage(nextLanguage);
    } catch {
      setLanguageError('界面语言保存失败，请重试。');
    } finally { setLanguageBusy(false); }
  };

  const saveNickname = async (event) => {
    event.preventDefault();
    setNicknameError('');
    setNicknameBusy(true);
    try {
      const result = await updateOwnProfile({ displayName: nickname }, authSession.csrfToken, user.accountId);
      setAuthSession((current) => current.user?.accountId === result.user.accountId
        ? { ...current, user: { ...current.user, ...result.user } } : current);
      setNickname(result.user.displayName);
      showToast(t(result.user.displayName ? '昵称已更新' : '已恢复显示用户名'));
    } catch {
      setNicknameError('昵称保存失败，请检查长度后重试。');
    } finally { setNicknameBusy(false); }
  };

  React.useEffect(() => {
    if (!isPasswordDialogOpen) return undefined;
    const dialog = passwordDialogRef.current;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [isPasswordDialogOpen]);

  const closePasswordDialog = () => {
    if (busy) return;
    setIsPasswordDialogOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  };

  const handleLogout = async () => {
    setBusy(true);
    setError('');
    setErrorContext('logout');
    try {
      await logout(authSession.csrfToken);
      window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
      showToast(t('已退出登录'));
    } catch (logoutError) {
      if (logoutError?.status === 401) {
        window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
      } else {
        setError('退出失败，请稍后重试。');
        setBusy(false);
      }
    }
  };

  const handlePasswordChange = async (event) => {
    event.preventDefault();
    setErrorContext('password');
    if (!validLocalPassword(newPassword)) {
      setError('新密码至少需要 8 个字符，且不能超过 1024 字节。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await changePassword({ currentPassword, newPassword }, authSession.csrfToken);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
      showToast(t('密码已更新，请使用新密码登录'));
    } catch (cause) {
      setError(messageForError(cause, 'change'));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-black tracking-tight text-[var(--ink)] sm:text-4xl">{t('个人设置')}</h1>

      {user?.accountId && <SubsonicSettings key={user.accountId} session={authSession} />}

      <SettingsSection title={t('账号信息')}>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <AccountAvatar user={user} className="!h-14 !w-14 !text-xl" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-[var(--ink)]">{name}</p>
              {user?.username && user.username !== name && <p className="truncate text-sm text-[var(--muted)]">{user.username}</p>}
              <p className="text-sm text-[var(--muted)]">{t(user?.role === 'admin' ? '管理员' : '成员')}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <button
              type="button"
              onClick={() => { setError(''); setIsPasswordDialogOpen(true); }}
              className="primary-button min-h-11 rounded-xl px-5 text-sm font-semibold"
            >
              {t('修改密码')}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={busy}
              className="min-h-11 rounded-xl px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              {t(busy && errorContext === 'logout' ? '正在退出…' : '退出登录')}
            </button>
          </div>
        </div>
        {error && errorContext === 'logout' && <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
      </SettingsSection>

      <SettingsSection title={t('头像')}>
        <UserImageEditor purpose="avatar" targetId="avatar" slot={user?.avatar} onSaved={avatar =>
          setAuthSession(current => current.user?.accountId === user.accountId ? { ...current, user: { ...current.user, avatar } } : current)} />
      </SettingsSection>

      <SettingsSection title={t('展示昵称')}>
        <form onSubmit={saveNickname} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-sm font-medium">{t('昵称')}
            <input className={passwordInputClassName} value={nickname} maxLength={80}
              onChange={(event) => setNickname(event.target.value)} placeholder={user?.username || t('账号用户名')} />
          </label>
          <button type="submit" className="primary-button min-h-11 rounded-xl px-5 text-sm font-semibold disabled:opacity-60"
            disabled={nicknameBusy}>{t(nicknameBusy ? '正在保存…' : '保存昵称')}</button>
        </form>
        {nicknameError && <p role="alert" className="mt-2 text-sm text-red-600">{t(nicknameError)}</p>}
      </SettingsSection>

      <SettingsSection title={t('界面语言')}>
        <div className="language-choices" role="group" aria-label={t('界面语言')} aria-busy={languageBusy}>
          {[['auto', t('跟随浏览器')], ['zh', '简体中文'], ['en', 'English']].map(([value, label]) => (
            <button type="button" key={value} className="language-choice" disabled={languageBusy}
              aria-pressed={(user?.uiLanguage || 'auto') === value} onClick={() => void saveLanguage(value)}>
              {label}{(user?.uiLanguage || 'auto') === value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
        {languageError && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{t(languageError)}</p>}
      </SettingsSection>

      {isPasswordDialogOpen && (
        <dialog
          ref={passwordDialogRef}
          aria-labelledby="change-password-title"
          className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--ink)] shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm"
          onCancel={(event) => { if (busy) event.preventDefault(); else closePasswordDialog(); }}
          onClick={(event) => { if (event.target === event.currentTarget) closePasswordDialog(); }}
        >
          <div className="p-6 sm:p-7">
            <h2 id="change-password-title" className="text-lg font-semibold">{t('修改密码')}</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">{t('修改后所有设备的会话都会失效，请用新密码重新登录。')}</p>
            <form className="mt-6 space-y-4" onSubmit={handlePasswordChange}>
              <label className="block text-sm font-medium">{t('当前密码')}<input autoFocus className={passwordInputClassName} type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
              <label className="block text-sm font-medium">{t('新密码')}<input className={passwordInputClassName} type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
              <p className="text-sm text-[var(--muted)]">{t('至少 8 个字符。')}</p>
              <label className="block text-sm font-medium">{t('确认新密码')}<input className={passwordInputClassName} type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
              {error && errorContext === 'password' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closePasswordDialog} disabled={busy} className="min-h-11 rounded-xl px-4 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-60">{t('取消')}</button>
                <button type="submit" disabled={busy} className="primary-button min-h-11 rounded-xl px-5 text-sm font-semibold disabled:opacity-60">{t(busy ? '正在更新…' : '保存新密码')}</button>
              </div>
            </form>
          </div>
        </dialog>
      )}
    </div>
  );
}
