export function getPlayerMenuItems(menu) {
  return Array.from(menu?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') || [])
    .filter(item => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
}

export function focusPlayerMenuItem(menu, position = 'selected') {
  const items = getPlayerMenuItems(menu);
  if (!items.length) return null;
  let index = typeof position === 'number' ? position
    : position === 'last' ? items.length - 1
      : position === 'selected' ? items.findIndex(item => item.getAttribute('aria-checked') === 'true') : 0;
  index = ((Math.max(0, index) % items.length) + items.length) % items.length;
  items.forEach((item, itemIndex) => { item.tabIndex = itemIndex === index ? 0 : -1; });
  items[index].focus({ preventScroll: true });
  return items[index];
}

export function handlePlayerMenuKeyDown(event, menu) {
  const items = getPlayerMenuItems(menu);
  if (!items.length) return false;
  const active = event.target?.closest?.('[role="menuitem"], [role="menuitemradio"]');
  const index = items.indexOf(active);
  let next;
  switch (event.key) {
    case 'ArrowDown': next = (index + 1) % items.length; break;
    case 'ArrowUp': next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length; break;
    case 'Home': next = 0; break;
    case 'End': next = items.length - 1; break;
    case 'Enter':
    case ' ':
      if (index < 0) return false;
      event.preventDefault();
      event.stopPropagation();
      active.click();
      return true;
    default: return false;
  }
  event.preventDefault();
  event.stopPropagation();
  focusPlayerMenuItem(menu, next);
  return true;
}
