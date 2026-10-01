import { useLayoutEffect, useRef } from 'react';
import { startNavigationMotion } from '../utils/navigationMotion.js';

export function useSidebarNavigationMotion(activePage) {
  const scope = ['settings', 'assistant', 'lyrics'].includes(activePage) ? activePage : 'primary';
  const ref = useRef(null);
  const previousScope = useRef(scope);
  useLayoutEffect(() => {
    if (previousScope.current === scope) return undefined;
    previousScope.current = scope;
    return startNavigationMotion(ref.current, scope === 'primary' ? -1 : 1);
  }, [scope]);
  return ref;
}
