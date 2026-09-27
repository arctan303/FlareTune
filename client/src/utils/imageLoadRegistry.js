export const IMAGE_READY_TTL_MS = 10 * 60 * 1000;
export const IMAGE_REGISTRY_MAX_ENTRIES = 160;
export const IMAGE_LOAD_STALE_MS = 8000;

const createBrowserImage = () => new Image();

export const createImageLoadRegistry = ({
  ttlMs = IMAGE_READY_TTL_MS,
  maxEntries = IMAGE_REGISTRY_MAX_ENTRIES,
  staleMs = IMAGE_LOAD_STALE_MS,
  now = () => Date.now(),
  createImage = createBrowserImage,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  const entries = new Map();
  const inflight = new Map();
  const capacityWaiters = new Set();
  let generation = 0;

  const notifyCapacityWaiters = () => {
    if (capacityWaiters.size === 0) return;
    const waiters = [...capacityWaiters];
    capacityWaiters.clear();
    waiters.forEach((resolve) => resolve());
  };

  const waitForCapacity = () => new Promise((resolve) => {
    capacityWaiters.add(resolve);
  });

  const touch = (url, entry) => {
    entries.delete(url);
    entries.set(url, entry);
  };

  const isFresh = (entry) => entry?.status === 'loading' || entry?.expiresAt > now();

  const prune = () => {
    for (const [url, entry] of entries) {
      if (entry.status !== 'loading' && !isFresh(entry)) entries.delete(url);
    }

    if (entries.size <= maxEntries) return;
    for (const [url, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (entry.status !== 'loading') entries.delete(url);
    }
  };

  const makeRoom = () => {
    prune();
    if (entries.size < maxEntries) return true;

    for (const [url, entry] of entries) {
      if (entry.status !== 'loading') {
        entries.delete(url);
        return true;
      }
    }
    return false;
  };

  const getEntry = (url) => {
    if (!url) return null;
    const entry = entries.get(url);
    if (!entry) return null;
    if (!isFresh(entry)) {
      entries.delete(url);
      return null;
    }
    touch(url, entry);
    return entry;
  };

  const getReadySource = (url, fallback = '') => {
    const primary = getEntry(url);
    if (primary?.status === 'ready') return primary.url;
    if (primary?.status === 'error' && fallback) {
      const fallbackEntry = getEntry(fallback);
      if (fallbackEntry?.status === 'ready') return fallbackEntry.url;
    }
    return null;
  };

  const load = (url) => {
    if (!url) return Promise.reject(new Error('Image URL is required'));
    const cached = getEntry(url);
    if (cached?.status === 'ready') {
      return Promise.resolve({ url: cached.url, fromCache: true });
    }
    if (cached?.status === 'error') {
      return Promise.reject(cached.error);
    }
    if (cached?.status === 'loading') {
      return cached.promise.then((result) => ({ ...result, fromCache: false }));
    }
    const active = inflight.get(url);
    if (active) {
      return active.promise.then((result) => ({ ...result, fromCache: false }));
    }
    if (!makeRoom()) return waitForCapacity().then(() => load(url));

    const entry = {
      status: 'loading',
      url,
      expiresAt: Infinity,
      promise: null,
      generation,
    };
    entry.promise = new Promise((resolve, reject) => {
      const image = createImage();
      let settled = false;
      let timerId = null;

      const finish = (status, error = null) => {
        if (settled) return;
        settled = true;
        if (timerId !== null) clearTimer(timerId);
        const finalEntry = {
          status,
          url,
          error,
          expiresAt: now() + (status === 'error' ? 3000 : ttlMs),
          promise: null,
        };
        if (inflight.get(url) === entry) inflight.delete(url);
        if (entry.generation === generation && (!entries.has(url) || entries.get(url) === entry)) {
          touch(url, finalEntry);
        }
        prune();
        if (status === 'ready') resolve({ url, fromCache: false });
        else reject(error);
        notifyCapacityWaiters();
      };

      image.onload = async () => {
        if (image.naturalWidth === 0 || image.naturalHeight === 0) {
          finish('error', new Error(`Image loaded with zero dimensions: ${url}`));
          return;
        }
        try {
          if (typeof image.decode === 'function') await image.decode();
        } catch {
          // onload is sufficient when decode rejects for an already decoded browser-cache entry.
        }
        if (image.naturalWidth === 0 || image.naturalHeight === 0) {
          finish('error', new Error(`Image decoded with zero dimensions: ${url}`));
          return;
        }
        finish('ready');
      };
      image.onerror = () => finish('error', new Error(`Image failed to load: ${url}`));
      timerId = setTimer(
        () => {
          // A slow browser-cache revalidation is not an image failure. Release the
          // registry slot so other covers can proceed, but keep waiting for the
          // browser's authoritative load/error event for this caller.
          if (entries.get(url) === entry) {
            entries.delete(url);
            notifyCapacityWaiters();
          }
        },
        staleMs,
      );
      image.src = url;
    });

    inflight.set(url, entry);
    touch(url, entry);
    prune();
    return entry.promise;
  };

  const loadWithFallback = async (url, fallback = '') => {
    const primaryEntry = getEntry(url);
    const primaryWasSettled = primaryEntry?.status === 'ready' || primaryEntry?.status === 'error';
    try {
      return await load(url);
    } catch (error) {
      if (!fallback || fallback === url) throw error;
      try {
        const result = await load(fallback);
        return {
          ...result,
          fromCache: primaryWasSettled && result.fromCache,
          usedFallback: true,
        };
      } catch (fallbackError) {
        throw fallbackError;
      }
    }
  };

  const loadGroup = (urls, fallback = '') => Promise.all(
    urls.map((url) => loadWithFallback(url, fallback)),
  );

  return {
    load,
    loadWithFallback,
    loadGroup,
    getReadySource,
    markReady(url) {
      if (!url) return;
      touch(url, { status: 'ready', url, expiresAt: now() + ttlMs });
      prune();
    },
    markError(url) {
      if (!url) return;
      touch(url, { status: 'error', url, error: new Error(`Image failed to display: ${url}`), expiresAt: now() + 3000 });
      prune();
    },
    get size() {
      prune();
      return entries.size;
    },
    snapshot() {
      prune();
      return [...entries.entries()].map(([url, entry]) => ({ url, status: entry.status }));
    },
    clear() {
      generation += 1;
      entries.clear();
      inflight.clear();
      notifyCapacityWaiters();
    },
  };
};

export const imageLoadRegistry = createImageLoadRegistry();
