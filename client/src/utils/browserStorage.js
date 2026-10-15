export function getBrowserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

// Retain usable session state when storage is disabled or its quota is full.
export function createResilientStorage(getStorage = getBrowserStorage) {
  const memory = new Map();
  let temporary = false;
  return {
    getItem(key) {
      if (!temporary) try {
        const storage = getStorage();
        if (storage) { const value = storage.getItem(key); if (value !== null) memory.set(key,value); return value; }
        temporary = true;
      } catch { temporary = true; }
      return memory.get(key) ?? null;
    },
    setItem(key,value) {
      memory.set(key,value);
      if (!temporary) try { const storage=getStorage(); if(storage) storage.setItem(key,value); else temporary=true; } catch { temporary=true; }
    },
    removeItem(key) {
      memory.delete(key);
      if (!temporary) try { getStorage()?.removeItem(key); } catch { temporary=true; }
    },
  };
}
