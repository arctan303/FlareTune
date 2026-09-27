import React from 'react';
import { isTopmostModal, trapDrawerTabKey } from './drawerFocus.js';

export default function DrawerFrame({
  visible,
  hidden = false,
  isFullScreen = false,
  labelledBy,
  onClose,
  onPanelTransitionEnd,
  panelClassName = '',
  side = 'right',
  children,
}) {
  const panelRef = React.useRef(null);

  React.useEffect(() => {
    if (!visible || hidden) return undefined;
    const handleKeyDown = (event) => {
      const panel = panelRef.current;
      const dialog = panel?.closest?.('[role="dialog"]');
      if (!isTopmostModal(dialog, document)) return;
      trapDrawerTabKey(event, panel, document.activeElement);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [hidden, visible]);

  const isLeft = side === 'left';
  const motionTranslate = isLeft
    ? (visible ? 'translate-x-0' : '-translate-x-full')
    : (visible ? 'translate-x-0' : 'translate-x-full');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-hidden={!visible || hidden}
      aria-labelledby={labelledBy}
      className={`fixed inset-0 z-[100] flex ${isLeft ? 'justify-start' : 'justify-end'} ${hidden ? 'hidden' : ''} ${isFullScreen ? 'dark' : ''}`}
    >
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'} drawer-backdrop`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        data-drawer-panel="true"
        data-drawer-side={side}
        className={`theme-drawer w-full h-full relative z-10 flex flex-col transform transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${motionTranslate} ${panelClassName}`}
        onTransitionEnd={onPanelTransitionEnd}
      >
        {children}
      </div>
    </div>
  );
}
