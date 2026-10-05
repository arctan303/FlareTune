import React from 'react';
import { registerPlayerMenuEscape } from '../utils/playerOverlayKeyboard.js';
import { focusPlayerMenuItem, getPlayerMenuItems, handlePlayerMenuKeyDown } from '../utils/playerMenuKeyboard.js';
import { usePlayerInteractionLock } from './usePlayerAutoHide.js';

export function usePlayerMenu({ isOpen, setIsOpen, triggerRef, menuRef, mounted = isOpen }) {
  const initialFocusRef = React.useRef('selected');
  usePlayerInteractionLock(isOpen);
  const closeMenu = React.useCallback((restoreFocus = true) => {
    setIsOpen(false);
    if (restoreFocus && triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
  }, [setIsOpen, triggerRef]);

  React.useEffect(() => {
    if (!isOpen) return undefined;
    return registerPlayerMenuEscape({ trigger: triggerRef.current, onClose: closeMenu });
  }, [closeMenu, isOpen, triggerRef]);

  React.useLayoutEffect(() => {
    if (!isOpen || !mounted || !menuRef.current) return;
    focusPlayerMenuItem(menuRef.current, initialFocusRef.current);
    initialFocusRef.current = 'selected';
  }, [isOpen, mounted, menuRef]);

  const onTriggerKeyDown = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    initialFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
    if (isOpen) focusPlayerMenuItem(menuRef.current, initialFocusRef.current);
    else setIsOpen(true);
  };
  const onMenuFocus = event => {
    const items = getPlayerMenuItems(menuRef.current);
    const item = event.target?.closest?.('[role="menuitem"], [role="menuitemradio"]');
    if (items.includes(item)) items.forEach(candidate => { candidate.tabIndex = candidate === item ? 0 : -1; });
  };
  const onMenuBlur = event => {
    if (event.relatedTarget && !menuRef.current?.contains(event.relatedTarget)) closeMenu(false);
  };
  return { closeMenu, onTriggerKeyDown, menuProps: {
    onKeyDown: event => handlePlayerMenuKeyDown(event, menuRef.current),
    onFocusCapture: onMenuFocus,
    onBlurCapture: onMenuBlur,
  } };
}
