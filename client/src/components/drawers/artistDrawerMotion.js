export const ARTIST_HEADER_MAX_HEIGHT = 340;
export const ARTIST_HEADER_MIN_HEIGHT = 96;
const ARTIST_HEADER_SCROLL_RANGE = ARTIST_HEADER_MAX_HEIGHT - ARTIST_HEADER_MIN_HEIGHT;

export function getArtistDrawerMotion(scrollTop, prefersReducedMotion) {
  if (prefersReducedMotion) {
    return {
      headerHeight: ARTIST_HEADER_MIN_HEIGHT,
      avatarScale: 0.64,
      badgeOpacity: 0,
      badgeTranslateY: -8,
      titleScale: 0.78,
      metaTranslateY: -2,
      photoTransform: 'none',
    };
  }

  const safeScrollTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  const clampedScroll = Math.max(0, Math.min(ARTIST_HEADER_SCROLL_RANGE, safeScrollTop));
  const progress = clampedScroll / ARTIST_HEADER_SCROLL_RANGE;
  const photoTransform = safeScrollTop < 0
    ? `scale(${1 + (-safeScrollTop / 300)})`
    : `translateY(${progress * -22}px) scale(${1 + progress * 0.05})`;

  return {
    headerHeight: Math.max(ARTIST_HEADER_MIN_HEIGHT, ARTIST_HEADER_MAX_HEIGHT - safeScrollTop),
    avatarScale: 1 - progress * 0.36,
    badgeOpacity: Math.max(0, 1 - progress * 2.2),
    badgeTranslateY: -progress * 8,
    titleScale: 1 - progress * 0.22,
    metaTranslateY: -progress * 2,
    photoTransform,
  };
}
