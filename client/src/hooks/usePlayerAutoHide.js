import React from 'react';
import { flushSync } from 'react-dom';
import { createPlayerAutoHide, getPlayerInteraction, subscribePlayerInteractions, acquirePlayerInteraction } from '../utils/playerAutoHide.js';
import { canHandlePlayerEscape } from '../utils/playerOverlayKeyboard.js';

export function usePlayerInteractionLock(active) {
  React.useEffect(() => active ? acquirePlayerInteraction() : undefined, [active]);
}

export function usePlayerAutoHide({ enabled, delay, surfaceRef, wakeKey, onVisibleChange }) {
  const [visible, setVisible] = React.useState(true);
  const controllerRef = React.useRef(null);
  const onVisibleChangeRef = React.useRef(onVisibleChange);
  onVisibleChangeRef.current = onVisibleChange;
  const reveal = React.useCallback(() => controllerRef.current?.reveal(), []);

  React.useEffect(() => {
    const controller = createPlayerAutoHide({ delay, onVisibleChange: value => {
      setVisible(value);
      onVisibleChangeRef.current?.(value);
    } });
    controllerRef.current = controller;
    const pointers = new Set();
    const canInteract = () => canHandlePlayerEscape(surfaceRef.current, document);
    const syncFocus = target => {
      if (getPlayerInteraction(target) && canInteract()) controller.hold('focus');
      else controller.release('focus');
    };
    const pointerOver = event => {
      if (event.pointerType === 'touch' || !canInteract()) return;
      if (getPlayerInteraction(event.target, { pointer: true })) controller.hold('hover');
      else controller.release('hover');
    };
    const pointerOut = event => {
      if (event.pointerType === 'touch') return;
      if (!getPlayerInteraction(event.relatedTarget, { pointer: true })) controller.release('hover');
    };
    const pointerDown = event => {
      if (!canInteract() || !getPlayerInteraction(event.target, { pointer: true })) return;
      pointers.add(event.pointerId);
      controller.hold('pointer');
    };
    const pointerUp = event => {
      pointers.delete(event.pointerId);
      if (!pointers.size) controller.release('pointer');
    };
    const focusIn = event => syncFocus(event.target);
    const focusOut = event => syncFocus(event.relatedTarget);
    const keyDown = event => {
      if (!canInteract() || event.key === 'Escape' || event.ctrlKey || event.metaKey || event.altKey) return;
      // Reveal before the browser computes the Tab destination, so hidden controls
      // can be inert at rest without disappearing from keyboard navigation.
      if (event.key === 'Tab' && !controller.isVisible()) flushSync(() => controller.reveal());
      else controller.reveal();
    };
    const blur = () => {
      pointers.clear();
      controller.release('pointer');
      controller.release('hover');
      controller.release('focus');
    };
    const unsubscribe = subscribePlayerInteractions(active => {
      if (active) controller.hold('open-interaction');
      else {
        controller.release('open-interaction');
        const hovered = Array.from(document.querySelectorAll('[data-player-interaction]:hover'))
          .some(region => getPlayerInteraction(region, { pointer: true }));
        if (!hovered) controller.release('hover');
      }
    });
    const events = { pointerover: pointerOver, pointerout: pointerOut, pointerdown: pointerDown,
      pointerup: pointerUp, pointercancel: pointerUp, focusin: focusIn, focusout: focusOut, keydown: keyDown };
    Object.entries(events).forEach(([name, handler]) => document.addEventListener(name, handler, true));
    window.addEventListener('blur', blur);
    syncFocus(document.activeElement);
    return () => {
      Object.entries(events).forEach(([name, handler]) => document.removeEventListener(name, handler, true));
      window.removeEventListener('blur', blur);
      unsubscribe();
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [delay, surfaceRef]);

  React.useEffect(() => { controllerRef.current?.setEnabled(enabled); }, [enabled]);
  React.useEffect(() => { reveal(); }, [reveal, wakeKey]);
  return { visible, reveal };
}
