import React from 'react';
import { Check } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore.js';
import { changePassword, logout, messageForError, updateOwnProfile, updateOwnUiLanguage } from '../instance/api.js';
import { validLocalPassword } from '../instance/state.js';
import { AUTH_SESSION_INVALIDATED_EVENT } from '../authNavigation.js';
import SettingsSection from './SettingsSection.jsx';
import SettingsEditDialog from './SettingsEditDialog.jsx';
import { SettingsActions, SettingsButton } from './SettingsControls.jsx';
import AccountAvatar from './AccountAvatar.jsx';
import UserImageEditor from './UserImageEditor.jsx';
import SubsonicSettings from './SubsonicSettings.jsx';
import { GoogleAccountSettings } from './GoogleLogin.jsx';
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
  const [isProfileDialogOpen, setIsProfileDialogOpen] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const profileButtonRef = React.useRef(null);
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
      setIsProfileDialogOpen(false);
    } catch {
      setNicknameError('昵称保存失败，请检查长度后重试。');
    } finally { setNicknameBusy(false); }
  };


  const closeProfileDialog = () => {
    if (nicknameBusy) return;
    setIsProfileDialogOpen(false);
    setNickname(user?.displayName || '');
    setNicknameError('');
  };


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
    <div className="space-y-6 sm:space-y-7 animate-[fade-in_0.2s_ease-out]">
      <header className="border-b border-[var(--line)] pb-4">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--ink)]">{t('个人设置')}</h1>
      </header>

      <SettingsSection title={t('账号信息')}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <AccountAvatar user={user} className="!h-16 !w-16 !text-2xl rounded-full border border-[var(--line)] shadow-2xs shrink-0" />
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <p className="truncate text-base font-bold text-[var(--ink)]">{name}</p>
                <span className={`px-2 py-0.5 rounded-md font-medium text-[11px] ${
                  user?.role === 'admin'
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold'
                    : 'bg-[var(--line)] text-[var(--muted)]'
                }`}>
                  {t(user?.role === 'admin' ? '系统管理员' : '普通成员')}
                </span>
              </div>
              {user?.username && (
                <p className="truncate text-xs font-mono text-[var(--muted)]">@{user.username}</p>
              )}
            </div>
          </div>

          <SettingsActions className="pt-2 sm:pt-0">
            <SettingsButton variant="primary"
              type="button"
              ref={profileButtonRef}
              onClick={() => { setNickname(user?.displayName || ''); setNicknameError(''); setIsProfileDialogOpen(true); }}
            >
              {t('编辑个人信息')}
            </SettingsButton>
            <SettingsButton
              type="button"
              onClick={() => { setError(''); setIsPasswordDialogOpen(true); }}
            >
              {t('修改密码')}
            </SettingsButton>
            <SettingsButton variant="danger"
              type="button"
              onClick={handleLogout}
              disabled={busy}
            >
              {t(busy && errorContext === 'logout' ? '正在退出…' : '退出登录')}
            </SettingsButton>
          </SettingsActions>
        </div>
        {error && errorContext === 'logout' && <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{t(error)}</p>}
      </SettingsSection>

      {user?.accountId && <SubsonicSettings key={user.accountId} session={authSession} />}
      {user?.accountId && <GoogleAccountSettings key={`google-${user.accountId}`} session={authSession} />}

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
        <SettingsEditDialog title={t('修改密码')} onClose={closePasswordDialog} busy={busy} size="small" closeOnBackdrop>
            <p className="mt-2 text-sm text-[var(--muted)]">{t('修改后所有设备的会话都会失效，请用新密码重新登录。')}</p>
            <form className="mt-6 space-y-4" onSubmit={handlePasswordChange}>
              <label className="block text-sm font-medium">{t('当前密码')}<input autoFocus className={passwordInputClassName} type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
              <label className="block text-sm font-medium">{t('新密码')}<input className={passwordInputClassName} type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
              <p className="text-sm text-[var(--muted)]">{t('至少 8 个字符。')}</p>
              <label className="block text-sm font-medium">{t('确认新密码')}<input className={passwordInputClassName} type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
              {error && errorContext === 'password' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(error)}</p>}
              <SettingsActions className="pt-2">
                <SettingsButton closeDialog variant="quiet" disabled={busy}>{t('取消')}</SettingsButton>
                <SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在更新…' : '保存新密码')}</SettingsButton>
              </SettingsActions>
            </form>
        </SettingsEditDialog>
      )}

      {isProfileDialogOpen && (
        <SettingsEditDialog title={t('编辑个人信息')} onClose={closeProfileDialog} busy={nicknameBusy} size="small" closeOnBackdrop>
            {/* 头像调整 */}
            <div className="flex items-center gap-4 p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--line)]">
              <AccountAvatar user={user} className="!h-16 !w-16 !text-2xl rounded-full border border-[var(--line)] shadow-2xs shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <span className="block text-xs font-semibold text-[var(--ink)]">{t('用户头像')}</span>
                <UserImageEditor
                  compact
                  purpose="avatar"
                  targetId="avatar"
                  slot={user?.avatar}
                  onSaved={(avatar) =>
                    setAuthSession((current) => current.user?.accountId === user.accountId ? { ...current, user: { ...current.user, avatar } } : current)}
                />
              </div>
            </div>

            {/* 昵称编辑 */}
            <form onSubmit={saveNickname} className="space-y-4">
              <div>
                <label htmlFor="modal-nickname" className="block text-xs font-semibold text-[var(--muted)] mb-1.5">{t('展示昵称')}</label>
                <input
                  id="modal-nickname"
                  className="w-full min-h-10 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] transition-colors"
                  value={nickname}
                  maxLength={80}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder={user?.username || t('账号用户名')}
                  autoFocus
                />
                {nicknameError && <p role="alert" className="mt-1.5 text-xs text-red-600">{t(nicknameError)}</p>}
              </div>

              <SettingsActions className="pt-2 border-t border-[var(--line)]">
                <SettingsButton closeDialog variant="quiet"
                  disabled={nicknameBusy}
                >
                  {t('取消')}
                </SettingsButton>
                <SettingsButton type="submit" variant="primary"
                  disabled={nicknameBusy}
                >
                  {t(nicknameBusy ? '正在保存…' : '保存')}
                </SettingsButton>
              </SettingsActions>
            </form>
        </SettingsEditDialog>
      )}
    </div>
  );
}
