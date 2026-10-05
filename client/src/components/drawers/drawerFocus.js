export const DRAWER_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function getDrawerFocusableElements(container) {
  if (!container?.querySelectorAll) return [];
  return Array.from(container.querySelectorAll(DRAWER_FOCUSABLE_SELECTOR)).filter((element) => (
    !element.hasAttribute?.('disabled')
    && element.getAttribute?.('aria-hidden') !== 'true'
    && element.tabIndex >= 0
    && (typeof element.getClientRects !== 'function' || element.getClientRects().length > 0)
  ));
}

export function getTopmostModal(documentRef = globalThis.document) {
  if (!documentRef?.querySelectorAll) return null;
  const visibleModals = Array.from(documentRef.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')).filter((dialog) => (
    dialog.getAttribute?.('aria-hidden') !== 'true'
    && (typeof dialog.getClientRects !== 'function' || dialog.getClientRects().length > 0)
  ));
  return visibleModals.at(-1) || null;
}

export function isTopmostModal(dialog, documentRef = globalThis.document) {
  return Boolean(dialog && getTopmostModal(documentRef) === dialog);
}

export function trapDrawerTabKey(event, container, activeElement) {
  if (event?.key !== 'Tab' || !container) return false;

  const focusable = getDrawerFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus?.();
    return true;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeInside = container.contains?.(activeElement);
  const shouldWrapBackward = event.shiftKey && (!activeInside || activeElement === first);
  const shouldWrapForward = !event.shiftKey && (!activeInside || activeElement === last);

  if (shouldWrapBackward || shouldWrapForward) {
    event.preventDefault();
    (shouldWrapBackward ? last : first).focus?.();
    return true;
  }
  return false;
}
