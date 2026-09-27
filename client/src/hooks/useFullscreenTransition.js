import React from 'react';
import { VISUAL_MOTION_PHASE } from '../utils/motionPerformance.js';

const ENTER_FALLBACK_MS = 720;
const CLOSE_FALLBACK_MS = 700;

export function useFullscreenTransition({
  instantEnter = false,
  isFullScreen,
  setIsFullScreen,
  setIsFullScreenClosing,
  setVisualMotionPhase,
  focusTargetRef,
  onBeforeClose,
}) {
  const [hasMounted, setHasMounted] = React.useState(instantEnter);
  const [hasEntered, setHasEntered] = React.useState(false);
  const [isClosing, setIsClosing] = React.useState(false);
  const enterFallbackRef = React.useRef(null);
  const closeFallbackRef = React.useRef(null);
  const beforeCloseRef = React.useRef(onBeforeClose);
  beforeCloseRef.current = onBeforeClose;

  const completeEnter = React.useCallback(() => {
    if (enterFallbackRef.current) {
      clearTimeout(enterFallbackRef.current);
      enterFallbackRef.current = null;
    }
    setHasEntered(true);
    setVisualMotionPhase((current) => (
      current === VISUAL_MOTION_PHASE.FULLSCREEN_ENTER
        ? VISUAL_MOTION_PHASE.IDLE
        : current
    ));
  }, [setVisualMotionPhase]);

  const finishClose = React.useCallback(() => {
    if (closeFallbackRef.current) {
      clearTimeout(closeFallbackRef.current);
      closeFallbackRef.current = null;
    }
    setIsFullScreen(false);
    setIsFullScreenClosing(false);
    setVisualMotionPhase(VISUAL_MOTION_PHASE.IDLE);
  }, [setIsFullScreen, setIsFullScreenClosing, setVisualMotionPhase]);

  const handleClose = React.useCallback(() => {
    if (isClosing) return;
    if (enterFallbackRef.current) {
      clearTimeout(enterFallbackRef.current);
      enterFallbackRef.current = null;
    }
    beforeCloseRef.current?.();
    setIsClosing(true);
    setIsFullScreenClosing(true);
    setVisualMotionPhase(VISUAL_MOTION_PHASE.FULLSCREEN_EXIT);
    closeFallbackRef.current = setTimeout(finishClose, CLOSE_FALLBACK_MS);
  }, [finishClose, isClosing, setIsFullScreenClosing, setVisualMotionPhase]);

  const handleStageTransitionEnd = React.useCallback((event) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
    if (isClosing) finishClose();
    else completeEnter();
  }, [completeEnter, finishClose, isClosing]);

  React.useEffect(() => {
    setVisualMotionPhase(VISUAL_MOTION_PHASE.FULLSCREEN_ENTER);
    let secondFrame = null;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setHasMounted(true));
    });
    enterFallbackRef.current = setTimeout(completeEnter, ENTER_FALLBACK_MS);
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      if (enterFallbackRef.current) clearTimeout(enterFallbackRef.current);
      if (closeFallbackRef.current) clearTimeout(closeFallbackRef.current);
      setVisualMotionPhase((current) => (
        current === VISUAL_MOTION_PHASE.FULLSCREEN_ENTER
        || current === VISUAL_MOTION_PHASE.FULLSCREEN_EXIT
          ? VISUAL_MOTION_PHASE.IDLE
          : current
      ));
    };
  }, [completeEnter, setVisualMotionPhase]);

  React.useEffect(() => {
    if (isFullScreen) setIsClosing(false);
  }, [isFullScreen]);

  React.useEffect(() => {
    const previousFocus = document.activeElement;
    const frame = requestAnimationFrame(() => focusTargetRef?.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [focusTargetRef]);

  React.useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  return { hasMounted, hasEntered, isClosing, handleClose, handleStageTransitionEnd };
}
