export function handleKeyboardActivation(event, activate) {
  if (!event || event.target !== event.currentTarget) return false;
  if (event.key !== 'Enter' && event.key !== ' ') return false;

  event.preventDefault();
  event.stopPropagation();
  activate();
  return true;
}

export function isInteractiveKeyboardTarget(target) {
  return Boolean(target?.closest?.('button, select, a, [role="button"], [role="link"]'));
}
