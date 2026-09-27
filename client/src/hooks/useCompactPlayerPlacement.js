import { useUIStore } from '../store/useUIStore.js';
import { useMediaQuery } from '../components/fullscreen/useMediaQuery.js';

const DESKTOP_SIDEBAR_PLAYER_MEDIA = '(min-width: 1024px) and (min-height: 620px)';

export function resolveCompactPlayerPlacement({ preferred, activePage }) {
  if (activePage === 'assistant' || activePage === 'lyrics') return 'sidebar';
  return preferred === 'sidebar' ? 'sidebar' : 'dock';
}

export function useCompactPlayerPlacement(activePage) {
  const preferred = useUIStore((state) => state.compactPlayerPlacement);
  const transition = useUIStore((state) => state.compactPlayerTransition);
  const canSwitchPlacement = useMediaQuery(DESKTOP_SIDEBAR_PLAYER_MEDIA, false);
  return {
    placement: resolveCompactPlayerPlacement({ preferred, activePage }),
    transition,
    canSwitchPlacement,
    isPageOverride: activePage === 'assistant' || activePage === 'lyrics',
  };
}
