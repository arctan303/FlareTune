// No retained exit copy: navigation stays immediate and focusable only once.
export function startNavigationMotion(element, direction) {
  if (!element?.animate) return () => {};

  const animation = element.animate([
    { opacity: 0.45, transform: `translateX(${direction * 10}px)` },
    { opacity: 1, transform: 'translateX(0)' },
  ], { duration: 180, easing: 'cubic-bezier(0.2, 0.75, 0.2, 1)' });
  return () => animation.cancel();
}
