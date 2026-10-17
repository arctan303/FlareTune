import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { VISUAL_MOTION_PHASE } from '../../utils/motionPerformance';

const DRAWER_FALLBACK_MS = 520;
const activeTransitions = new Set();

export function settleDrawerMotionPhase(setPhase = useUIStore.getState().setVisualMotionPhase) {
  if (activeTransitions.size > 0) return;
  setPhase((current) => (
    current === VISUAL_MOTION_PHASE.DRAWER ? VISUAL_MOTION_PHASE.IDLE : current
  ));
}

export function useDrawerTransition(isOpen) {
  const [mounted, setMounted] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const firstFrameRef = React.useRef(null);
  const secondFrameRef = React.useRef(null);
  const fallbackRef = React.useRef(null);
  const wasOpenRef = React.useRef(false);
  const transitionOwnerRef = React.useRef({});
  const setVisualMotionPhase = useUIStore((state) => state.setVisualMotionPhase);

  const beginTransition = React.useCallback(() => {
    activeTransitions.add(transitionOwnerRef.current);
    setVisualMotionPhase(VISUAL_MOTION_PHASE.DRAWER);
  }, [setVisualMotionPhase]);

  const releaseTransition = React.useCallback(() => {
    if (!activeTransitions.delete(transitionOwnerRef.current)) return;
    settleDrawerMotionPhase(setVisualMotionPhase);
  }, [setVisualMotionPhase]);

  const clearPending = React.useCallback(() => {
    if (firstFrameRef.current !== null) cancelAnimationFrame(firstFrameRef.current);
    if (secondFrameRef.current !== null) cancelAnimationFrame(secondFrameRef.current);
    if (fallbackRef.current !== null) clearTimeout(fallbackRef.current);
    firstFrameRef.current = null;
    secondFrameRef.current = null;
    fallbackRef.current = null;
  }, []);

  const finishTransition = React.useCallback(() => {
    clearPending();
    if (!isOpen) {
      setMounted(false);
      wasOpenRef.current = false;
    }
    releaseTransition();
  }, [clearPending, isOpen, releaseTransition]);

  React.useEffect(() => () => {
    clearPending();
    releaseTransition();
  }, [clearPending, releaseTransition]);

  React.useEffect(() => {
    clearPending();

    if (isOpen) {
      wasOpenRef.current = true;
      setMounted(true);
      beginTransition();
      firstFrameRef.current = requestAnimationFrame(() => {
        // 强制同步刷新一次整棵文档布局，确保新挂载的抽屉处于离屏起点
        // (translate-x-full) 且已被浏览器真正 layout，再允许滑入。
        // 否则在沉浸播放器等高主线程负载下，离屏起始帧会被跳过，
        // 抽屉会以 translate-x-0 直接出现，没有任何滑入动画。
        // eslint-disable-next-line no-unused-expressions
        document.body && (document.body.offsetHeight);
        secondFrameRef.current = requestAnimationFrame(() => setVisible(true));
      });
      fallbackRef.current = setTimeout(finishTransition, DRAWER_FALLBACK_MS);
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      setVisible(false);
      beginTransition();
      fallbackRef.current = setTimeout(finishTransition, DRAWER_FALLBACK_MS);
    }

    return clearPending;
  }, [beginTransition, clearPending, finishTransition, isOpen]);

  const onPanelTransitionEnd = React.useCallback((event) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
    finishTransition();
  }, [finishTransition]);

  return { mounted, visible, onPanelTransitionEnd };
}

