export const createExpiringAsyncCache = ({ ttlMs, now = () => Date.now() }) => {
  const ready = new Map();
  const inFlight = new Map();

  const getFresh = (key) => {
    const entry = ready.get(key);
    if (!entry) return null;
    if (now() - entry.timestamp >= ttlMs) {
      ready.delete(key);
      return null;
    }
    return entry.value;
  };

  const refresh = (key, loader) => {
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        ready.set(key, { value, timestamp: now() });
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  };

  const load = (key, loader) => {
    const cached = getFresh(key);
    if (cached !== null) return Promise.resolve(cached);
    return refresh(key, loader);
  };

  return {
    load,
    refresh,
    peek: getFresh,
    clear() {
      ready.clear();
      inFlight.clear();
    },
  };
};

export const revalidateExpiringCache = (
  cache,
  key,
  loader,
  { staleWhileRevalidate = false, onRefresh = null } = {},
) => {
  const refreshPromise = cache.refresh(key, loader);
  if (!staleWhileRevalidate) return refreshPromise;

  const cached = cache.peek(key);
  if (cached === null) return refreshPromise;

  void refreshPromise.then((value) => onRefresh?.(value)).catch(() => {});
  return Promise.resolve(cached);
};

export const createLatestRequestGuard = () => {
  let version = 0;
  return {
    next() {
      version += 1;
      return version;
    },
    isCurrent(candidate) {
      return candidate === version;
    },
    cancel() {
      version += 1;
    },
  };
};

export const shouldCancelPlaylistNavigation = (isViewingPlaylist, loadStatus) => (
  isViewingPlaylist || loadStatus !== 'idle'
);
