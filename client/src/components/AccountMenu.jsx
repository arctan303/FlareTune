import { t } from '../i18n/index.js';
import React from 'react';
import { useUIStore } from '../store/useUIStore.js';
import { getSession } from '../instance/api.js';
import AccountAvatar from './AccountAvatar.jsx';
import { toShellAuthSession } from '../instance/state.js';
import {
  AUTH_SESSION_CHECK_FAILED_EVENT,
  AUTH_SESSION_INVALIDATED_EVENT,
  AUTH_SESSION_UPDATED_EVENT,
} from '../authNavigation.js';

// The account row stays mounted in the shell so focus and explicit auth checks keep working.
export default function AccountMenu({ onNavigate }) {
  const authSession = useUIStore((state) => state.authSession);
  const setAuthSession = useUIStore((state) => state.setAuthSession);
  const authRequestRef = React.useRef(0);

  const checkAuthSession = React.useCallback(async () => {
    const requestId = ++authRequestRef.current;
    try {
      const data = await getSession();
      if (requestId !== authRequestRef.current) return;
      if (!data.authenticated) {
        window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
        return;
      }
      if (data.mustChangePassword || data.user.accountId !== useUIStore.getState().authSession.user?.accountId) {
        window.dispatchEvent(new CustomEvent(AUTH_SESSION_UPDATED_EVENT, { detail: data }));
        return;
      }
      setAuthSession(toShellAuthSession(data));
    } catch {
      if (requestId === authRequestRef.current) {
        window.dispatchEvent(new Event(AUTH_SESSION_CHECK_FAILED_EVENT));
      }
    }
  }, [setAuthSession]);

  React.useEffect(() => {
    void checkAuthSession();
    const onFocus = () => void checkAuthSession();
    window.addEventListener('focus', onFocus);
    window.addEventListener('tune-auth-check-requested', onFocus);
    return () => {
      authRequestRef.current += 1;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('tune-auth-check-requested', onFocus);
    };
  }, [checkAuthSession]);

  const user = authSession.user;
  const name = user?.displayName || user?.username || '已登录';
  const initial = name.trim().slice(0, 1).toUpperCase();

  return (
    <div className="account-menu-wrapper account-menu-wrapper--sidebar">
      <button
        type="button"
        onClick={() => {
          onNavigate?.('settings', 'personal');
        }}
        className="app-nav-item app-nav-item--account account-menu-trigger"
        aria-label={t("我的账号：{p0}", { p0: (name) })}
        title={t("我的账号 ({p0})", { p0: (name) })}
        data-tooltip={t("我的账号")}
      >
        <AccountAvatar user={user} />
        <span className="app-nav-item__label">{name}</span>
      </button>
    </div>
  );
}
