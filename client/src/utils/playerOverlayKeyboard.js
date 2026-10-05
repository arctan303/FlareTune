import { getTopmostModal } from '../components/drawers/drawerFocus.js';

const menuStacks = new WeakMap();

export function canHandlePlayerEscape(surface, documentRef = globalThis.document) {
  if (!surface || surface.closest?.('[inert]')) return false;
  const topmost = getTopmostModal(documentRef);
  const owner = surface.closest?.('dialog[open], [role="dialog"][aria-modal="true"]');
  return !topmost || topmost === owner;
}

// Capture Escape before the fullscreen window listener. Only the most recently
// opened player menu owns it, and a dialog opened above that menu takes priority.
export function registerPlayerMenuEscape({ trigger, onClose, documentRef = globalThis.document }) {
  const stack = menuStacks.get(documentRef) || [];
  const entry = {};
  stack.push(entry);
  menuStacks.set(documentRef, stack);
  const handleKeyDown = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || stack.at(-1) !== entry) return;
    if (!canHandlePlayerEscape(trigger, documentRef)) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  documentRef.addEventListener('keydown', handleKeyDown, true);
  return () => {
    documentRef.removeEventListener('keydown', handleKeyDown, true);
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0) menuStacks.delete(documentRef);
  };
}
