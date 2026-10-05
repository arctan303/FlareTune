import { useEffect, useState } from 'react';

export const isPageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function usePageVisibility() {
  const [visible, setVisible] = useState(isPageVisible);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const update = () => setVisible(isPageVisible());
    document.addEventListener('visibilitychange', update);
    update();
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}
