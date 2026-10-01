export const IMAGE_READY_TTL_MS = 10 * 60 * 1000;
export const IMAGE_REGISTRY_MAX_ENTRIES = 160;
export const IMAGE_LOAD_STALE_MS = 8000;
export const PRIVATE_COVER_CACHE_TTL_MS = 30 * 60 * 1000;
export const PRIVATE_COVER_MAX_BYTES = 32 * 1024 * 1024;
export const PRIVATE_COVER_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const PRIVATE_COVER_CACHE_MAX_ENTRIES = 64;

const createBrowserImage = () => new Image();

export const createImageLoadRegistry = ({
  ttlMs = IMAGE_READY_TTL_MS,
  maxEntries = IMAGE_REGISTRY_MAX_ENTRIES,
  staleMs = IMAGE_LOAD_STALE_MS,
  now = () => Date.now(),
  createImage = createBrowserImage,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  fetchImpl = (...args) => globalThis.fetch(...args),
  createObjectURL = (blob) => globalThis.URL.createObjectURL(blob),
  revokeObjectURL = (url) => globalThis.URL.revokeObjectURL(url),
  origin = () => globalThis.location?.origin || '',
  routeKey = () => globalThis.location?.pathname || '/',
  verifySession = getSession,
  onSessionRejected = () => globalThis.window?.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT)),
} = {}) => {
  const entries = new Map();
  const inflight = new Map();
  const privateCovers = new Map();
  const oversizedCovers = new Map();
  const privateInflight = new Map();
  const capacityWaiters = new Set();
  const visibilityListeners = new Set();
  let generation = 0;
  let sessionScope = null;
  let authorizedRoute = null;
  let sessionVerification = null;
  let routeEpoch = 0;
  let visibilityRevision = 0;
  let privateBytes = 0;
  let routeCheckError = null;

  const notifyVisibilityChange = () => {
    visibilityRevision += 1;
    for (const listener of visibilityListeners) listener();
  };

  const scopeForSession = (session) => session?.authenticated === true && session.mustChangePassword !== true
    && session.user?.accountId && session.csrfToken
    ? `${session.user.accountId}\u0000${session.csrfToken}` : null;

  const isPrivateMediaUrl = (url) => {
    if (typeof url !== 'string' || !url) return false;
    if (url.startsWith('/media/') || url.startsWith('/api/account/images/')) return true;
    const currentOrigin = origin();
    if (!currentOrigin) return false;
    try {
      const parsed = new URL(url);
      return parsed.origin === currentOrigin && (parsed.pathname.startsWith('/media/') || parsed.pathname.startsWith('/api/account/images/'));
    } catch {
      return false;
    }
  };

  const shouldLoadPrivately = (url) => Boolean(sessionScope && isPrivateMediaUrl(url));

  const evictPrivate = (url) => {
    const entry = privateCovers.get(url);
    if (!entry) return;
    privateCovers.delete(url);
    privateBytes -= entry.size;
    revokeObjectURL(entry.objectUrl);
  };

  const prunePrivate = () => {
    for (const [url, entry] of privateCovers) {
      if (entry.expiresAt <= now()) evictPrivate(url);
    }
    while (privateCovers.size > PRIVATE_COVER_CACHE_MAX_ENTRIES || privateBytes > PRIVATE_COVER_CACHE_MAX_BYTES) {
      evictPrivate(privateCovers.keys().next().value);
    }
  };

  const getPrivate = (url, touchEntry = true) => {
    prunePrivate();
    const entry = privateCovers.get(url);
    if (!entry) return null;
    if (touchEntry) {
      privateCovers.delete(url);
      privateCovers.set(url, entry);
    }
    return entry;
  };

  const rememberOversized = (url) => {
    oversizedCovers.delete(url);
    oversizedCovers.set(url, now() + PRIVATE_COVER_CACHE_TTL_MS);
    while (oversizedCovers.size > PRIVATE_COVER_CACHE_MAX_ENTRIES) {
      oversizedCovers.delete(oversizedCovers.keys().next().value);
    }
  };

  const isKnownOversized = (url) => {
    const expiresAt = oversizedCovers.get(url);
    if (!expiresAt) return false;
    oversizedCovers.delete(url);
    if (expiresAt <= now()) return false;
    oversizedCovers.set(url, expiresAt);
    return true;
  };

  const stopResponseBody = (response, controller) => {
    controller.abort();
    try {
      void Promise.resolve(response.body?.cancel?.()).catch(() => {});
    } catch {
      // Aborting an already closed stream is harmless.
    }
  };

  const readBoundedBlob = async (response, controller) => {
    const reader = response.body?.getReader?.();
    if (!reader) {
      // Browser responses have a stream. Retain compatibility with test adapters.
      const blob = await response.blob();
      return blob.size > PRIVATE_COVER_MAX_BYTES ? null : blob;
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PRIVATE_COVER_MAX_BYTES) {
        controller.abort();
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers.get('Content-Type') || '' });
  };

  const ensureCurrentRoute = async () => {
    if (routeCheckError) throw routeCheckError;
    const requestedRoute = routeKey();
    const requestedEpoch = routeEpoch;
    if (authorizedRoute === requestedRoute) return;
    if (!sessionVerification || sessionVerification.route !== requestedRoute
      || sessionVerification.epoch !== requestedEpoch) {
      const expectedScope = sessionScope;
      const promise = (async () => {
        let session;
        try {
          session = await verifySession();
        } catch (error) {
          if (expectedScope === sessionScope && requestedEpoch === routeEpoch && requestedRoute === routeKey()) {
            routeCheckError = error;
            clearAll();
          }
          throw error;
        }
        if (expectedScope !== sessionScope) throw new Error('Private cover session changed');
        if (routeKey() !== requestedRoute || routeEpoch !== requestedEpoch) {
          throw new Error('Private cover route changed');
        }
        if (scopeForSession(session) !== expectedScope) {
          sessionScope = null;
          authorizedRoute = null;
          clearAll();
          onSessionRejected();
          throw new Error('Private cover session invalidated');
        }
        authorizedRoute = requestedRoute;
        routeCheckError = null;
      })();
      sessionVerification = { route: requestedRoute, epoch: requestedEpoch, promise };
      promise.finally(() => {
        if (sessionVerification?.promise === promise) sessionVerification = null;
      }).catch(() => {});
    }
    await sessionVerification.promise;
  };

  const loadPrivate = (url) => {
    if (routeCheckError) return Promise.reject(routeCheckError);
    const cached = getPrivate(url);
    if (cached) return ensureCurrentRoute().then(() => {
      const current = getPrivate(url);
      if (!current || !sessionScope) throw new Error('Private cover cache was invalidated');
      return { url: current.objectUrl, fromCache: true };
    });
    if (isKnownOversized(url)) return ensureCurrentRoute().then(() => ({ url, fromCache: true }));
    if (privateInflight.has(url)) return privateInflight.get(url).promise.then(async (result) => {
      await ensureCurrentRoute();
      return result;
    });
    const requestGeneration = generation;
    const requestScope = sessionScope;
    const requestRoute = routeKey();
    const requestEpoch = routeEpoch;
    const controller = new AbortController();
    const promise = (async () => {
      if (authorizedRoute !== routeKey()) await ensureCurrentRoute();
      const response = await fetchImpl(url, {
        credentials: 'include', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Private cover request failed: ${response.status}`);
      }
      if (requestGeneration !== generation || requestScope !== sessionScope) {
        throw new Error('Private cover session changed');
      }
      const contentLength = Number(response.headers.get('Content-Length'));
      // Stop the probe before downloading oversized bytes, then let the image
      // element display the original private URL after route authorization.
      if (contentLength > PRIVATE_COVER_MAX_BYTES) {
        stopResponseBody(response, controller);
        rememberOversized(url);
        if (routeKey() === requestRoute && routeEpoch === requestEpoch) authorizedRoute = requestRoute;
        await ensureCurrentRoute();
        return { url, fromCache: false };
      }
      const blob = await readBoundedBlob(response, controller);
      if (!blob) {
        rememberOversized(url);
        if (routeKey() === requestRoute && routeEpoch === requestEpoch) authorizedRoute = requestRoute;
        await ensureCurrentRoute();
        return { url, fromCache: false };
      }
      if (blob.size === 0) throw new Error('Private cover is empty');
      if (requestGeneration !== generation || requestScope !== sessionScope) {
        throw new Error('Private cover session changed');
      }
      const objectUrl = createObjectURL(blob);
      privateCovers.set(url, { objectUrl, size: blob.size, expiresAt: now() + PRIVATE_COVER_CACHE_TTL_MS });
      privateBytes += blob.size;
      prunePrivate();
      if (routeKey() === requestRoute && routeEpoch === requestEpoch) authorizedRoute = requestRoute;
      await ensureCurrentRoute();
      return { url: objectUrl, fromCache: false };
    })().finally(() => {
      if (privateInflight.get(url)?.promise === promise) privateInflight.delete(url);
    });
    privateInflight.set(url, { promise, controller });
    return promise;
  };

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
    if (shouldLoadPrivately(url)) return authorizedRoute === routeKey()
      ? getPrivate(url)?.objectUrl || (isKnownOversized(url) ? url : null) : null;
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
    if (shouldLoadPrivately(url)) return loadPrivate(url);
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
    // Only keep a Blob already held by a mounted consumer. New consumers must
    // still use getReadySource/load and pass the current route's session check.
    canRetainSource(url, source) {
      return !routeCheckError && shouldLoadPrivately(url) && source?.startsWith('blob:')
        && getPrivate(url, false)?.objectUrl === source;
    },
    shouldLoadPrivately,
    isPrivateMediaUrl,
    getRouteRevision: () => routeEpoch,
    getVisibilityRevision: () => visibilityRevision,
    subscribeVisibility(listener) {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    invalidateRoute() {
      routeEpoch += 1;
      authorizedRoute = null;
      routeCheckError = null;
      notifyVisibilityChange();
    },
    setSessionScope(session) {
      const next = scopeForSession(session);
      if (next === sessionScope) return;
      sessionScope = next;
      routeCheckError = null;
      authorizedRoute = next ? routeKey() : null;
      this.clear();
    },
    markReady(url) {
      if (!url) return;
      if (url.startsWith('blob:') || shouldLoadPrivately(url)) return;
      touch(url, { status: 'ready', url, expiresAt: now() + ttlMs });
      prune();
    },
    markError(url) {
      if (!url) return;
      if (shouldLoadPrivately(url)) {
        evictPrivate(url);
        oversizedCovers.delete(url);
        return;
      }
      if (url.startsWith('blob:')) return;
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
    clear: clearAll,
  };

  function clearAll() {
      generation += 1;
      for (const request of privateInflight.values()) request.controller.abort();
      privateInflight.clear();
      for (const url of privateCovers.keys()) evictPrivate(url);
      oversizedCovers.clear();
      entries.clear();
      inflight.clear();
      notifyCapacityWaiters();
      notifyVisibilityChange();
  }
};

export const imageLoadRegistry = createImageLoadRegistry();
if (typeof window !== 'undefined') {
  const invalidateRoute = () => imageLoadRegistry.invalidateRoute();
  window.addEventListener('flaretune:navigate', invalidateRoute);
  window.addEventListener('popstate', invalidateRoute);
  window.addEventListener('pageshow', invalidateRoute);
  import.meta.hot?.dispose(() => {
    window.removeEventListener('flaretune:navigate', invalidateRoute);
    window.removeEventListener('popstate', invalidateRoute);
    window.removeEventListener('pageshow', invalidateRoute);
  });
}
import { getSession } from '../instance/api.js';
import { AUTH_SESSION_INVALIDATED_EVENT } from '../authNavigation.js';
