import React from 'react';

export function preparePointerDragSettle(drag, event) {
  if (!drag || drag.settling) return false;
  if (event
    && drag.pointerId !== undefined
    && event.pointerId !== undefined
    && drag.pointerId !== event.pointerId) return false;

  const handle = drag.handleElement || event?.currentTarget;
  try {
    if (drag.pointerId !== undefined && handle?.hasPointerCapture?.(drag.pointerId)) {
      handle.releasePointerCapture(drag.pointerId);
    }
  } catch {}

  if (drag.autoScrollFrame !== null) {
    cancelAnimationFrame(drag.autoScrollFrame);
    drag.autoScrollFrame = null;
  }
  return true;
}

export function usePointerDragWindowEvents({ active, onMove, onFinish }) {
  React.useEffect(() => {
    if (!active) return undefined;
    const onPointerMove = (event) => onMove(event);
    const onPointerUp = (event) => onFinish(event, false);
    const onPointerCancel = (event) => onFinish(event, true);
    const onBlur = () => onFinish(null, false);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { capture: true });
    window.addEventListener('pointercancel', onPointerCancel, { capture: true });
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp, { capture: true });
      window.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      window.removeEventListener('blur', onBlur);
    };
  }, [active, onFinish, onMove]);
}
