import { useUIStore } from '../store/useUIStore.js';
import { usePluginStore } from '../store/usePluginStore.js';
import { getPlugin, getPluginAvailability, isPluginVisibleToRole } from '../plugins/registry.js';

export function usePluginAvailable(pluginId, feature) {
  const session = useUIStore(state => state.authSession);
  return usePluginStore(state => {
    const plugin = getPlugin(pluginId);
    if (!session?.authenticated || !state.loaded || !plugin || !isPluginVisibleToRole(plugin, session.user?.role)) return false;
    const availability = getPluginAvailability(pluginId, state);
    return availability.available && (!feature || availability.optionalFeatures?.[feature]?.available === true);
  });
}
