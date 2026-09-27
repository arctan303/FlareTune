import React from 'react';
import { flushSync } from 'react-dom';
import { getEdgeAutoScrollDelta } from '../accountPlaylistOrdering.js';
import {
  preparePointerDragSettle,
  usePointerDragWindowEvents,
} from './usePointerDragLifecycle.js';

const SETTLE_MS = 190;

export const getVerticalReorderStyle = (index, dragState) => {
  if (!dragState) return {};
  if (index === dragState.startIndex) {
    return dragState.settling
      ? {
          transform: `translate3d(0, ${dragState.offsetY}px, 0)`,
          transition: 'transform 190ms cubic-bezier(0.2, 0, 0, 1), box-shadow 190ms ease, background-color 190ms ease',
          zIndex: 50,
          position: 'relative',
        }
      : {
          transform: `translate3d(0, ${dragState.offsetY}px, 0) scale(1.02)`,
          transition: 'none',
          zIndex: 50,
          position: 'relative',
        };
  }

  let shiftY = 0;
  if (dragState.startIndex < dragState.targetIndex && index > dragState.startIndex && index <= dragState.targetIndex) {
    shiftY = -dragState.rowStride;
  } else if (dragState.startIndex > dragState.targetIndex && index >= dragState.targetIndex && index < dragState.startIndex) {
    shiftY = dragState.rowStride;
  }
  return {
    transform: shiftY ? `translate3d(0, ${shiftY}px, 0)` : 'translate3d(0, 0, 0)',
    transition: 'transform 200ms cubic-bezier(0.2, 0, 0, 1)',
  };
};

export default function useVerticalReorderDrag({
  items,
  scrollRef,
  getRow,
  getRowStride,
  cloneItems = (value) => [...value],
  onCommit,
  onCancel,
  edgeThreshold = 56,
  edgeMaxSpeed = 18,
  disabled = false,
}) {
  const [dragState, setDragState] = React.useState(null);
  const dragRef = React.useRef(null);
  const settleTimerRef = React.useRef(null);
  const itemsRef = React.useRef(items);
  const callbacksRef = React.useRef({ cloneItems, getRow, getRowStride, onCancel, onCommit });
  itemsRef.current = items;
  callbacksRef.current = { cloneItems, getRow, getRowStride, onCancel, onCommit };

  const clearDrag = React.useCallback(() => {
    const drag = dragRef.current;
    if (drag?.autoScrollFrame !== null && drag?.autoScrollFrame !== undefined) {
      cancelAnimationFrame(drag.autoScrollFrame);
    }
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    dragRef.current = null;
    setDragState(null);
  }, []);

  React.useEffect(() => () => {
    const drag = dragRef.current;
    if (drag?.autoScrollFrame !== null && drag?.autoScrollFrame !== undefined) {
      cancelAnimationFrame(drag.autoScrollFrame);
    }
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
  }, []);

  const updateTarget = React.useCallback((drag, currentScrollTop) => {
    const itemCount = itemsRef.current.length;
    const rawOffsetY = (drag.currentY - drag.startY) + (currentScrollTop - drag.initialScrollTop);
    const minSlotOffsetY = -drag.startIndex * drag.rowStride;
    const maxSlotOffsetY = (itemCount - 1 - drag.startIndex) * drag.rowStride;
    drag.offsetY = Math.max(minSlotOffsetY - 28, Math.min(maxSlotOffsetY + 28, rawOffsetY));
    drag.targetIndex = Math.max(0, Math.min(
      itemCount - 1,
      drag.startIndex + Math.round(rawOffsetY / drag.rowStride),
    ));
  }, []);

  const runAutoScroll = React.useCallback(() => {
    const drag = dragRef.current;
    const scrollBox = scrollRef.current;
    if (!drag || !scrollBox || !drag.autoScrollDelta || drag.settling) {
      if (drag) drag.autoScrollFrame = null;
      return;
    }

    const previousScrollTop = scrollBox.scrollTop;
    scrollBox.scrollBy({ top: drag.autoScrollDelta, behavior: 'auto' });
    const currentScrollTop = scrollBox.scrollTop;
    updateTarget(drag, currentScrollTop);
    setDragState({ ...drag });

    const reachedBoundary = previousScrollTop === currentScrollTop && (
      (drag.autoScrollDelta < 0 && currentScrollTop === 0)
      || (drag.autoScrollDelta > 0 && currentScrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 1)
    );
    if (reachedBoundary) {
      drag.autoScrollFrame = null;
      return;
    }
    drag.autoScrollFrame = requestAnimationFrame(runAutoScroll);
  }, [scrollRef, updateTarget]);

  const beginPointerDrag = React.useCallback((itemKey, index, event) => {
    if (disabled || itemsRef.current.length < 2) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (dragRef.current?.settling) return;
    event.preventDefault();

    const handleElement = event.currentTarget;
    try {
      handleElement.setPointerCapture?.(event.pointerId);
    } catch {}

    const row = callbacksRef.current.getRow(handleElement);
    const rowStride = callbacksRef.current.getRowStride(row);
    const scrollBox = scrollRef.current;
    const drag = {
      itemKey,
      startIndex: index,
      targetIndex: index,
      startY: event.clientY,
      currentY: event.clientY,
      initialScrollTop: scrollBox ? scrollBox.scrollTop : 0,
      offsetY: 0,
      rowStride,
      pointerId: event.pointerId,
      handleElement,
      snapshot: callbacksRef.current.cloneItems(itemsRef.current),
      autoScrollDelta: 0,
      autoScrollFrame: null,
      settling: false,
    };
    dragRef.current = drag;
    setDragState(drag);
  }, [disabled, scrollRef]);

  const movePointerDrag = React.useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.settling) return;

    const scrollBox = scrollRef.current;
    const currentScrollTop = scrollBox ? scrollBox.scrollTop : drag.initialScrollTop;
    drag.currentY = event.clientY;
    updateTarget(drag, currentScrollTop);

    if (scrollBox) {
      const rect = scrollBox.getBoundingClientRect();
      const delta = getEdgeAutoScrollDelta(
        event.clientY,
        rect.top,
        rect.bottom,
        edgeThreshold,
        edgeMaxSpeed,
      );
      drag.autoScrollDelta = delta;
      if (delta && drag.autoScrollFrame === null) {
        drag.autoScrollFrame = requestAnimationFrame(runAutoScroll);
      } else if (!delta && drag.autoScrollFrame !== null) {
        cancelAnimationFrame(drag.autoScrollFrame);
        drag.autoScrollFrame = null;
      }
    }
    setDragState({ ...drag });
  }, [edgeMaxSpeed, edgeThreshold, runAutoScroll, scrollRef, updateTarget]);

  const finishPointerDrag = React.useCallback((event = null, cancelled = false) => {
    const drag = dragRef.current;
    if (!preparePointerDragSettle(drag, event)) return;

    const fromIndex = drag.startIndex;
    const toIndex = drag.targetIndex;
    drag.settling = true;
    drag.offsetY = cancelled || fromIndex === toIndex
      ? 0
      : (toIndex - fromIndex) * drag.rowStride;
    setDragState({ ...drag });

    settleTimerRef.current = setTimeout(() => {
      flushSync(() => {
        if (cancelled) {
          callbacksRef.current.onCancel?.({ ...drag, fromIndex, toIndex });
        } else if (fromIndex !== toIndex) {
          callbacksRef.current.onCommit?.({ ...drag, fromIndex, toIndex });
        }
        settleTimerRef.current = null;
        dragRef.current = null;
        setDragState(null);
      });
    }, SETTLE_MS);
  }, []);

  usePointerDragWindowEvents({
    active: Boolean(dragState && !dragState.settling),
    onMove: movePointerDrag,
    onFinish: finishPointerDrag,
  });

  return {
    dragState,
    beginPointerDrag,
    movePointerDrag,
    finishPointerDrag,
    clearDrag,
    getRowStyle: React.useCallback((index) => getVerticalReorderStyle(index, dragState), [dragState]),
  };
}
