import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { normalizeSession, screenFor, toShellAuthSession, validLocalPassword } from './state.js';
import {
  changePassword, getInstanceStatus, getSession, login, logout, messageForError, setupInstance,
  verifySetupSecret, verifyMaintenanceSecret, runMaintenanceUpgrade,
} from './api.js';
import { AUTH_SESSION_CHECK_FAILED_EVENT, AUTH_SESSION_INVALIDATED_EVENT, AUTH_SESSION_UPDATED_EVENT } from '../authNavigation.js';
import { imageLoadRegistry } from '../utils/imageLoadRegistry.js';
import TuneWordmark from '../components/TuneWordmark.jsx';
import { GoogleSignInButton } from '../components/GoogleLogin.jsx';
import { useInstanceTheme } from './theme.js';
import { getUiLanguage, setUiLanguage, t, useLocale } from '../i18n/index.js';
import './instance.css';

const USERNAME_PATTERN = '[a-z0-9_.\\-]{3,64}';

function StatusMessage({ error, errorRef }) {
  return error ? (
    <p className="instance-error" role="alert" tabIndex={-1} ref={errorRef}>
      <AlertCircle size={16} aria-hidden="true" />
      <span>{t(error)}</span>
    </p>
  ) : null;
}

function Field({ id, label, type = 'text', autoComplete, value, onChange, hint, status, invalid = false, required = true, pattern, minLength, maxLength, ...inputProps }) {
  const [visible, setVisible] = useState(false);
  const secret = type === 'password';
  const describedBy = [hint ? `${id}-hint` : null, status ? `${id}-status` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="instance-field" data-invalid={invalid ? 'true' : undefined}>
      <label htmlFor={id}>{t(label)}</label>
      <div className="instance-input-wrap">
        <input
          id={id} name={id} type={secret && visible ? 'text' : type}
          autoComplete={autoComplete} value={value} onChange={onChange}
          required={required} pattern={pattern} minLength={minLength} maxLength={maxLength}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          {...inputProps}
        />
        {secret && (
          <button
            type="button"
            className="instance-reveal"
            aria-label={`${t(visible ? '隐藏' : '显示')} ${t(label)}`}
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        )}
      </div>
      {hint && <p id={`${id}-hint`} className="instance-hint">{t(hint)}</p>}
      {status && <p id={`${id}-status`} className="instance-field-status" role="status">{t(status)}</p>}
    </div>
  );
}

function Page({ title, description, children, footer }) {
  return (
    <main className="instance-page">
      <section className="instance-portal" aria-labelledby="instance-title">
        <TuneWordmark className="instance-wordmark" />
        <h1 id="instance-title">{t(title)}</h1>
        {description && <p className="instance-description">{t(description)}</p>}
        <div className="instance-portal__body">{children}</div>
        {footer && <div className="instance-footer">{footer}</div>}
      </section>
    </main>
  );
}

function SetupPage({ onComplete }) {
  const [setupSecret, setSetupSecret] = useState('');
  const [proof, setProof] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef(null);
  const verify = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await verifySetupSecret({ setupSecret });
      setProof(result.proof);
      setSetupSecret('');
    } catch (cause) {
      setError(messageForError(cause, 'verify_setup'));
      queueMicrotask(() => errorRef.current?.focus());
    } finally { setBusy(false); }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!validLocalPassword(password)) {
      setError('密码至少需要 8 个字符，且不能超过 1024 字节。');
      queueMicrotask(() => errorRef.current?.focus());
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致。');
      queueMicrotask(() => errorRef.current?.focus());
      return;
    }
    setBusy(true);
    setError('');
    try {
      await setupInstance({ proof, username, password });
      setProof('');
      setSetupSecret('');
      setPassword('');
      setConfirm('');
      onComplete();
    } catch (cause) {
      setError(messageForError(cause, 'setup'));
      queueMicrotask(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title={proof ? '创建管理员' : '验证初始化密钥'} description={proof ? '将初始化数据库并创建首个管理员。' : undefined}>
      <form onSubmit={proof ? submit : verify} className="instance-form">
        <StatusMessage error={error} errorRef={errorRef} />
        {!proof ? <Field id="setup-secret" label="初始化密钥" type="password" autoComplete="off" value={setupSecret} onChange={(event) => setSetupSecret(event.target.value)} /> : <>
          <Field id="setup-username" label="管理员用户名" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} pattern={USERNAME_PATTERN} minLength={3} maxLength={64} hint="3–64 位小写英文字母、数字、下划线、句点或连字符。" />
          <Field id="setup-password" label="密码" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} hint="至少 8 个字符。" />
          <Field id="setup-confirm" label="确认密码" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </>}
        <button className="instance-primary" type="submit" disabled={busy} data-busy={busy ? 'true' : undefined}>{t(busy ? '请稍候…' : proof ? '初始化并创建管理员' : '验证密钥')}</button>
      </form>
    </Page>
  );
}

function MaintenancePage({ onRefresh }) {
  const [setupSecret, setSetupSecret] = useState('');
  const [proof, setProof] = useState('');
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const errorRef = useRef(null);
  const verify = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await verifyMaintenanceSecret({ setupSecret });
      setProof(result.proof);
      setSetupSecret('');
    } catch (cause) {
      setError(messageForError(cause, 'verify_setup'));
      queueMicrotask(() => errorRef.current?.focus());
    } finally { setBusy(false); }
  };
  const upgrade = async () => {
    setBusy(true); setError('');
    try {
      const result = await runMaintenanceUpgrade({ proof, backupConfirmed });
      if (result.status === 'completed' || result.status === 'already_completed' || result.status === 'current') {
        setProof('');
        await onRefresh();
      } else if (result.status === 'lease_busy') setProgress(t('另一次升级正在进行，请稍后继续。'));
      else setProgress(t('已处理 {count} 条记录，继续升级以完成下一批。', { count: result.processed || 0 }));
    } catch (cause) {
      setError(cause?.code === 'backup_required'
        ? '检测到旧共享歌单。请先备份 D1，再用初始化密钥确认升级。'
        : messageForError(cause, 'upgrade'));
      queueMicrotask(() => errorRef.current?.focus());
    } finally { setBusy(false); }
  };
  return <Page title="数据库维护" description="实例暂停提供音乐服务。请输入初始化密钥继续已知数据库升级。">
    <div className="instance-form">
      <StatusMessage error={error} errorRef={errorRef} />
      {progress && <p className="instance-progress" role="status">{progress}</p>}
      {!proof ? <form onSubmit={verify} className="instance-form">
        <Field id="maintenance-secret" label="初始化密钥" type="password" autoComplete="off" value={setupSecret} onChange={(event) => setSetupSecret(event.target.value)} />
        <button className="instance-primary" type="submit" disabled={busy}>{t(busy ? '正在验证…' : '验证密钥')}</button>
      </form> : <div className="instance-form">
        <label className="instance-hint"><input type="checkbox" checked={backupConfirmed} onChange={(event) => setBackupConfirmed(event.target.checked)} /> {t('已备份 D1 数据库，确认可以执行涉及旧共享歌单的迁移')}</label>
        <button className="instance-primary" type="button" disabled={busy} onClick={() => void upgrade()}>{t(busy ? '正在升级…' : '继续数据库升级')}</button>
      </div>}
      <button className="instance-link" type="button" disabled={busy} onClick={onRefresh}>{t('刷新状态')}</button>
    </div>
  </Page>;
}

function LoginPage({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [credentialError, setCredentialError] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const busyRef = useRef(false);
  const errorRef = useRef(null);
  const submit = async (event) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setCredentialError(false);
    try {
      await login({ username, password });
      setPassword('');
      await onSuccess();
    } catch (cause) {
      setError(messageForError(cause, 'login'));
      // 只有凭据类失败才把字段标为无效；限速和服务不可用不是输入错误。
      setCredentialError(![429, 503, 0].includes(cause?.status));
      queueMicrotask(() => errorRef.current?.focus());
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const trackCapsLock = (event) => setCapsLock(event.getModifierState?.('CapsLock') === true);
  return (
    <main className="instance-page instance-page--login">
      <section className="instance-login" aria-labelledby="instance-title">
        <div className="instance-login__identity">
          <TuneWordmark className="instance-wordmark" />
          <div className="instance-login__headline">
            <h1 id="instance-title">{t('欢迎回来')}</h1>
            <div className="instance-login__rule" aria-hidden="true" />
          </div>
        </div>
        <div className="instance-login__access">
          <h2 id="instance-login-title">{t('登录')}</h2>
          <form onSubmit={submit} className="instance-form" aria-labelledby="instance-login-title" aria-busy={busy || undefined}>
            <StatusMessage error={error} errorRef={errorRef} />
            <Field id="login-username" label="用户名" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} invalid={credentialError} readOnly={busy} />
            <Field
              id="login-password" label="密码" type="password" autoComplete="current-password"
              value={password} onChange={(event) => setPassword(event.target.value)}
              invalid={credentialError} readOnly={busy}
              onKeyDown={trackCapsLock} onKeyUp={trackCapsLock} onBlur={() => setCapsLock(false)}
              status={capsLock ? '大写锁定已开启。' : ''}
            />
            <button className="instance-primary" type="submit" disabled={busy} aria-busy={busy || undefined} data-busy={busy ? 'true' : undefined}>
              {busy && <Loader2 className="instance-primary__spinner" size={17} aria-hidden="true" />}
              <span>{t(busy ? '正在登录…' : '登录')}</span>
            </button>
          </form>
          <GoogleSignInButton />
        </div>
      </section>
    </main>
  );
}

function ChangePasswordPage({ csrfToken, onComplete, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef(null);
  const submit = async (event) => {
    event.preventDefault();
    if (!validLocalPassword(newPassword)) {
      setError('新密码至少需要 8 个字符，且不能超过 1024 字节。');
      queueMicrotask(() => errorRef.current?.focus());
      return;
    }
    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致。');
      queueMicrotask(() => errorRef.current?.focus());
      return;
    }
    setBusy(true);
    setError('');
    try {
      await changePassword({ currentPassword, newPassword }, csrfToken);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      onComplete();
    } catch (cause) {
      setError(messageForError(cause, 'change'));
      queueMicrotask(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="设置新密码" description="临时密码只用于首次验证。设置新密码后，请重新登录。" footer={<button type="button" className="instance-link" onClick={onLogout}>{t('退出登录')}</button>}>
      <form onSubmit={submit} className="instance-form">
        <StatusMessage error={error} errorRef={errorRef} />
        <Field id="change-current" label="当前临时密码" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        <Field id="change-new" label="新密码" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} hint="至少 8 个字符。" />
        <Field id="change-confirm" label="确认新密码" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        <button className="instance-primary" type="submit" disabled={busy} data-busy={busy ? 'true' : undefined}>{t(busy ? '正在保存…' : '设置新密码')}</button>
      </form>
    </Page>
  );
}

export default function InstanceGate({ App }) {
  useLocale();
  useInstanceTheme();
  const [status, setStatus] = useState(null);
  const [session, setSession] = useState(null);
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(true);
  const [readyShellSession, setReadyShellSession] = useState(null);
  const refresh = useCallback(async () => {
    imageLoadRegistry.setSessionScope(null);
    setBusy(true);
    try {
      const nextStatus = await getInstanceStatus();
      const nextSession = nextStatus.state === 'ready' ? await getSession() : null;
      imageLoadRegistry.setSessionScope(nextSession);
      setStatus(nextStatus);
      setSession(nextSession);
      setMode(null);
    } catch {
      imageLoadRegistry.setSessionScope(null);
      setStatus({ state: 'unavailable' });
      setSession(null);
      setMode(null);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setUiLanguage(session?.authenticated ? session.user?.uiLanguage : 'auto');
  }, [session?.authenticated, session?.user?.uiLanguage]);
  useEffect(() => {
    const handleLanguageChange = () => setUiLanguage(getUiLanguage());
    window.addEventListener('languagechange', handleLanguageChange);
    return () => window.removeEventListener('languagechange', handleLanguageChange);
  }, []);
  useEffect(() => {
    let active = true;
    let unsubscribe = null;
    void import('../store/useUIStore.js').then(({ useUIStore }) => {
      if (!active) return;
      unsubscribe = useUIStore.subscribe((next, previous) => {
        if (next.authSession !== previous.authSession) {
          imageLoadRegistry.setSessionScope(next.authSession);
        }
      });
    });
    return () => { active = false; unsubscribe?.(); };
  }, []);
  useEffect(() => {
    const invalidate = () => {
      imageLoadRegistry.setSessionScope(null);
      setUiLanguage('auto');
      setSession(normalizeSession(null));
      setMode(null);
      void import('../store/useUIStore.js').then(({ useUIStore }) => {
        useUIStore.getState().setAuthSession(toShellAuthSession(null));
      });
    };
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, invalidate);
    return () => window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, invalidate);
  }, []);
  useEffect(() => {
    const unavailable = () => {
      imageLoadRegistry.setSessionScope(null);
      setUiLanguage('auto');
      setStatus({ state: 'unavailable' });
      setSession(null);
      setMode(null);
      void import('../store/useUIStore.js').then(({ useUIStore }) => {
        useUIStore.getState().setAuthSession(toShellAuthSession(null));
      });
    };
    window.addEventListener(AUTH_SESSION_CHECK_FAILED_EVENT, unavailable);
    return () => window.removeEventListener(AUTH_SESSION_CHECK_FAILED_EVENT, unavailable);
  }, []);
  useEffect(() => {
    const updated = (event) => {
      const next = normalizeSession(event.detail);
      imageLoadRegistry.setSessionScope(next);
      setSession(next);
      setMode(null);
      if (!next.authenticated || next.mustChangePassword) {
        void import('../store/useUIStore.js').then(({ useUIStore }) => {
          useUIStore.getState().setAuthSession(toShellAuthSession(null));
        });
      }
    };
    window.addEventListener(AUTH_SESSION_UPDATED_EVENT, updated);
    return () => window.removeEventListener(AUTH_SESSION_UPDATED_EVENT, updated);
  }, []);
  const current = busy ? 'loading' : mode || screenFor(status, session);
  useEffect(() => {
    if (current !== 'app') return undefined;
    let cancelled = false;
    // Load the business store only after the server has confirmed a normal session.
    void import('../store/useUIStore.js').then(({ useUIStore }) => {
      if (cancelled) return;
      useUIStore.getState().setAuthSession(toShellAuthSession(session));
      setReadyShellSession(session);
    }).catch(() => {
      if (!cancelled) setStatus({ state: 'unavailable' });
    });
    return () => { cancelled = true; };
  }, [current, session]);
  const handleLogin = async () => {
    const nextSession = await getSession();
    if (!nextSession.authenticated) throw new Error('login_session_missing');
    imageLoadRegistry.setSessionScope(nextSession);
    setSession(nextSession);
    setMode(null);
  };
  const handleLogout = async () => {
    imageLoadRegistry.setSessionScope(null);
    try {
      await logout(session?.csrfToken);
      window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
    } catch (error) {
      if (error?.status === 401) window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
      else setStatus({ state: 'unavailable' });
    }
  };
  if (current === 'loading') return <Page title="正在连接"><p className="instance-progress" role="status">{t('请稍候…')}</p></Page>;
  if (current === 'unavailable') return <Page title="暂时无法连接" description="实例状态暂时无法确认。为保护数据，应用尚未打开。"><button className="instance-primary" type="button" onClick={refresh}>{t('重新检查')}</button></Page>;
  if (current === 'setup') return <SetupPage onComplete={() => setMode('setup_complete')} />;
  if (current === 'setup_complete') return <Page title="实例已准备好"><button className="instance-primary" type="button" onClick={refresh}>{t('前往登录')}</button></Page>;
  if (current === 'maintenance') return <MaintenancePage onRefresh={refresh} />;
  if (current === 'instance_error') return <Page title="实例需要维护" description="当前实例暂时无法打开，请联系部署者检查实例状态。"><button className="instance-primary" type="button" onClick={refresh}>{t('重新检查')}</button></Page>;
  if (current === 'login') return <LoginPage onSuccess={handleLogin} />;
  if (current === 'change_password') return <ChangePasswordPage csrfToken={session?.csrfToken} onComplete={() => { imageLoadRegistry.setSessionScope(null); setSession(normalizeSession(null)); setMode('password_changed'); }} onLogout={handleLogout} />;
  if (current === 'password_changed') return <Page title="密码已更新" description="临时会话已失效。请使用新密码重新登录。"><button className="instance-primary" type="button" onClick={() => setMode(null)}>{t('前往登录')}</button></Page>;
  if (current === 'app') {
    if (readyShellSession !== session) return <Page title="正在打开 Tune" />;
    return <React.Suspense fallback={<Page title="正在打开 Tune" />}><App validatedSession={session} /></React.Suspense>;
  }
  return <Page title="无法打开应用"><button className="instance-primary" type="button" onClick={refresh}>{t('重新检查')}</button></Page>;
}
