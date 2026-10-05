// Map-compatible bounded metadata caches; ready=true records a recent decode,
// not ownership of a decoded bitmap (the browser may evict its own image cache).
export class ExpiringLruMap extends Map {
  constructor({ maxEntries, ttlMs, now = Date.now }) {
    super();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.expiry = new Map();
  }

  prune() {
    const now = this.now();
    for (const [key, expiresAt] of this.expiry) if (expiresAt <= now) this.delete(key);
  }

  has(key) {
    if ((this.expiry.get(key) ?? Infinity) <= this.now()) this.delete(key);
    return super.has(key);
  }

  get(key) {
    if (!this.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    this.prune();
    super.delete(key);
    super.set(key, value);
    this.expiry.set(key, this.now() + this.ttlMs);
    while (super.size > this.maxEntries) this.delete(super.keys().next().value);
    return this;
  }

  delete(key) { this.expiry.delete(key); return super.delete(key); }
  clear() { this.expiry.clear(); super.clear(); }
  get size() { this.prune(); return super.size; }
}

export function createArtistImagePreloader(readyCache) {
  const pending = new Map();
  const queue = [];
  let active = 0;
  let watchedDocument = null;
  const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

  const finishQueued = task => {
    pending.delete(task.url);
    if (readyCache.get(task.url) === task.promise) readyCache.delete(task.url);
    task.resolve(false);
  };

  const syncVisibilityListener = () => {
    const target = typeof document === 'undefined' ? null : document;
    if (queue.length && target && !watchedDocument) {
      watchedDocument = target;
      target.addEventListener('visibilitychange', drain);
    } else if (!queue.length && watchedDocument) {
      watchedDocument.removeEventListener('visibilitychange', drain);
      watchedDocument = null;
    }
  };

  const start = task => {
    active++;
    let image = null, timer = null, settled = false, decoding = false, released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      drain();
    };
    const finish = success => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (image) { image.onload = null; image.onerror = null; }
      pending.delete(task.url);
      readyCache.set(task.url, success);
      task.resolve(success);
      // decode() cannot be aborted: keep its slot until it actually settles.
      if (!decoding) release();
    };
    try {
      image = new Image();
      image.referrerPolicy = 'no-referrer';
      image.onload = async () => {
        if (settled) return;
        decoding = true;
        try {
          if (typeof image.decode === 'function') await image.decode();
          finish(true);
        } catch {
          // A completed load is still usable if decode() is unsupported/rejected.
          finish(true);
        } finally {
          decoding = false;
          release();
        }
      };
      image.onerror = () => finish(false);
      timer = setTimeout(() => finish(false), 12000);
      image.src = task.url;
    } catch {
      finish(false);
    }
  };

  function drain() {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].guards.some(guard => guard())) continue;
      finishQueued(queue.splice(index, 1)[0]);
    }
    while (active < 2 && queue.length && isVisible()) start(queue.shift());
    syncVisibilityListener();
  }

  const prioritize = () => queue.sort((left, right) => Number(left.priority === 'prefetch') - Number(right.priority === 'prefetch'));

  return function preload(url, { isCurrent = () => true, priority = 'current' } = {}) {
    if (!url || !isCurrent()) return Promise.resolve(false);
    if (readyCache.get(url) === true) return Promise.resolve(true);
    const existing = pending.get(url);
    if (existing) {
      existing.guards.push(isCurrent);
      if (priority === 'current') existing.priority = priority;
      prioritize();
      drain();
      return existing.promise;
    }
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    const task = { url, promise, resolve, guards: [isCurrent], priority };
    pending.set(url, task);
    readyCache.set(url, promise);
    queue.push(task);
    prioritize();
    // Bound queued work too, including callers outside the fullscreen player.
    while (queue.length > 32) finishQueued(queue.pop());
    drain();
    return promise;
  };
}
