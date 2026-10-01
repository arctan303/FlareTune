// Owned by the authenticated app shell, never persisted across sessions.
export function createSearchPageCache({ now = Date.now, ttlMs = 15 * 60_000, limit = 20 } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.savedAt >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.page;
    },
    set(key, page) {
      entries.delete(key);
      entries.set(key, { page, savedAt: now() });
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    clear() { entries.clear(); },
    delete(key) { entries.delete(key); },
    updateSong(song) {
      for (const entry of entries.values()) {
        entry.page = { ...entry.page, songs: entry.page.songs.map((item) =>
          String(item.id) === String(song.id) ? { ...item, ...song } : item) };
      }
    },
  };
}

export const searchPageKey = (query, language) => JSON.stringify([query.trim(), language]);
