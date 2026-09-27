export function nearestPlaylistSlot(pointerX, pointerY, slots) {
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY) || !slots.length) return -1;

  let nearestIndex = -1;
  let nearestDistance = Infinity;
  let nearestCenterDistance = Infinity;
  for (const slot of slots) {
    const edgeX = Math.max(slot.left - pointerX, 0, pointerX - slot.right);
    const edgeY = Math.max(slot.top - pointerY, 0, pointerY - slot.bottom);
    const distance = edgeX * edgeX + edgeY * edgeY;
    const centerX = (slot.left + slot.right) / 2;
    const centerY = (slot.top + slot.bottom) / 2;
    const centerDistance = (centerX - pointerX) ** 2 + (centerY - pointerY) ** 2;
    if (distance < nearestDistance || (distance === nearestDistance && centerDistance < nearestCenterDistance)) {
      nearestIndex = slot.index;
      nearestDistance = distance;
      nearestCenterDistance = centerDistance;
    }
  }
  return nearestIndex;
}
