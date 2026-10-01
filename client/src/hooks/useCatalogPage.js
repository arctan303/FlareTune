import React from 'react';
import { readCatalog } from '../services/catalogRead.js';
import { getApiBaseUrl } from '../services/apiBase.js';
import { AUTH_SESSION_INVALIDATED_EVENT, AUTH_SESSION_UPDATED_EVENT } from '../authNavigation.js';

const CACHE_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_TTL_MS = 15 * 60_000;
const CACHE_LIMIT = 40;
const pageCache = new Map();
const emptyPage = (status) => ({ items: [], status, hasMore: false, total: status === 'idle' ? 0 : null });

function cachedPage(key) {
  const entry = pageCache.get(key);
  if (!entry) return null;
  const ttl = JSON.parse(key)[2] ? SEARCH_CACHE_TTL_MS : CACHE_TTL_MS;
  return { page: entry.page, fresh: Date.now() - entry.savedAt < ttl };
}

export function invalidateCatalogSearch(query, language) {
  for (const key of pageCache.keys()) {
    const [base, , cachedQuery, cachedLanguage] = JSON.parse(key);
    if (base === getApiBaseUrl() && cachedQuery === query.trim() && cachedLanguage === language) pageCache.delete(key);
  }
}

function rememberPage(key, page) {
  pageCache.delete(key);
  pageCache.set(key, { page, savedAt: Date.now() });
  if (pageCache.size > CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value);
}

if (typeof window !== 'undefined') {
  const clearPageCache = () => pageCache.clear();
  window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, clearPageCache);
  window.addEventListener(AUTH_SESSION_UPDATED_EVENT, clearPageCache);
  window.addEventListener('flaretune:catalog-song-updated', clearPageCache);
  import.meta.hot?.dispose(() => {
    window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, clearPageCache);
    window.removeEventListener(AUTH_SESSION_UPDATED_EVENT, clearPageCache);
    window.removeEventListener('flaretune:catalog-song-updated', clearPageCache);
  });
}

export function useCatalogPage(type, { query = '', language = '', artist = '', limit = 20, enabled = true, retainWhileDisabled = false, refreshKey = 0 } = {}) {
  const key = JSON.stringify([getApiBaseUrl(), type, query.trim(), language, artist.trim(), limit]);
  const [state, setState] = React.useState(() => ({ key, ...(cachedPage(key)?.page || emptyPage('loading')) }));
  const [loadingMore, setLoadingMore] = React.useState(false);
  const generationRef = React.useRef(0);
  const canLoad = enabled && (query.trim() || artist.trim() || (language && language !== 'all'));
  const current = !canLoad && !retainWhileDisabled ? { key, ...emptyPage('idle') }
    : state.key === key && state.status !== 'idle' ? state
      : { key, ...(cachedPage(key)?.page || emptyPage('loading')) };

  React.useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    if (!canLoad) {
      if (!retainWhileDisabled) setState({ key, ...emptyPage('idle') });
      return () => controller.abort();
    }
    const cached = cachedPage(key);
    if (cached) {
      setState({ key, ...cached.page });
      // Keep expanded lists intact when returning from a detail page.
      if (cached.fresh || cached.page.items.length > limit) return () => controller.abort();
    } else setState({ key, ...emptyPage('loading') });
    readCatalog(type, { query, language, artist, offset: 0, limit, signal: controller.signal })
      .then((result) => {
        if (generation === generationRef.current) {
          const page = { ...result, status: 'ready' };
          rememberPage(key, page);
          setState({ key, ...page });
        }
      })
      .catch((error) => {
        if (error.name !== 'AbortError' && generation === generationRef.current && !cached) setState({ key, ...emptyPage('error') });
      });
    return () => controller.abort();
  }, [type, query, language, artist, limit, canLoad, key, retainWhileDisabled, refreshKey]);

  const loadMore = React.useCallback(async () => {
    if (loadingMore || current.status !== 'ready' || !current.hasMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const result = await readCatalog(type, { query, language, artist, offset: current.items.length, limit });
      if (generation === generationRef.current) {
        const page = { ...result, items: [...current.items, ...result.items], status: 'ready' };
        rememberPage(key, page);
        setState({ key, ...page });
      }
    } catch {
      // Keep the loaded page; the user can retry.
    } finally {
      if (generation === generationRef.current) setLoadingMore(false);
    }
  }, [artist, language, limit, loadingMore, query, current.hasMore, current.items.length, current.status, type, key]);

  return { ...current, loadingMore, loadMore };
}
