// The host owns runtime retirement. Adapters may subscribe or poll only for the
// lifetime they are given, and must return a disposer (also after async startup).
export function createPluginRuntime({ plugins, getState, subscribe, createHost, onError = () => {} }) {
  const running = new Map();
  let disposed = false;
  const stop = id => {
    const entry = running.get(id);
    if (!entry) return;
    running.delete(id); entry.controller.abort();
    try { entry.cleanup?.(); } catch { onError(id); }
  };
  const reconcile = () => {
    if (disposed) return;
    const state = getState();
    for (const plugin of plugins) {
      const row = state.rows.find(item => item.id === plugin.id);
      const isLocalDev = typeof location !== 'undefined' && location.origin === 'http://127.0.0.1:3000';
      const available = state.subject && state.loaded && isPluginVisibleToRole(plugin, state.role)
        && row?.installed && row.availability?.available !== false
        && (!row.version || row.version === plugin.version)
        && (isLocalDev || !plugin.buildDigest || row.buildDigest === plugin.buildDigest);
      const key = available ? JSON.stringify([state.subject, state.role, plugin.version, row.revision]) : '';
      if (running.get(plugin.id)?.key === key) continue;
      stop(plugin.id);
      if (!key || !plugin.start) continue;
      const entry = { key, controller: new AbortController(), cleanup: null };
      running.set(plugin.id, entry);
      const accept = cleanup => {
        if (cleanup !== undefined && typeof cleanup !== 'function') throw new TypeError('Plugin disposer required');
        if (running.get(plugin.id) !== entry || entry.controller.signal.aborted) cleanup?.();
        else entry.cleanup = cleanup;
      };
      try {
        const started = plugin.start(createHost(plugin, entry.controller.signal));
        if (started?.then) Promise.resolve(started).then(accept).catch(() => { if (running.get(plugin.id) === entry) stop(plugin.id); onError(plugin.id); });
        else accept(started);
      } catch { stop(plugin.id); onError(plugin.id); }
    }
  };
  const unsubscribe = subscribe(reconcile);
  reconcile();
  return { refresh: reconcile, dispose() {
    disposed = true; unsubscribe();
    for (const id of [...running.keys()]) stop(id);
  } };
}
import { isPluginVisibleToRole } from '../../../shared/plugins/manifest.js';
