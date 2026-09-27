export function horizontalScrollState(element, tolerance = 2) {
  if (!element) return { overflow: false, left: false, right: false };
  const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth);
  const overflow = maxScroll > tolerance;
  return {
    overflow,
    left: overflow && element.scrollLeft > tolerance,
    right: overflow && element.scrollLeft < maxScroll - tolerance,
  };
}

export function moveHorizontalScroll(element, direction, pitch, { snap = true } = {}) {
  if (!element || !pitch) return;
  const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth);
  const next = snap
    ? (Math.round(element.scrollLeft / pitch) + direction) * pitch
    : element.scrollLeft + direction * pitch;
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollTo({ left: Math.max(0, Math.min(maxScroll, next)), behavior: reducedMotion ? 'auto' : 'smooth' });
}
