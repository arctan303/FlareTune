import React from 'react';
import { createPortal } from 'react-dom';

export default function FloatingTrackMenu({ anchorRef, onDismiss, label, children, onClick, autoFocusFirstItem = false }) {
  const menuRef = React.useRef(null);
  const didAutoFocusRef = React.useRef(false);
  const [position, setPosition] = React.useState(null);

  React.useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const anchorBox = anchor.getBoundingClientRect();
      const menuBox = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - menuBox.width - 8, anchorBox.right - menuBox.width));
      const below = anchorBox.bottom + 4;
      const above = anchorBox.top - menuBox.height - 4;
      const openAbove = below + menuBox.height > window.innerHeight - 8 && above >= 8;
      setPosition({ left, top: openAbove ? above : Math.min(below, window.innerHeight - menuBox.height - 8) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  React.useEffect(() => {
    if (autoFocusFirstItem && position && !didAutoFocusRef.current) {
      menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
      didAutoFocusRef.current = true;
    }
  }, [autoFocusFirstItem, position]);

  return createPortal(<>
    <div className="fixed inset-0 z-40" onClick={(event) => { event.stopPropagation(); onDismiss(); }} />
    <div ref={menuRef} className="track-row__menu" role="menu" aria-label={label} onClick={onClick}
      style={{ position: 'fixed', right: 'auto', left: position?.left ?? 0, top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden' }}>
      {children}
    </div>
  </>, document.body);
}
