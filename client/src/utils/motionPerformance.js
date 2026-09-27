export const VISUAL_MOTION_PROFILE = Object.freeze({
  FULL: 'full',
  COMPACT_TOUCH: 'compact-touch',
  REDUCED: 'reduced',
});

export const VISUAL_MOTION_PHASE = Object.freeze({
  IDLE: 'idle',
  THEME: 'theme-transition',
  FULLSCREEN_ENTER: 'fullscreen-enter',
  FULLSCREEN_EXIT: 'fullscreen-exit',
  DRAWER: 'drawer-transition',
});

export function resolveVisualMotionProfile({
  prefersReducedMotion = false,
  coarsePointer = false,
  hoverNone = false,
  viewportWidth = 0,
  viewportHeight = 0,
} = {}) {
  if (prefersReducedMotion) return VISUAL_MOTION_PROFILE.REDUCED;
  const isTouchDevice = Boolean(coarsePointer || hoverNone);
  if (isTouchDevice) {
    const minDimension = Math.min(viewportWidth || 0, viewportHeight || 0);
    if (minDimension >= 600) {
      return VISUAL_MOTION_PROFILE.FULL;
    }
    return VISUAL_MOTION_PROFILE.COMPACT_TOUCH;
  }
  return VISUAL_MOTION_PROFILE.FULL;
}

export function getDrawerVisibilityUpdate(currentValue, nextValue, stateKey) {
  const resolvedValue = typeof nextValue === 'function'
    ? nextValue(currentValue)
    : nextValue;
  const isPlaylistOpen = Boolean(resolvedValue);
  if (isPlaylistOpen === currentValue) return null;
  return {
    [stateKey]: isPlaylistOpen,
    visualMotionPhase: VISUAL_MOTION_PHASE.DRAWER,
  };
}

export function getPlaylistVisibilityUpdate(currentValue, nextValue) {
  return getDrawerVisibilityUpdate(currentValue, nextValue, 'isPlaylistOpen');
}

export function getVisualMotionProfile(targetWindow = window) {
  const prefersReducedMotion = targetWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = targetWindow.matchMedia('(pointer: coarse)').matches;
  const finePointer = targetWindow.matchMedia('(pointer: fine)').matches;
  const hoverNone = targetWindow.matchMedia('(hover: none)').matches;
  const hoverAvailable = targetWindow.matchMedia('(hover: hover)').matches;
  const hasTouch = typeof targetWindow.navigator !== 'undefined' && Number(targetWindow.navigator.maxTouchPoints) > 0;
  const viewport = targetWindow.visualViewport;
  const width = viewport?.width || targetWindow.innerWidth;
  const height = viewport?.height || targetWindow.innerHeight;

  // 触屏电脑通常同时报告 maxTouchPoints 和细指针/悬停能力，不能因此降级为平板动画。
  const minDimension = Math.min(width || 0, height || 0);
  const desktopInput = finePointer && hoverAvailable && minDimension >= 600;
  const touchOnlyFallback = hasTouch && !desktopInput;

  return resolveVisualMotionProfile({
    prefersReducedMotion,
    coarsePointer: coarsePointer || touchOnlyFallback,
    hoverNone,
    viewportWidth: width,
    viewportHeight: height,
  });
}
