import React from 'react';
import { useUIStore, showToast } from '../store/useUIStore.js';
import { changePassword, logout, messageForError, updateOwnProfile } from '../instance/api.js';
import { validLocalPassword } from '../instance/state.js';
import { AUTH_SESSION_INVALIDATED_EVENT } from '../authNavigation.js';
import SettingsSection from './SettingsSection.jsx';

export default function AccountSettings() {
  const authSession = useUIStore((state) => state.authSession);
  const setAuthSession = useUIStore((state) => state.setAuthSession);
  const [nickname, setNickname] = React.useState(authSession.user?.displayName || '');
  const [nicknameBusy, setNicknameBusy] = React.useState(false);
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
  const name = user?.displayName || user?.username || '已登录用户';
  const passwordInputClassName = 'mt-1.5 block min-h-11 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3.5 text-sm text-[var(--ink)]';

  React.useEffect(() => { setNickname(user?.displayName || ''); }, [user?.accountId, user?.displayName]);

  const saveNickname = async (event) => {
    event.preventDefault();
    setNicknameError('');
    setNicknameBusy(true);
    try {
      const result = await updateOwnProfile({ displayName: nickname }, authSession.csrfToken, user.accountId);
      setAuthSession((current) => current.user?.accountId === result.user.accountId
        ? { ...current, user: result.user } : current);
      setNickname(result.user.displayName);
      showToast(result.user.displayName ? '昵称已更新' : '已恢复显示用户名');
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
      showToast('已退出登录');
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
      showToast('密码已更新，请使用新密码登录');
    } catch (cause) {
      setError(messageForError(cause, 'change'));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-black tracking-tight text-[var(--ink)] sm:text-4xl">个人设置</h1>

      <SettingsSection title="账号信息">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <span className="account-avatar-char !h-14 !w-14 !text-xl" aria-hidden="true">{name.trim().slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-[var(--ink)]">{name}</p>
              {user?.username && user.username !== name && <p className="truncate text-sm text-[var(--muted)]">{user.username}</p>}
              <p className="text-sm text-[var(--muted)]">{user?.role === 'admin' ? '管理员' : '成员'}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <button
              type="button"
              onClick={() => { setError(''); setIsPasswordDialogOpen(true); }}
              className="primary-button min-h-11 rounded-xl px-5 text-sm font-semibold"
            >
              修改密码
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={busy}
              className="min-h-11 rounded-xl px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/30"
            >
              {busy && errorContext === 'logout' ? '正在退出…' : '退出登录'}
            </button>
          </div>
        </div>
        {error && errorContext === 'logout' && <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </SettingsSection>

      <SettingsSection title="展示昵称">
        <form onSubmit={saveNickname} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-sm font-medium">昵称
            <input className={passwordInputClassName} value={nickname} maxLength={80}
              onChange={(event) => setNickname(event.target.value)} placeholder={user?.username || '账号用户名'} />
          </label>
          <button type="submit" className="primary-button min-h-11 rounded-xl px-5 text-sm font-semibold disabled:opacity-60"
            disabled={nicknameBusy}>{nicknameBusy ? '正在保存…' : '保存昵称'}</button>
        </form>
        <p className="mt-2 text-sm text-[var(--muted)]">仅用于展示和助手称呼。留空后显示用户名，不影响登录。</p>
        {nicknameError && <p role="alert" className="mt-2 text-sm text-red-600">{nicknameError}</p>}
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
            <h2 id="change-password-title" className="text-lg font-semibold">修改密码</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">修改后所有设备的会话都会失效，请用新密码重新登录。</p>
            <form className="mt-6 space-y-4" onSubmit={handlePasswordChange}>
              <label className="block text-sm font-medium">当前密码<input autoFocus className={passwordInputClassName} type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
              <label className="block text-sm font-medium">新密码<input className={passwordInputClassName} type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
              <p className="text-sm text-[var(--muted)]">至少 8 个字符，建议使用独一无二的长密码。</p>
              <label className="block text-sm font-medium">确认新密码<input className={passwordInputClassName} type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
              {error && errorContext === 'password' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closePasswordDialog} disabled={busy} className="min-h-11 rounded-xl px-4 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-60">取消</button>
                <button type="submit" disabled={busy} className="primary-button min-h-11 rounded-xl px-5 text-sm font-semibold disabled:opacity-60">{busy ? '正在更新…' : '保存新密码'}</button>
              </div>
            </form>
          </div>
        </dialog>
      )}
    </div>
  );
}
