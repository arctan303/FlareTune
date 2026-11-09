import { create } from 'zustand';

// Only one plugin output can own the shared volume target. The plugin controls
// its device; the host retains the native audio stream and playback controls.
export const useOutputTargetStore = create(() => ({ target: null }));
export function registerOutputTarget(pluginId) {
  const lease = Symbol(pluginId);
  return {
    canClaim: () => !useOutputTargetStore.getState().target || useOutputTargetStore.getState().target.lease === lease,
    publish(target) {
      const current = useOutputTargetStore.getState().target;
      if (target && current && current.lease !== lease) return false;
      if (!target && current?.lease !== lease) return true;
      useOutputTargetStore.setState({ target: target ? { ...target, pluginId, lease } : null });
      return true;
    },
    dispose() {
      if (useOutputTargetStore.getState().target?.lease === lease) useOutputTargetStore.setState({ target: null });
    },
  };
}
