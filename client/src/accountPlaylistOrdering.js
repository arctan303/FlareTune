export const typedPlaylistRefKey = (item) => `${item?.kind || ''}:${item?.id || ''}`;

export function resolveVisibleShelfPlaylists({
  memberPlaylists = [],
  shelf = null,
  authenticated = false,
} = {}) {
  if (!authenticated) return [];
  const membersById = new Map(
    memberPlaylists
      .filter((playlist) => playlist?.kind === 'regular' || playlist?.kind === 'favorite')
      .map((playlist) => [String(playlist.id), { ...playlist, source: 'member' }]),
  );
  const result = (Array.isArray(shelf?.items) ? shelf.items : []).flatMap((item) => {
    const playlist = item?.kind === 'member' ? membersById.get(String(item.id)) : null;
    return playlist ? [playlist] : [];
  });

  const favorite = memberPlaylists.find((playlist) => playlist?.kind === 'favorite');
  if (favorite && !result.some((p) => String(p.id) === String(favorite.id) || p.kind === 'favorite')) {
    result.unshift({ ...favorite, source: 'member' });
  }

  for (const playlist of membersById.values()) {
    if (!result.some((item) => String(item.id) === String(playlist.id))) result.push(playlist);
  }

  return result;
}

export const cloneOrderingItems = (items = []) => items.map((item) => ({
  kind: item.kind,
  id: item.id,
}));

export function moveOrderingItem(items, itemKey, targetIndex) {
  const sourceIndex = items.findIndex((item) => typedPlaylistRefKey(item) === itemKey);
  if (sourceIndex < 0 || items.length < 2) return cloneOrderingItems(items);
  const nextIndex = Math.max(0, Math.min(items.length - 1, targetIndex));
  if (sourceIndex === nextIndex) return cloneOrderingItems(items);
  const next = cloneOrderingItems(items);
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(nextIndex, 0, moved);
  return next;
}

export function moveOrderingItemBy(items, itemKey, offset) {
  const index = items.findIndex((item) => typedPlaylistRefKey(item) === itemKey);
  return index < 0 ? cloneOrderingItems(items) : moveOrderingItem(items, itemKey, index + offset);
}

export function isOrderingDirty(baseItems = [], draftItems = []) {
  if (baseItems.length !== draftItems.length) return true;
  return baseItems.some((item, index) => {
    const draft = draftItems[index];
    return typedPlaylistRefKey(item) !== typedPlaylistRefKey(draft);
  });
}

export function preserveDraftOrder(draftItems = [], serverItems = []) {
  const serverByKey = new Map(serverItems.map((item) => [typedPlaylistRefKey(item), item]));
  const merged = [];
  for (const draft of draftItems) {
    const latest = serverByKey.get(typedPlaylistRefKey(draft));
    if (!latest) continue;
    merged.push({ ...latest });
    serverByKey.delete(typedPlaylistRefKey(draft));
  }
  for (const latest of serverItems) {
    if (serverByKey.has(typedPlaylistRefKey(latest))) merged.push({ ...latest });
  }
  return merged;
}

export function getEdgeAutoScrollDelta(pointerY, top, bottom, edgeSize = 56, maxStep = 18) {
  if (![pointerY, top, bottom, edgeSize, maxStep].every(Number.isFinite) || bottom <= top || edgeSize <= 0) return 0;
  if (pointerY < top + edgeSize) {
    return -Math.ceil(maxStep * Math.min(1, (top + edgeSize - pointerY) / edgeSize));
  }
  if (pointerY > bottom - edgeSize) {
    return Math.ceil(maxStep * Math.min(1, (pointerY - (bottom - edgeSize)) / edgeSize));
  }
  return 0;
}
