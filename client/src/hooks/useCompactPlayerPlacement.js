import { useUIStore } from '../store/useUIStore.js';
import { useMediaQuery } from '../components/fullscreen/useMediaQuery.js';
import { getPlugin, getPluginPage, getPluginAvailability, canAccessPluginDeclaration } from '../plugins/registry.js';
import { usePluginStore } from '../store/usePluginStore.js';

const DESKTOP_SIDEBAR_PLAYER_MEDIA = '(min-width: 1024px) and (min-height: 620px)';

export function resolveCompactPlayerPlacement({ preferred, activePage, activeRoute, pluginPage, pluginAvailable = true }) {
  if (activePage === 'assistant' || activePage === 'lyrics') return 'sidebar';
  if ((activeRoute?.page === 'plugin' || activeRoute?.pluginId) && pluginAvailable && pluginPage?.playerPlacement === 'sidebar') return 'sidebar';
  return preferred === 'sidebar' ? 'sidebar' : 'dock';
}

export function useCompactPlayerPlacement(pageOrRoute, route) {
  const activeRoute = typeof pageOrRoute === 'object' ? pageOrRoute : route;
  const activePage = typeof pageOrRoute === 'object' ? pageOrRoute.page : pageOrRoute;
  const preferred = useUIStore((state) => state.compactPlayerPlacement);
  const transition = useUIStore((state) => state.compactPlayerTransition);
  const session = useUIStore((state) => state.authSession);
  const installedIds = usePluginStore(state => state.installedIds);
  const availabilityById = usePluginStore(state => state.availabilityById);
  const plugin = activeRoute?.pluginId ? getPlugin(activeRoute.pluginId) : null;
  const pluginPage = getPluginPage(plugin, activeRoute?.pluginPage || activeRoute?.pluginSection || 'overview');
  const pluginAvailable = !!session?.authenticated && !!plugin && getPluginAvailability(plugin.id, { installedIds, availabilityById }).available
    && canAccessPluginDeclaration(pluginPage, session.user?.role);
  const canSwitchPlacement = useMediaQuery(DESKTOP_SIDEBAR_PLAYER_MEDIA, false);
  return {
    placement: resolveCompactPlayerPlacement({ preferred, activePage, activeRoute, pluginPage, pluginAvailable }),
    transition,
    canSwitchPlacement,
    isPageOverride: activePage === 'assistant' || activePage === 'lyrics' || (pluginAvailable && pluginPage?.playerPlacement === 'sidebar'),
  };
}
