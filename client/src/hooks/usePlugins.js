import { useEffect } from 'react';
import { usePluginStore } from '../store/usePluginStore.js';
import { isDemoRuntime } from '../services/runtimeFetch.js';

export function usePlugins(session, { admin = false } = {}) {
  const state = usePluginStore();
  const scope = admin ? 'admin' : 'account';
  useEffect(() => {
    if (!session?.authenticated || isDemoRuntime) return;
    void usePluginStore.getState().refresh(session, { admin }).catch(() => {});
  }, [session?.authenticated, session?.user?.accountId, session?.user?.role, session?.csrfToken, admin]);
  return { ...state.lists[scope], installedIds: state.installedIds, availabilityById: state.availabilityById, busy: state.busy,
    error: state.lists[scope].error || state.error, demo: isDemoRuntime,
    isInstalled: state.isInstalled,
    isAvailable: state.isAvailable,
    refresh: () => usePluginStore.getState().refresh(session, { admin }),
    setInstalled: (id, installed, revision) => usePluginStore.getState().setInstalled(id, installed, revision, session) };
}
