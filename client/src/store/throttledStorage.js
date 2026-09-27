export function createThrottledStorage(storage, interval = 2000) {
  let lastSaveTime = 0;
  const pendingValues = new Map();
  const timers = new Map();
  const lastValues = new Map();

  const clearPending = (name) => {
    const timer = timers.get(name);
    if (timer) clearTimeout(timer);
    timers.delete(name);
    pendingValues.delete(name);
  };

  return {
    getItem(name) {
      const value = storage.getItem(name);
      lastValues.set(name, value);
      return value;
    },
    setItem(name, value) {
      if (lastValues.get(name) === value) {
        clearPending(name);
        return;
      }
      if (pendingValues.get(name) === value) return;

      const now = Date.now();
      if (now - lastSaveTime > interval) {
        storage.setItem(name, value);
        lastValues.set(name, value);
        clearPending(name);
        lastSaveTime = now;
        return;
      }

      pendingValues.set(name, value);
      if (timers.has(name)) return;
      timers.set(name, setTimeout(() => {
        const pendingValue = pendingValues.get(name);
        if (pendingValue !== undefined && lastValues.get(name) !== pendingValue) {
          storage.setItem(name, pendingValue);
          lastValues.set(name, pendingValue);
        }
        pendingValues.delete(name);
        timers.delete(name);
        lastSaveTime = Date.now();
      }, interval));
    },
    removeItem(name) {
      clearPending(name);
      lastValues.delete(name);
      storage.removeItem(name);
    },
  };
}

export const throttledLocalStorage = createThrottledStorage(globalThis.localStorage);
