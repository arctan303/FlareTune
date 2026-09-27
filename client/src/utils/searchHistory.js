export const RECENT_SEARCHES_KEY = 'arc_recent_searches';
export const MAX_RECENT_SEARCHES = 10;

export function loadRecentSearches() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_SEARCHES) : [];
  } catch {
    return [];
  }
}

export function saveRecentSearchToStorage(term) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return loadRecentSearches();
  try {
    if (typeof localStorage === 'undefined') return [];
    const list = loadRecentSearches().filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
    list.unshift(trimmed);
    const updated = list.slice(0, MAX_RECENT_SEARCHES);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export function removeRecentSearchFromStorage(term) {
  const trimmed = String(term || '').trim();
  try {
    if (typeof localStorage === 'undefined') return [];
    const list = loadRecentSearches().filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
    return list;
  } catch {
    return [];
  }
}

export function clearRecentSearchesFromStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(RECENT_SEARCHES_KEY);
    }
  } catch {}
  return [];
}

export const RECENT_ENTITIES_KEY = 'arc_recent_search_entities';
export const MAX_RECENT_ENTITIES = 10;

export function loadRecentSearchEntities() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(RECENT_ENTITIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && (item.type === 'song' || item.type === 'artist')).slice(0, MAX_RECENT_ENTITIES)
      : [];
  } catch {
    return [];
  }
}

export function saveRecentSearchEntity(entity) {
  if (!entity || !entity.type) return loadRecentSearchEntities();
  try {
    if (typeof localStorage === 'undefined') return [];
    const list = loadRecentSearchEntities().filter((item) => {
      if (item.type !== entity.type) return true;
      if (entity.type === 'song') {
        return String(item.id) !== String(entity.id);
      }
      if (entity.type === 'artist') {
        return (item.name || '').trim().toLowerCase() !== (entity.name || '').trim().toLowerCase();
      }
      return true;
    });
    list.unshift(entity);
    const updated = list.slice(0, MAX_RECENT_ENTITIES);
    localStorage.setItem(RECENT_ENTITIES_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export function removeRecentSearchEntity(entity) {
  if (!entity || !entity.type) return loadRecentSearchEntities();
  try {
    if (typeof localStorage === 'undefined') return [];
    const list = loadRecentSearchEntities().filter((item) => {
      if (item.type !== entity.type) return true;
      if (entity.type === 'song') {
        return String(item.id) !== String(entity.id);
      }
      if (entity.type === 'artist') {
        return (item.name || '').trim().toLowerCase() !== (entity.name || '').trim().toLowerCase();
      }
      return true;
    });
    localStorage.setItem(RECENT_ENTITIES_KEY, JSON.stringify(list));
    return list;
  } catch {
    return [];
  }
}

export function clearRecentSearchEntities() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(RECENT_ENTITIES_KEY);
    }
  } catch {}
  return [];
}
