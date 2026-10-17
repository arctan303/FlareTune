import { fetchLimitedJson } from './lyricSourceHttp.js';
import { LyricSourceError } from './lyricSourceError.js';
import { keepTaskAlive } from '../utils/sharedRequestTask.js';

export const LRCLIB_REQUEST_LIMITS = Object.freeze({
  intervalMs: 400,
  maxFlights: 16,
  maxSubscribers: 64,
  candidateTtlMs: 15_000,
  maxCandidateEntries: 32,
  maxCandidateBytes: 512 * 1024,
});

const aborted = (stage) => new LyricSourceError('aborted', 'lrclib', stage, 'LRCLIB request aborted');
const busy = () => new LyricSourceError('rate_limited', 'lrclib', 'budget', 'LRCLIB pending request allowance exceeded');

// One coordinator belongs to one configured loader. It stores no cross-instance
// credentials or lyric documents, and cancellation only affects its subscriber.
export function createLrclibRequestCoordinator({ fetchImpl, timeoutMs = 5_000, now = Date.now } = {}) {
  const flights = new Map();
  const candidates = new Map();
  let candidateBytes = 0;
  let subscribers = 0;
  let nextStartAt = 0;
  let cooldownUntil = 0;
  const queue = new Set();
  const cooldownErrors = new WeakSet();

  const limited = (stage) => {
    const error = new LyricSourceError('rate_limited', 'lrclib', stage, 'LRCLIB is temporarily rate limited', {
      retryAfterSeconds: Math.max(1, Math.ceil((cooldownUntil - now()) / 1000)),
    });
    cooldownErrors.add(error);
    return error;
  };
  const rejectQueued = () => {
    for (const node of [...queue]) node.reject(limited(node.stage));
  };
  const schedule = async (signal, stage) => {
    while (true) {
      if (signal.aborted) throw signal.reason;
      if (cooldownUntil > now()) throw limited(stage);
      const delay = nextStartAt - now();
      if (delay <= 0) {
        nextStartAt = now() + LRCLIB_REQUEST_LIMITS.intervalMs;
        return;
      }
      // A Worker timer belongs to the HTTP context that created it. Each flight
      // owns its wait; a central queue timer could die when another request ends.
      await new Promise((resolve, reject) => {
        let timer;
        const finish = (error) => {
          clearTimeout(timer);
          queue.delete(node);
          signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const node = { stage, reject: finish };
        const abort = () => finish(signal.reason);
        queue.add(node);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(), delay);
        if (signal.aborted) abort();
      });
    }
  };

  function request(url, { stage, signal, requestBudget, executionContext } = {}) {
    if (signal?.aborted) return Promise.reject(aborted(stage));
    if (cooldownUntil > now()) return Promise.reject(limited(stage));
    if (subscribers >= LRCLIB_REQUEST_LIMITS.maxSubscribers) return Promise.reject(busy());
    const key = `${stage}\u0000${url}`;
    let flight = flights.get(key);
    if (!flight) {
      if (flights.size >= LRCLIB_REQUEST_LIMITS.maxFlights) return Promise.reject(busy());
      const controller = new AbortController();
      flight = { controller, subscribers: new Set(), done: false };
      flights.set(key, flight);
      const work = fetchLimitedJson(async (target, init) => {
        await schedule(init.signal, stage);
        if (init.signal.aborted) throw init.signal.reason;
        if (cooldownUntil > now()) throw limited(stage);
        requestBudget?.consume('lrclib');
        return fetchImpl(target, init);
      }, url, { provider: 'lrclib', stage, signal: controller.signal, timeoutMs });
      flight.promise = work.catch((error) => {
        if (error.kind === 'rate_limited' && error.stage !== 'budget' && error.retryAfterSeconds
          && !cooldownErrors.has(error)) {
          cooldownUntil = Math.max(cooldownUntil, now() + error.retryAfterSeconds * 1000);
          rejectQueued();
        }
        throw error;
      }).finally(() => {
        flight.done = true;
        if (flights.get(key) === flight) flights.delete(key);
      });
    }
    // Register the actual I/O-owning task while its owner request is alive.
    // Caller wrappers can reject earlier; no ExecutionContext is kept in state.
    keepTaskAlive(flight.promise, executionContext);
    const current = flight;
    return new Promise((resolve, reject) => {
      const subscriber = {};
      subscribers += 1;
      current.subscribers.add(subscriber);
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        subscribers -= 1;
        current.subscribers.delete(subscriber);
        if (!current.done && !current.subscribers.size) {
          // Delete before aborting: an immediate replacement must get a fresh flight.
          if (flights.get(key) === current) flights.delete(key);
          current.controller.abort(aborted(stage));
        }
        return true;
      };
      const cancel = () => { if (release()) reject(aborted(stage)); };
      signal?.addEventListener('abort', cancel, { once: true });
      current.promise.then(
        value => { if (release()) resolve(value); },
        error => { if (release()) reject(error); },
      );
      if (signal?.aborted) cancel();
    });
  }

  const deleteCandidates = (key) => {
    const entry = candidates.get(key);
    if (!entry) return;
    candidateBytes -= entry.bytes;
    candidates.delete(key);
  };
  const pruneCandidates = () => {
    for (const [key, entry] of candidates) if (entry.expiresAt <= now()) deleteCandidates(key);
  };
  return {
    request,
    getCandidates(key) {
      pruneCandidates();
      const entry = candidates.get(key);
      if (!entry) return undefined;
      candidates.delete(key);
      candidates.set(key, entry);
      return structuredClone(entry.value);
    },
    setCandidates(key, value) {
      pruneCandidates();
      deleteCandidates(key);
      // Only the adapter's already-safe candidate summaries reach this cache.
      const bytes = new TextEncoder().encode(key + JSON.stringify(value)).byteLength;
      if (bytes > LRCLIB_REQUEST_LIMITS.maxCandidateBytes) return;
      while (candidates.size >= LRCLIB_REQUEST_LIMITS.maxCandidateEntries
        || candidateBytes + bytes > LRCLIB_REQUEST_LIMITS.maxCandidateBytes) {
        deleteCandidates(candidates.keys().next().value);
      }
      candidates.set(key, { value: structuredClone(value), bytes,
        expiresAt: now() + LRCLIB_REQUEST_LIMITS.candidateTtlMs });
      candidateBytes += bytes;
    },
  };
}
