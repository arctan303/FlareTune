import React from 'react';
import { getTopmostModal, isTopmostModal, trapDrawerTabKey } from '../components/drawers/drawerFocus.js';

// Keep the existing custom surfaces while sharing the drawer's keyboard contract.
export function useModalFocus({ active, modalRef, initialFocusRef, onClose, busy = false }) {
  const latest = React.useRef({ onClose, busy });
  latest.current = { onClose, busy };
  React.useEffect(() => {
    if (!active) return undefined;
    const modal = modalRef.current;
    const opener = document.activeElement;
    const frame = requestAnimationFrame(() => {
      if (!isTopmostModal(modal, document)) return;
      (initialFocusRef?.current || modal?.querySelector('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') || modal)?.focus();
    });
    const handleKeyDown = event => {
      if (!isTopmostModal(modal, document)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onClose?.();
      } else trapDrawerTabKey(event, modal, document.activeElement);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown, true);
      const top = getTopmostModal(document);
      if (opener?.isConnected && (!top || top === modal || top.contains(opener))) opener.focus({ preventScroll: true });
    };
  }, [active, modalRef, initialFocusRef]);
}
