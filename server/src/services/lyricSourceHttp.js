import { LyricSourceError } from './lyricSourceError.js';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_JSON_BYTES = 4_000_000;
const LRCLIB_USER_AGENT = 'FlareTune/1.2.0';
const responseStatusKind = (response) => {
  if (response?.status === 404) return 'unavailable';
  if (response?.status === 408 || response?.status === 504) return 'timeout';
  if (response?.status === 429) return 'rate_limited';
  if (response?.status >= 500) return 'upstream';
  return 'invalid';
};

const byteLength = (value) => new TextEncoder().encode(value).byteLength;

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function readResponseTextLimited(response, maximumBytes, signal) {
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new RangeError('upstream response exceeds safe size');
  }
  if (!response?.body?.getReader) {
    const text = await response.text();
    if (byteLength(text) > maximumBytes) throw new RangeError('upstream response exceeds safe size');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let totalBytes = 0;
  const aborted = new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) throw new RangeError('upstream response exceeds safe size');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    try { await reader.cancel(error); } catch { /* best effort */ }
    throw error;
  }
}

export async function fetchLimitedJson(fetchImpl, url, {
  provider,
  stage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal: requestSignal,
  requestBudget,
} = {}) {
  const controller = new AbortController();
  let didTimeout = false;
  const abortFromRequest = () => controller.abort(requestSignal.reason || new DOMException('Aborted', 'AbortError'));
  if (requestSignal?.aborted) abortFromRequest();
  else requestSignal?.addEventListener('abort', abortFromRequest, { once: true });
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('upstream timeout'));
  }, timeoutMs);
  try {
    if (requestSignal?.aborted) {
      throw new LyricSourceError('aborted', provider, stage, `${provider} ${stage} aborted`);
    }
    const init = {
      // Workers supports follow/manual. Never follow a redirect to an
      // unconfigured destination.
      redirect: 'manual',
      signal: controller.signal,
      headers: provider === 'lrclib'
        ? { Accept: 'application/json', 'User-Agent': LRCLIB_USER_AGENT, 'Lrclib-Client': 'FlareTune' }
        : { Accept: 'application/json' },
    };
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (controller.signal.aborted) throw controller.signal.reason;
      requestBudget?.consume(provider);
      response = await fetchImpl(url, init);
      // LRCLIB intermittently answers a fresh search with 503/Retry-After.
      // Retry once within the original timeout and shared subrequest budget.
      const retryAfter = response?.headers?.get?.('retry-after');
      const delayMs = retryAfter == null ? 250 : Number(retryAfter) * 1000;
      if (attempt || provider !== 'lrclib' || stage !== 'search' || response?.status !== 503
        || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) break;
      try { await response.body?.cancel(); } catch { /* best effort */ }
      await waitForRetry(delayMs, controller.signal);
    }
    if (!response?.ok) {
      throw new LyricSourceError(responseStatusKind(response), provider, stage, `${provider} ${stage} HTTP ${response?.status || 0}`);
    }
    if (typeof response.text === 'function') {
      const text = await readResponseTextLimited(response, MAX_JSON_BYTES, controller.signal);
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new LyricSourceError('invalid', provider, stage, `${provider} ${stage} returned invalid JSON`, { cause: error });
      }
    }
    const value = await response.json();
    if (byteLength(JSON.stringify(value)) > MAX_JSON_BYTES) throw new RangeError('upstream JSON exceeds safe size');
    return value;
  } catch (error) {
    if (error instanceof LyricSourceError) throw error;
    if (error instanceof SyntaxError || error instanceof RangeError) {
      throw new LyricSourceError('invalid', provider, stage, `${provider} ${stage} returned invalid JSON`, { cause: error });
    }
    const kind = requestSignal?.aborted
      ? 'aborted'
      : (didTimeout || error?.name === 'AbortError' ? 'timeout' : 'network');
    throw new LyricSourceError(kind, provider, stage, `${provider} ${stage} ${kind}`, { cause: error });
  } finally {
    clearTimeout(timeoutId);
    requestSignal?.removeEventListener('abort', abortFromRequest);
  }
}
