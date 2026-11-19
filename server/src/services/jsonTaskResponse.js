// Keep one request alive while its existing JSON operation finishes. Whitespace
// is valid before JSON and prevents idle read timeouts without any database I/O.
export function jsonTaskResponse(execute, { headers = {}, signal, heartbeatMs = 10_000, onCancel } = {}) {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const taskSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let timer, closed = false;
  const clean = () => { clearInterval(timer); signal?.removeEventListener('abort', stop); };
  const stop = () => { abort.abort(); clean(); };
  signal?.addEventListener('abort', stop, { once: true });
  const stream = new ReadableStream({
    start(target) {
      const finish = text => {
        if (closed) return;
        closed = true; clean();
        if (taskSignal.aborted) { target.error(new DOMException('Request ended', 'AbortError')); return; }
        target.enqueue(encoder.encode(text)); target.close();
      };
      target.enqueue(encoder.encode(' \n'));
      timer = setInterval(() => { if (!closed && !taskSignal.aborted) target.enqueue(encoder.encode('\n')); }, heartbeatMs);
      void Promise.resolve().then(() => { taskSignal.throwIfAborted(); return execute(taskSignal); }).then(async result => {
        const text = result instanceof Response ? await result.text() : JSON.stringify(result);
        finish(text || JSON.stringify({ ok: false, code: 503, error: 'LYRIC_PROCESSING_FAILED' }));
      }).catch(error => finish(JSON.stringify({ ok: false,
        code: Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503,
        error: /^[A-Z][A-Z0-9_]{1,99}$/u.test(error?.code || '') ? error.code : 'LYRIC_PROCESSING_FAILED',
        message: 'Lyric processing could not finish' })));
    },
    cancel() { closed = true; stop(); onCancel?.(); },
  });
  return new Response(stream, { headers: { ...Object.fromEntries(new Headers(headers)),
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' } });
}

// Preserve ordinary status codes unless the selected source actually starts AI.
export async function deferredJsonTaskResponse(execute, options = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const task = Promise.resolve().then(() => execute({ signal, onStart: notify }));
  const first = await Promise.race([task.then(response => ({ response })), started.then(() => ({ streaming: true }))]);
  return first.streaming ? jsonTaskResponse(() => task, { ...options, signal, onCancel: () => controller.abort() }) : first.response;
}
