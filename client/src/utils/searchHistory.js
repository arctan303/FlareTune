export const RECENT_SEARCHES_KEY = 'arc_recent_searches';
export const MAX_RECENT_SEARCHES = 10;

function historyKey(base, accountId) {
  return typeof accountId === 'string' && accountId.length > 0
    ? `${base}:v2:${encodeURIComponent(accountId)}` : null;
}

// Old global values have no owner; never adopt them into the next account.
export function discardUnownedSearchHistory() {
  try {
    localStorage.removeItem(RECENT_SEARCHES_KEY);
    localStorage.removeItem(RECENT_ENTITIES_KEY);
  } catch { /* Storage may be unavailable. */ }
}

export function loadRecentSearches(accountId) {
  try {
    if (typeof localStorage === 'undefined') return [];
    const key = historyKey(RECENT_SEARCHES_KEY, accountId);
    if (!key) return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_SEARCHES) : [];
  } catch {
    return [];
  }
}

export function saveRecentSearchToStorage(term, accountId) {
  const trimmed = String(term || '').trim();
  if (!trimmed) return loadRecentSearches(accountId);
  try {
    if (typeof localStorage === 'undefined') return [];
    const key = historyKey(RECENT_SEARCHES_KEY, accountId);
    if (!key) return [];
    const list = loadRecentSearches(accountId).filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
    list.unshift(trimmed);
    const updated = list.slice(0, MAX_RECENT_SEARCHES);
    localStorage.setItem(key, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export function removeRecentSearchFromStorage(term, accountId) {
  const trimmed = String(term || '').trim();
  try {
    if (typeof localStorage === 'undefined') return [];
    const key = historyKey(RECENT_SEARCHES_KEY, accountId);
    if (!key) return [];
    const list = loadRecentSearches(accountId).filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
    localStorage.setItem(key, JSON.stringify(list));
    return list;
  } catch {
    return [];
  }
}

export function clearRecentSearchesFromStorage(accountId) {
  try {
    if (typeof localStorage !== 'undefined') {
      const key = historyKey(RECENT_SEARCHES_KEY, accountId);
      if (key) localStorage.removeItem(key);
    }
  } catch {}
  return [];
}

export const RECENT_ENTITIES_KEY = 'arc_recent_search_entities';
export const MAX_RECENT_ENTITIES = 10;

export function loadRecentSearchEntities(accountId) {
  try {
    if (typeof localStorage === 'undefined') return [];
    const key = historyKey(RECENT_ENTITIES_KEY, accountId);
    if (!key) return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && (item.type === 'song' || item.type === 'artist')).slice(0, MAX_RECENT_ENTITIES)
      : [];
  } catch {
    return [];
  }
}

export function saveRecentSearchEntity(entity, accountId) {
  if (!entity || !['song', 'artist'].includes(entity.type)) return loadRecentSearchEntities(accountId);
  try {
    if (typeof localStorage === 'undefined') return [];
    const key = historyKey(RECENT_ENTITIES_KEY, accountId);
    if (!key) return [];
    const list = loadRecentSearchEntities(accountId).filter((item) => {
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
    localStorage.setItem(key, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

export function removeRecentSearchEntity(entity, accountId) {
  if (!entity || !entity.type) return loadRecentSearchEntities(accountId);
  try {
    if (typeof localStorage === 'undefined') return [];
    const key = historyKey(RECENT_ENTITIES_KEY, accountId);
    if (!key) return [];
    const list = loadRecentSearchEntities(accountId).filter((item) => {
      if (item.type !== entity.type) return true;
      if (entity.type === 'song') {
        return String(item.id) !== String(entity.id);
      }
      if (entity.type === 'artist') {
        return (item.name || '').trim().toLowerCase() !== (entity.name || '').trim().toLowerCase();
      }
      return true;
    });
    localStorage.setItem(key, JSON.stringify(list));
    return list;
  } catch {
    return [];
  }
}

export function clearRecentSearchEntities(accountId) {
  try {
    if (typeof localStorage !== 'undefined') {
      const key = historyKey(RECENT_ENTITIES_KEY, accountId);
      if (key) localStorage.removeItem(key);
    }
  } catch {}
  return [];
}
