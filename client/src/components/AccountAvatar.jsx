import React from 'react';
import { usePrivateMediaSource } from '../hooks/usePrivateMediaSource.js';
export default function AccountAvatar({ user, className = '' }) {
  const url = usePrivateMediaSource(user?.avatar?.url); const [failed, setFailed] = React.useState(false);
  React.useEffect(() => { setFailed(false); }, [url]);
  const initial = (user?.displayName || user?.username || '?').trim().slice(0, 1).toUpperCase();
  return <span className={`account-avatar-char overflow-hidden ${className}`} aria-hidden="true">
    {url && !failed ? <img src={url} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} /> : initial}
  </span>;
}
