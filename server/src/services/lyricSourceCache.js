import { createRequestSingleFlight } from '../utils/sharedRequestTask.js';

export function createSingleFlightDocumentFetcherCore(fetcher, { optionsKey, createAbortError }) {
  const flight = createRequestSingleFlight();
  return (provider, song, { signal, providerLyricId, cacheScope, cacheEpoch, executionContext } = {}) => {
    if (signal?.aborted) return Promise.reject(createAbortError(provider, 'singleflight'));
    const key = [
      provider, song?.id, song?.title, song?.artist, song?.album, song?.duration,
      optionsKey({ providerLyricId, cacheScope, cacheEpoch }),
    ].join('\u0000');
    return flight(key, ({ signal: sharedSignal }) => fetcher(provider, song, {
      signal: sharedSignal, providerLyricId, cacheScope, cacheEpoch,
    }), { signal, executionContext, abortError: () => createAbortError(provider, 'singleflight') });
  };
}

export function createCachedSourceDocumentFetcherCore(fetcher, {
  optionsKey,
  createAbortError,
  isUnavailableError,
  now = () => Date.now(),
  maxEntries = 100,
  wordTtlMs = 15 * 60_000,
  lineTtlMs = 5 * 60_000,
  negativeTtlMs = 30_000,
} = {}) {
  const cache = new Map();
  const songEpochs = new Map();
  let globalEpoch = 0;
  const songKey = (song) => (song?.id === undefined || song?.id === null ? '' : String(song.id));
  const currentEpoch = (song) => `${globalEpoch}:${songEpochs.get(songKey(song)) || 0}`;
  const cacheKey = (provider, song, options) => ([
    provider, song?.id, song?.title, song?.artist, song?.album, song?.duration,
    optionsKey(options),
  ].join('\u0000'));
  const cachedFetcher = async (provider, song, options = {}) => {
    if (options.signal?.aborted) throw createAbortError(provider, 'cache');
    const key = cacheKey(provider, song, options);
    const requestEpoch = currentEpoch(song);
    const cached = cache.get(key);
    const timestamp = now();
    if (cached && cached.expiresAt > timestamp) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.value;
    }
    if (cached) cache.delete(key);

    let value;
    try {
      value = await fetcher(provider, song, { ...options, cacheEpoch: requestEpoch });
    } catch (error) {
      if (!isUnavailableError(error)) throw error;
      value = null;
    }
    if (currentEpoch(song) !== requestEpoch) return value || null;
    const completedAt = now();
    const ttl = value?.syncMode === 'word'
      ? wordTtlMs
      : (value?.lrc || value?.lines?.length ? lineTtlMs : negativeTtlMs);
    cache.set(key, {
      value: value || null,
      expiresAt: completedAt + ttl,
      songId: song?.id === undefined || song?.id === null ? null : String(song.id),
    });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return value || null;
  };
  cachedFetcher.invalidateSong = (songId) => {
    const target = String(songId || '');
    if (!target) return 0;
    songEpochs.set(target, (songEpochs.get(target) || 0) + 1);
    let removed = 0;
    for (const [key, entry] of cache) {
      if (entry.songId !== target) continue;
      cache.delete(key);
      removed += 1;
    }
    return removed;
  };
  cachedFetcher.clear = () => {
    globalEpoch += 1;
    cache.clear();
  };
  return cachedFetcher;
}
