import { useLayoutEffect, useRef } from 'react';
import { startNavigationMotion } from '../utils/navigationMotion.js';

export function resolveSidebarNavigationScope(pageOrRoute, route) {
  const activeRoute = typeof pageOrRoute === 'object' ? pageOrRoute : route;
  const activePage = typeof pageOrRoute === 'object' ? pageOrRoute.page : pageOrRoute;
  if (activeRoute?.pluginId && (activePage === 'plugin' || activePage === 'settings')) return `plugin:${activeRoute.pluginId}`;
  if (activePage === 'plugin') return 'settings';
  return ['settings', 'assistant', 'lyrics', 'plugin'].includes(activePage) ? activePage : 'primary';
}

export function useSidebarNavigationMotion(pageOrRoute, route) {
  const scope = resolveSidebarNavigationScope(pageOrRoute, route);
  const ref = useRef(null);
  const previousScope = useRef(scope);
  useLayoutEffect(() => {
    if (previousScope.current === scope) return undefined;
    previousScope.current = scope;
    return startNavigationMotion(ref.current, scope === 'primary' ? -1 : 1);
  }, [scope]);
  return ref;
}
