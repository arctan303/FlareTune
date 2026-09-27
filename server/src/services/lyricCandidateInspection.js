import { createLyricDocument } from '../utils/lyricDocument.js';

export const LYRIC_CANDIDATE_INSPECTION_LIMITS = Object.freeze({
  maxCandidates: 12,
  downloadConcurrency: 2,
  upstreamTimeoutMs: 5_000,
  batchTimeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
});

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VALID_SOURCES = new Set(['kugou', 'netease', 'lrclib']);
const SAFE_UPSTREAM_KINDS = new Set([
  'circuit_open', 'invalid', 'network', 'rate_limited', 'timeout', 'unavailable', 'upstream',
]);

export class LyricCandidateInspectionError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LyricCandidateInspectionError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new LyricCandidateInspectionError(code, message);
};

const byteLength = (value) => new TextEncoder().encode(value).byteLength;

function normalizeCandidates(candidates) {
  if (!Array.isArray(candidates)) fail('invalid_candidates', 'candidates must be an array');
  if (candidates.length > LYRIC_CANDIDATE_INSPECTION_LIMITS.maxCandidates) {
    fail('too_many_candidates', 'at most 12 candidates may be inspected');
  }
  const seen = new Set();
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('invalid_candidate', 'each candidate must be an object');
    }
    const keys = Object.keys(candidate).sort();
    if (keys.length !== 2 || keys[0] !== 'providerLyricId' || keys[1] !== 'source') {
      fail('invalid_candidate', 'candidate accepts only source and providerLyricId');
    }
    const source = candidate.source;
    const providerLyricId = candidate.providerLyricId;
    if (!VALID_SOURCES.has(source) || typeof providerLyricId !== 'string'
      || !PROVIDER_ID_PATTERN.test(providerLyricId)) {
      fail('invalid_candidate', 'candidate source or providerLyricId is invalid');
    }
    const key = `${source}\u0000${providerLyricId}`;
    if (seen.has(key)) fail('duplicate_candidate', 'duplicate candidates are not allowed');
    seen.add(key);
    return { source, providerLyricId };
  });
}

const createAbortError = (code) => new LyricCandidateInspectionError(code, 'inspection aborted');

function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal) return () => {};
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return () => {};
  }
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abort, { once: true });
  return () => parentSignal.removeEventListener('abort', abort);
}

function runTimed(task, { signal, timeoutMs }) {
  if (signal?.aborted) return Promise.reject(createAbortError('aborted'));
  const controller = new AbortController();
  const unlink = linkAbortSignal(signal, controller);
  let didTimeout = false;
  let timer;
  let removeAbortListener = () => {};
  const interrupted = new Promise((_, reject) => {
    const abort = () => reject(createAbortError(didTimeout ? 'timeout' : 'aborted'));
    controller.signal.addEventListener('abort', abort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener('abort', abort);
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort('timeout');
    }, Math.max(1, timeoutMs));
  });
  const work = Promise.resolve().then(() => task(controller.signal));
  return Promise.race([work, interrupted]).finally(() => {
    clearTimeout(timer);
    removeAbortListener();
    unlink();
  });
}

const safeErrorCode = (error, stage, batchTimedOut) => {
  if (batchTimedOut) return 'batch_timeout';
  if (error?.code === 'timeout' || error?.kind === 'timeout') return `${stage}_timeout`;
  const kind = SAFE_UPSTREAM_KINDS.has(error?.kind) ? error.kind : 'failed';
  return `${stage}_${kind}`;
};

const errorItem = ({ source, providerLyricId }, code) => ({
  source,
  providerLyricId,
  state: 'error',
  error: { code },
});

function normalizeSnapshot(snapshot, source) {
  const ids = Array.isArray(snapshot?.providerLyricIds) ? snapshot.providerLyricIds : null;
  if (!ids || typeof snapshot?.loadDocument !== 'function') {
    throw new LyricCandidateInspectionError('invalid_snapshot', `${source} returned an invalid snapshot`);
  }
  const providerLyricIds = new Set(ids.map((value) => String(value)));
  return { providerLyricIds, loadDocument: snapshot.loadDocument };
}

const copyWord = (word) => ({
  text: word.text,
  startTime: word.startTime,
  endTime: word.endTime,
});

const copyOriginalLine = (line) => {
  const result = { text: line.text };
  if (line.time !== undefined) result.time = line.time;
  if (line.endTime !== undefined) result.endTime = line.endTime;
  if (Array.isArray(line.words) && line.words.length > 0) result.words = line.words.map(copyWord);
  return result;
};

function projectDocument(candidate, rawDocument) {
  const document = createLyricDocument(rawDocument);
  const actualId = document.providerMeta?.providerLyricId;
  if (document.source !== candidate.source || actualId !== candidate.providerLyricId) {
    throw new LyricCandidateInspectionError(
      'candidate_mismatch',
      'loaded lyrics do not match the inspected candidate',
    );
  }
  const translationLines = document.lines.map((line) => String(line.tlyric || '').trim());
  const translationAvailable = translationLines.some(Boolean);
  const warnings = [];
  if (document.syncMode === 'line') warnings.push('no_word_timing');
  if (document.syncMode === 'none') warnings.push('unsynced');
  if (document.providerMeta?.versionMismatch === true || rawDocument?.providerMeta?.versionMismatch === true) {
    warnings.push('version_mismatch');
  }
  return {
    ...candidate,
    state: 'ready',
    syncMode: document.syncMode,
    lineCount: document.lines.length,
    translationAvailable,
    warnings,
    lyrics: {
      version: document.version,
      source: document.source,
      format: document.format,
      syncMode: document.syncMode,
      lines: document.lines.map(copyOriginalLine),
    },
    translation: translationAvailable ? { lines: translationLines } : null,
  };
}

function enforceResponseLimit(items, maximumBytes) {
  const compact = items.map((item) => (
    item.state === 'ready' ? errorItem(item, 'response_too_large') : item
  ));
  let omittedReadyItems = items.filter((item) => item.state === 'ready').length;
  const result = { items: compact, truncated: omittedReadyItems > 0 };
  if (byteLength(JSON.stringify(result)) > maximumBytes) {
    throw new LyricCandidateInspectionError(
      'response_limit_too_small',
      'response byte limit cannot contain candidate status data',
    );
  }
  items.forEach((item, index) => {
    if (item.state !== 'ready') return;
    const fallback = result.items[index];
    result.items[index] = item;
    result.truncated = omittedReadyItems > 1;
    if (byteLength(JSON.stringify(result)) > maximumBytes) {
      result.items[index] = fallback;
      result.truncated = omittedReadyItems > 0;
    } else {
      omittedReadyItems -= 1;
    }
  });
  result.truncated = omittedReadyItems > 0;
  return result;
}

/**
 * Inspect provider candidates without persistence. createProviderSnapshot must
 * perform one fresh search and retain any private download credentials inside
 * its loadDocument closure; this service never accepts or returns those fields.
 */
export async function inspectLyricCandidates(song, candidates, {
  createProviderSnapshot,
  signal,
  downloadConcurrency = LYRIC_CANDIDATE_INSPECTION_LIMITS.downloadConcurrency,
  upstreamTimeoutMs = LYRIC_CANDIDATE_INSPECTION_LIMITS.upstreamTimeoutMs,
  batchTimeoutMs = LYRIC_CANDIDATE_INSPECTION_LIMITS.batchTimeoutMs,
  maxResponseBytes = LYRIC_CANDIDATE_INSPECTION_LIMITS.maxResponseBytes,
} = {}) {
  const normalized = normalizeCandidates(candidates);
  if (typeof createProviderSnapshot !== 'function') {
    fail('missing_snapshot_loader', 'createProviderSnapshot is required');
  }
  if (!Number.isInteger(downloadConcurrency) || downloadConcurrency < 1 || downloadConcurrency > 2) {
    fail('invalid_concurrency', 'download concurrency must be 1 or 2');
  }
  for (const [value, maximum, name] of [
    [upstreamTimeoutMs, LYRIC_CANDIDATE_INSPECTION_LIMITS.upstreamTimeoutMs, 'upstreamTimeoutMs'],
    [batchTimeoutMs, LYRIC_CANDIDATE_INSPECTION_LIMITS.batchTimeoutMs, 'batchTimeoutMs'],
    [maxResponseBytes, LYRIC_CANDIDATE_INSPECTION_LIMITS.maxResponseBytes, 'maxResponseBytes'],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      fail('invalid_limit', `${name} exceeds its safety boundary`);
    }
  }
  if (signal?.aborted) throw createAbortError('aborted');
  if (normalized.length === 0) return { items: [], truncated: false };

  const batchController = new AbortController();
  const unlink = linkAbortSignal(signal, batchController);
  let batchTimedOut = false;
  const batchTimer = setTimeout(() => {
    batchTimedOut = true;
    batchController.abort('batch_timeout');
  }, batchTimeoutMs);
  const startedAt = Date.now();
  const operationTimeout = () => Math.max(
    1,
    Math.min(upstreamTimeoutMs, batchTimeoutMs - (Date.now() - startedAt)),
  );

  try {
    const sources = [...new Set(normalized.map(({ source }) => source))];
    const snapshots = new Map();
    await Promise.all(sources.map(async (source) => {
      const timeoutMs = operationTimeout();
      try {
        const snapshot = await runTimed(
          (operationSignal) => createProviderSnapshot(source, song, { signal: operationSignal }),
          { signal: batchController.signal, timeoutMs },
        );
        snapshots.set(source, { snapshot: normalizeSnapshot(snapshot, source) });
      } catch (error) {
        snapshots.set(source, { error, batchLimited: timeoutMs < upstreamTimeoutMs });
      }
    }));
    if (signal?.aborted) throw createAbortError('aborted');

    const items = new Array(normalized.length);
    let cursor = 0;
    const inspectNext = async () => {
      while (cursor < normalized.length) {
        const index = cursor;
        cursor += 1;
        const candidate = normalized[index];
        const sourceSnapshot = snapshots.get(candidate.source);
        if (sourceSnapshot?.error) {
          items[index] = errorItem(
            candidate,
            safeErrorCode(sourceSnapshot.error, 'search', batchTimedOut || sourceSnapshot.batchLimited),
          );
          continue;
        }
        if (!sourceSnapshot?.snapshot.providerLyricIds.has(candidate.providerLyricId)) {
          items[index] = errorItem(candidate, 'candidate_not_found');
          continue;
        }
        const timeoutMs = operationTimeout();
        try {
          const document = await runTimed(
            (operationSignal) => sourceSnapshot.snapshot.loadDocument(
              candidate.providerLyricId,
              { signal: operationSignal },
            ),
            { signal: batchController.signal, timeoutMs },
          );
          items[index] = projectDocument(candidate, document);
        } catch (error) {
          items[index] = errorItem(candidate, safeErrorCode(
            error,
            'download',
            batchTimedOut || timeoutMs < upstreamTimeoutMs,
          ));
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(downloadConcurrency, normalized.length) },
      () => inspectNext(),
    ));
    if (signal?.aborted) throw createAbortError('aborted');
    return enforceResponseLimit(items, maxResponseBytes);
  } finally {
    clearTimeout(batchTimer);
    unlink();
  }
}
