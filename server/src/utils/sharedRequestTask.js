// Keep the actual I/O-owning task alive, not only an abortable caller wrapper.
export function keepTaskAlive(task, executionContext) {
  executionContext?.waitUntil?.(task.then(() => undefined, () => undefined));
  return task;
}

export function createRequestSingleFlight({ createAbortError = () => new DOMException('Aborted', 'AbortError') } = {}) {
  const entries = new Map();
  return (key, task, { signal, executionContext, abortError = createAbortError } = {}) => {
    if (signal?.aborted) return Promise.reject(abortError());
    let entry = entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, waiters: new Set(), settled: false };
      entry.task = Promise.resolve().then(() => task({ signal: controller.signal }));
      entries.set(key, entry);
      const clear = () => {
        entry.settled = true;
        entry.waiters.clear();
        if (entries.get(key) === entry) entries.delete(key);
      };
      entry.task.then(clear, clear);
    }
    keepTaskAlive(entry.task, executionContext);
    const waiter = Symbol(key);
    entry.waiters.add(waiter);
    // Preserve the store's shared identity for callers without cancellation.
    if (!signal) return entry.task;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        entry.waiters.delete(waiter);
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        reject(abortError());
        if (!entry.settled && entry.waiters.size === 0) {
          if (entries.get(key) === entry) entries.delete(key);
          entry.controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.task.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
    });
  };
}
