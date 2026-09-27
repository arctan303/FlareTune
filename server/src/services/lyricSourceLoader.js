import {
  LYRIC_DOCUMENT_LIMITS,
  createLyricDocument,
  isLeadingProviderMetadata,
  isSingableLineText,
  parseLrcDocument,
} from '../utils/lyricDocument.js';
import { decodeKrcPayload, KrcDecodeError } from '../utils/krcDecoder.js';
import { parseKrcTranslationLines } from '../utils/krcTranslation.js';
import {
  buildKugouDurationMsCandidates, buildKugouSearchKeywords, candidateValue, createAuditCandidateDto, createProviderMeta,
  createSafeCandidateDto, hasVersionMismatch, normalizeDurationSeconds, rankLyricCandidates, scoreLyricCandidate,
  splitArtistKeys,
} from './lyricSourceMatching.js';
import {
  createCachedSourceDocumentFetcherCore,
  createSingleFlightDocumentFetcherCore,
} from './lyricSourceCache.js';
import { LyricSourceError } from './lyricSourceError.js';
import { searchNeteaseSelections, loadNeteaseSelection } from './neteaseLyricLoader.js';
import { isBadLyricsData, parseLyricsfile } from './lyricPlainParsers.js';

export { LyricSourceError } from './lyricSourceError.js';
export { isBadLyricsData, parseLyricsfile } from './lyricPlainParsers.js';
export { buildKugouDurationMsCandidates, buildKugouSearchKeyword, buildKugouSearchKeywords, rankLyricCandidates, scoreLyricCandidate } from './lyricSourceMatching.js';

const VALID_SOURCES = new Set(['kugou', 'netease', 'lrclib']);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_JSON_BYTES = 4_000_000;
const MAX_KRC_COMPRESSED_BYTES = 2_000_000;
const MAX_KRC_DECOMPRESSED_BYTES = LYRIC_DOCUMENT_LIMITS.maxLyricTextLength;
const LRCLIB_USER_AGENT = 'FlareTune/1.0.0';

export const isValidLyricSource = (source) => VALID_SOURCES.has(source);

export function resolveLyricSourceOrder(source) {
  if (source === 'lrclib') return ['lrclib'];
  if (source === 'netease') return ['netease'];
  if (source === 'kugou') return ['kugou'];
  return ['kugou', 'netease', 'lrclib'];
}

const normalizeAuditEvidence = (provider, evidence) => {
  let document;
  try {
    document = createLyricDocument(evidence?.document);
  } catch (error) {
    throw new LyricSourceError('invalid', provider, 'audit-evidence', `${provider} returned an invalid audit document`, { cause: error });
  }
  if (document.source !== provider) {
    throw new LyricSourceError('invalid', provider, 'audit-evidence', `${provider} returned cross-provider audit evidence`);
  }
  if (!Array.isArray(evidence?.candidates) || evidence.candidates.length === 0) {
    throw new LyricSourceError('invalid', provider, 'audit-evidence', `${provider} returned no ranked audit candidates`);
  }
  const seenCandidateIds = new Set();
  const candidates = evidence.candidates.flatMap((candidate) => {
    const providerLyricId = candidate?.providerLyricId === undefined || candidate?.providerLyricId === null
      ? ''
      : String(candidate.providerLyricId);
    const durationDelta = Number(candidate?.durationDelta);
    const score = Number(candidate?.score);
    if (candidate?.source !== provider || !providerLyricId
      || !Number.isFinite(durationDelta) || durationDelta < 0
      || !Number.isFinite(score)) {
      throw new LyricSourceError('invalid', provider, 'audit-evidence', `${provider} returned an invalid audit candidate`);
    }
    if (seenCandidateIds.has(providerLyricId)) return [];
    seenCandidateIds.add(providerLyricId);
    return [{ source: provider, providerLyricId, durationDelta, score }];
  });
  const selectedProviderLyricId = evidence?.selectedProviderLyricId === undefined
    || evidence?.selectedProviderLyricId === null
    ? ''
    : String(evidence.selectedProviderLyricId);
  if (!selectedProviderLyricId
    || document.providerMeta?.providerLyricId !== selectedProviderLyricId
    || !candidates.some(({ providerLyricId }) => providerLyricId === selectedProviderLyricId)) {
    throw new LyricSourceError('invalid', provider, 'audit-evidence', `${provider} audit selection does not match its ranked snapshot`);
  }
  return { document, candidates, selectedProviderLyricId };
};

const responseStatusKind = (response) => {
  if (response?.status === 404) return 'unavailable';
  if (response?.status === 408 || response?.status === 504) return 'timeout';
  if (response?.status === 429) return 'rate_limited';
  if (response?.status >= 500) return 'upstream';
  return 'invalid';
};

const byteLength = (value) => new TextEncoder().encode(value).byteLength;

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

async function fetchLimitedJson(fetchImpl, url, {
  provider,
  stage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal: requestSignal,
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
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: provider === 'lrclib'
        ? { Accept: 'application/json', 'User-Agent': LRCLIB_USER_AGENT, 'Lrclib-Client': 'FlareTune' }
        : { Accept: 'application/json' },
    });
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

const decodeBase64 = (value, provider, stage) => {
  if (typeof value !== 'string' || !value) {
    throw new LyricSourceError('invalid', provider, stage, `${provider} ${stage} omitted content`);
  }
  let binary;
  try {
    binary = atob(value);
  } catch (error) {
    throw new LyricSourceError('invalid', provider, stage, `${provider} ${stage} returned invalid base64`, { cause: error });
  }
  if (binary.length > MAX_KRC_COMPRESSED_BYTES) {
    throw new LyricSourceError('invalid', provider, stage, `${provider} ${stage} content exceeds safe size`);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export async function decodeKrcContent(encodedContent) {
  try {
    return await decodeKrcPayload(encodedContent, {
      maximumCompressedBytes: MAX_KRC_COMPRESSED_BYTES,
      maximumDecompressedBytes: MAX_KRC_DECOMPRESSED_BYTES,
    });
  } catch (error) {
    if (error instanceof KrcDecodeError) {
      throw new LyricSourceError('invalid', 'kugou', error.stage, error.message, { cause: error });
    }
    throw error;
  }
}

export function parseKrcLyrics(krcText, { providerMeta } = {}) {
  const text = String(krcText || '').replace(/\r\n?/g, '\n');
  if (!text.trim() || text.length > MAX_KRC_DECOMPRESSED_BYTES) {
    throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC text is empty or exceeds safe size');
  }
  const globalOffsetMatch = text.match(/^\[offset:([-+]?\d+)]/mi);
  const globalOffsetMs = globalOffsetMatch ? Number(globalOffsetMatch[1]) : 0;
  const lines = [];
  let wordCount = 0;
  for (const rawLine of text.split('\n')) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || /^\[[A-Za-z][\w-]*:/u.test(trimmedLine)) continue;
    const structuralLine = rawLine.trimStart();
    const lineMatch = structuralLine.match(/^\[([^,\]]+),([^\]]+)\](.*)$/u);
    const looksTimed = /^\[[^\]]*,/u.test(trimmedLine) || /^\[\s*[-+]?\d/u.test(trimmedLine);
    if (!lineMatch) {
      if (looksTimed) throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC contains a malformed timed line');
      continue;
    }
    if (!/^\d+$/u.test(lineMatch[1]) || !/^\d+$/u.test(lineMatch[2])) {
      throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC contains an invalid timed line');
    }
    const lineStartMs = Number(lineMatch[1]) + globalOffsetMs;
    const lineDurationMs = Number(lineMatch[2]);
    const payload = lineMatch[3];
    if (!Number.isSafeInteger(lineStartMs) || lineStartMs < 0
      || !Number.isSafeInteger(lineDurationMs) || lineDurationMs < 0) {
      throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC timed line is outside the valid range');
    }

    const words = [];
    const tags = [...payload.matchAll(/<([^>]*)>/gu)];
    if ((payload.includes('<') || payload.includes('>')) && tags.length === 0) {
      throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC contains a malformed word tag');
    }
    if (tags.length > 0 && payload.slice(0, tags[0].index).length > 0) {
      throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC word timing does not cover the line prefix');
    }
    for (let index = 0; index < tags.length; index += 1) {
      const match = tags[index];
      const fields = match[1].split(',');
      if (fields.length !== 3 || !/^\d+$/u.test(fields[0]) || !/^\d+$/u.test(fields[1]) || fields[2] !== '0') {
        throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC contains an invalid word tag');
      }
      const nextTagIndex = tags[index + 1]?.index ?? payload.length;
      const wordText = payload.slice(match.index + match[0].length, nextTagIndex);
      if (wordText.includes('<') || wordText.includes('>')) {
        throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC contains a malformed word boundary');
      }
      const startTime = (lineStartMs + Number(fields[0])) / 1_000;
      const endTime = startTime + (Number(fields[1]) / 1_000);
      words.push({ text: wordText, startTime, endTime });
      wordCount += 1;
      if (wordCount > LYRIC_DOCUMENT_LIMITS.maxWords) {
        throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC exceeds safe word count');
      }
    }
    const lineText = tags.length > 0
      ? words.map((word) => word.text).join('')
      : payload;
    lines.push({
      time: lineStartMs / 1_000,
      endTime: (lineStartMs + lineDurationMs) / 1_000,
      text: lineText,
      words,
    });
    if (lines.length > LYRIC_DOCUMENT_LIMITS.maxLines) {
      throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC exceeds safe line count');
    }
  }
  if (lines.length === 0) {
    throw new LyricSourceError('invalid', 'kugou', 'parse-krc', 'KRC contains no timed lyric lines');
  }
  const translations = parseKrcTranslationLines(text, lines.length, {
    maximumBytes: MAX_KRC_DECOMPRESSED_BYTES,
    maximumLineLength: LYRIC_DOCUMENT_LIMITS.maxLineTextLength,
  });
  if (translations) {
    const isExemptLine = (line, index) => (
      !isSingableLineText(line.text, providerMeta) || isLeadingProviderMetadata(line, index, providerMeta)
    );
    const singableLineEntries = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line, index }) => !isExemptLine(line, index));

    const totalSingable = singableLineEntries.length;
    const translatedSingable = singableLineEntries.filter(
      ({ index }) => Boolean(String(translations[index] || '').trim()),
    ).length;

    const coverage = totalSingable > 0 ? (translatedSingable / totalSingable) : 0;
    const hasCompleteTranslation = totalSingable > 0 && translatedSingable > 0 && coverage >= 0.7;

    if (hasCompleteTranslation) {
      for (let index = 0; index < lines.length; index += 1) {
        const tlyric = String(translations[index] || '').trim();
        if (tlyric) lines[index].tlyric = tlyric;
      }
    }
  }
  const meta = { ...(providerMeta || {}) };
  const embeddedTitleMatch = text.match(/^\[ti:(.+?)]/mi);
  const embeddedTitle = embeddedTitleMatch ? embeddedTitleMatch[1].trim() : '';
  const firstLineText = lines[0]?.text || '';
  const candidateTitle = meta.matchedTitle || '';
  if (hasVersionMismatch(candidateTitle, embeddedTitle) || hasVersionMismatch(candidateTitle, firstLineText)) {
    meta.versionMismatch = true;
  }
  return createLyricDocument({ source: 'kugou', format: 'krc', lines, providerMeta: meta });
}

const decodePlainContent = (content) => {
  const bytes = decodeBase64(content, 'kugou', 'download-lrc');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new LyricSourceError('invalid', 'kugou', 'decode-lrc', 'Kugou LRC is not valid UTF-8', { cause: error });
  }
};

const documentQuality = (document) => {
  if (document?.syncMode === 'word') return 3;
  if (document?.syncMode === 'line') return 2;
  if (document?.lines?.some((line) => isSingableLineText(line.text, document.providerMeta))) return 1;
  return 0;
};

const resolutionQuality = (document) => {
  const quality = documentQuality(document);
  return quality ? quality * 2
    + (document?.lines?.some((line) => String(line?.tlyric || '').trim()) ? 1 : 0) : 0;
};

const reliableAutomaticMatch = (document) => {
  const meta = document?.providerMeta;
  if (meta?.versionMismatch) return false;
  return !Number.isFinite(meta?.durationDelta) || meta.durationDelta <= 15;
};

const automaticMatchTier = (document) => {
  const delta = document?.providerMeta?.durationDelta;
  if (!Number.isFinite(delta)) return 0;
  if (delta <= 3) return 3;
  if (delta <= 8) return 2;
  return 1;
};

const preferredAutomaticDocument = (candidate, current) => {
  if (resolutionQuality(candidate) === 0) return false;
  if (!current) return true;
  const matchDifference = automaticMatchTier(candidate) - automaticMatchTier(current);
  return matchDifference > 0 || (matchDifference === 0
    && resolutionQuality(candidate) > resolutionQuality(current));
};

const asSourceError = (error, provider, stage) => (
  error instanceof LyricSourceError
    ? error
    : new LyricSourceError('invalid', provider, stage, `${provider} ${stage} failed`, { cause: error })
);

const isActionableSourceError = (error) => (
  error instanceof LyricSourceError && error.kind !== 'unavailable'
);

const optionsKey = ({ providerLyricId = '', cacheScope = '', cacheEpoch = '' } = {}) => (
  `${providerLyricId === null ? '' : String(providerLyricId)}\u0001${String(cacheScope || '')}\u0001${String(cacheEpoch)}`
);

export async function fetchLyricsDocumentWithFallback(source, song, fetchSourceDocument, options = {}) {
  const order = resolveLyricSourceOrder(source);
  const resolver = fetchSourceDocument || fetchSourceDocumentCached;
  const errors = [];
  let bestDocument = null;
  for (const provider of order) {
    if (options.signal?.aborted) {
      throw new LyricSourceError('aborted', provider, 'fallback', `${provider} request aborted`);
    }
    let document = null;
    try {
      document = await resolver(provider, song, options);
    } catch (error) {
      const sourceError = error instanceof LyricSourceError
        ? error
        : new LyricSourceError('invalid', provider, 'fallback', `${provider} returned an invalid result`, { cause: error });
      if (sourceError.kind === 'aborted') throw sourceError;
      errors.push(sourceError);
      document = null;
    }
    if (!document) continue;
    let validated;
    try {
      validated = createLyricDocument(document);
    } catch (error) {
      errors.push(new LyricSourceError('invalid', provider, 'validate', `${provider} returned an invalid document`, { cause: error }));
      continue;
    }
    if (validated.source !== provider) {
      errors.push(new LyricSourceError('invalid', provider, 'validate', `${provider} returned a cross-provider document`));
      continue;
    }
    if (source === 'auto' && !reliableAutomaticMatch(validated)) continue;
    if (source === 'auto' ? preferredAutomaticDocument(validated, bestDocument)
      : resolutionQuality(validated) > resolutionQuality(bestDocument)) bestDocument = validated;
    // A tightly matched translated word timeline cannot be improved by later sources.
    if (source === 'auto' && automaticMatchTier(validated) === 3
      && resolutionQuality(validated) === 7) return validated;
  }
  if (bestDocument) return bestDocument;
  const actionableErrors = errors.filter((error) => error.kind !== 'unavailable');
  if (actionableErrors.length > 0) {
    const priority = ['timeout', 'rate_limited', 'network', 'upstream', 'invalid', 'circuit_open'];
    const kind = priority.find((candidate) => actionableErrors.some((error) => error.kind === candidate)) || 'upstream';
    throw new LyricSourceError(kind, source === 'auto' ? 'multiple' : order[0], 'fallback', 'Lyric providers did not produce a reliable result', {
      cause: new AggregateError(actionableErrors, 'Lyric provider failures'),
    });
  }
  return null;
}

export async function fetchLyricsAuditEvidenceWithFallback(source, song, fetchSourceEvidence, options = {}) {
  const order = resolveLyricSourceOrder(source);
  const resolver = fetchSourceEvidence || defaultLoader.fetchSourceAuditEvidence;
  let bestFallback = null;
  const errors = [];
  for (const provider of order) {
    if (options.signal?.aborted) {
      throw new LyricSourceError('aborted', provider, 'fallback', `${provider} request aborted`);
    }
    let evidence = null;
    try {
      const received = await resolver(provider, song, options);
      evidence = received ? normalizeAuditEvidence(provider, received) : null;
    } catch (error) {
      const sourceError = error instanceof LyricSourceError
        ? error
        : new LyricSourceError('invalid', provider, 'fallback', `${provider} returned invalid audit evidence`, { cause: error });
      if (sourceError.kind === 'aborted') throw sourceError;
      errors.push(sourceError);
      evidence = null;
    }
    if (!evidence) continue;
    if (evidence.document.syncMode === 'word') return evidence;
    const quality = documentQuality(evidence.document);
    if (quality > 0 && (!bestFallback || quality > documentQuality(bestFallback.document))) {
      bestFallback = evidence;
    }
  }
  if (bestFallback) return bestFallback;
  const actionableErrors = errors.filter((error) => error.kind !== 'unavailable');
  if (actionableErrors.length > 0) {
    const priority = ['timeout', 'rate_limited', 'network', 'upstream', 'invalid', 'circuit_open'];
    const kind = priority.find((candidate) => actionableErrors.some((error) => error.kind === candidate)) || 'upstream';
    throw new LyricSourceError(kind, source === 'auto' ? 'multiple' : order[0], 'fallback', 'Lyric providers did not produce reliable audit evidence', {
      cause: new AggregateError(actionableErrors, 'Lyric provider failures'),
    });
  }
  return null;
}

// Temporary compatibility bridge while Phase 68 moves every caller to v2 documents.
export async function fetchLyricsWithFallback(source, title, artist, fetchLyrics) {
  const order = resolveLyricSourceOrder(source);
  let lastLrc = '';
  for (const provider of order) {
    let lrc = '';
    try {
      lrc = await fetchLyrics(provider, title, artist);
    } catch {
      lrc = '';
    }
    if (!lrc) continue;
    if (order.length > 1 && isBadLyricsData(lrc)) {
      lastLrc = lrc;
      continue;
    }
    return lrc;
  }
  return lastLrc || '';
}

const abortError = (provider, stage) => new LyricSourceError(
  'aborted', provider, stage, `${provider} request aborted`,
);

export const createSingleFlightDocumentFetcher = (fetcher) => (
  createSingleFlightDocumentFetcherCore(fetcher, { optionsKey, createAbortError: abortError })
);

export const createCachedSourceDocumentFetcher = (fetcher, options = {}) => (
  createCachedSourceDocumentFetcherCore(fetcher, {
    ...options,
    optionsKey,
    createAbortError: abortError,
    isUnavailableError: (error) => error instanceof LyricSourceError && error.kind === 'unavailable',
  })
);

export const createLyricSourceLoader = ({
  fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  circuitFailureThreshold = 3,
  circuitCooldownMs = 30_000,
} = {}) => {
  const circuits = new Map();

  const withCircuit = async (provider, task) => {
    const now = Date.now();
    const state = circuits.get(provider) || { failures: 0, openUntil: 0 };
    if (state.openUntil > now) {
      throw new LyricSourceError('circuit_open', provider, 'circuit', `${provider} circuit is temporarily open`);
    }
    try {
      const result = await task();
      circuits.set(provider, { failures: 0, openUntil: 0 });
      return result;
    } catch (error) {
      const sourceError = error instanceof LyricSourceError
        ? error
        : new LyricSourceError('invalid', provider, 'adapter', `${provider} adapter failed`, { cause: error });
      const shouldTrip = ['network', 'timeout', 'rate_limited', 'upstream'].includes(sourceError.kind);
      if (shouldTrip) {
        const currentState = circuits.get(provider) || { failures: 0, openUntil: 0 };
        const failures = currentState.failures + 1;
        circuits.set(provider, {
          failures,
          openUntil: failures >= circuitFailureThreshold ? now + circuitCooldownMs : 0,
        });
      } else if (sourceError.kind === 'unavailable') {
        circuits.set(provider, { failures: 0, openUntil: 0 });
      }
      throw sourceError;
    }
  };

  const requireSearchableSong = (provider, song, stage) => {
    const title = String(song?.title || song?.name || '').trim();
    const primaryArtist = splitArtistKeys(song?.artist)[0];
    const duration = normalizeDurationSeconds(song?.duration);
    if (!title || !primaryArtist) {
      throw new LyricSourceError('invalid', provider, stage, `${provider} matching requires title and primary artist`);
    }
    return duration;
  };

  const searchKugouSelections = async (song, signal) => {
    const duration = requireSearchableSong('kugou', song, 'search');
    const rankingOptions = {
      titleKeys: ['song', 'songname'], artistKeys: ['singer', 'singername'],
      albumKeys: ['album', 'album_name'], durationKeys: ['duration'],
    };
    let firstError = null;
    const durationMsList = buildKugouDurationMsCandidates(duration);
    for (const keyword of buildKugouSearchKeywords(song)) {
      for (const durationMs of durationMsList) {
        try {
          const searchParams = new URLSearchParams({ ver: '1', man: 'yes', client: 'pc', keyword });
          if (durationMs !== null) searchParams.set('duration', durationMs);
          const searchData = await fetchLimitedJson(
            fetchImpl,
            `https://lyrics.kugou.com/search?${searchParams}`,
            { provider: 'kugou', stage: 'search', timeoutMs, signal },
          );
          const selections = rankLyricCandidates(searchData?.candidates, song, rankingOptions)
            .filter((selection) => (
              selection.candidate?.id !== undefined
              && selection.candidate?.id !== null
              && String(selection.candidate.id)
              && typeof selection.candidate.accesskey === 'string'
              && selection.candidate.accesskey
            ));
          if (selections.length > 0) return selections;
        } catch (error) {
          if (error instanceof LyricSourceError && error.kind === 'unavailable') {
            firstError ??= error;
            continue;
          }
          throw error;
        }
      }
    }
    if (firstError) throw firstError;
    return [];
  };

  const loadKugouSelection = async (selection, signal) => {
    const providerMeta = createProviderMeta('kugou', selection.candidate, selection);
    const download = async (format) => {
      const params = new URLSearchParams({
        ver: '1', client: 'pc', id: String(selection.candidate.id),
        accesskey: String(selection.candidate.accesskey), fmt: format, charset: 'utf8',
      });
      return fetchLimitedJson(
        fetchImpl,
        `https://lyrics.kugou.com/download?${params}`,
        { provider: 'kugou', stage: `download-${format}`, timeoutMs, signal },
      );
    };

    let krcError = null;
    try {
      const krcDownload = await download('krc');
      const krcText = await decodeKrcContent(krcDownload?.content);
      const krcDocument = parseKrcLyrics(krcText, { providerMeta });
      if (documentQuality(krcDocument) > 0) return krcDocument;
    } catch (error) {
      krcError = asSourceError(error, 'kugou', 'krc');
    }

    try {
      const lrcDownload = await download('lrc');
      const lrcText = decodePlainContent(lrcDownload?.content);
      const lrcDocument = parseLrcDocument(lrcText, { source: 'kugou', format: 'lrc', providerMeta });
      if (documentQuality(lrcDocument) > 0) return lrcDocument;
      throw new LyricSourceError('unavailable', 'kugou', 'parse-lrc', 'Kugou LRC contains no lyrics');
    } catch (error) {
      const lrcError = asSourceError(error, 'kugou', 'lrc');
      if (lrcError.kind === 'unavailable' && isActionableSourceError(krcError)) throw krcError;
      throw lrcError;
    }
  };

  const getKugouDocument = (song, { signal, providerLyricId = null } = {}) => withCircuit('kugou', async () => {
    const selections = await searchKugouSelections(song, signal);
    if (providerLyricId !== null && providerLyricId !== undefined) {
      const selection = selections.find(({ candidate }) => String(candidate.id) === String(providerLyricId));
      if (!selection) {
        throw new LyricSourceError(
          'unavailable',
          'kugou',
          'override-candidate',
          'The selected Kugou candidate is no longer reliable',
        );
      }
      return loadKugouSelection(selection, signal);
    }
    if (selections.length === 0) {
      throw new LyricSourceError('unavailable', 'kugou', 'match', 'Kugou has no reliable candidate');
    }
    const topSelections = selections.slice(0, 5);
    let bestLineDoc = null;
    let lastError = null;
    for (const sel of topSelections) {
      try {
        const doc = await loadKugouSelection(sel, signal);
        if (doc?.syncMode === 'word') {
          return doc;
        }
        if (doc && !bestLineDoc && documentQuality(doc) > 0) {
          bestLineDoc = doc;
        }
      } catch (err) {
        lastError = err;
      }
    }
    if (bestLineDoc) return bestLineDoc;
    if (lastError) throw lastError;
    return loadKugouSelection(selections[0], signal);
  });

  const searchLrclibSelections = async (song, signal, {
    preferExact = false,
    includeSearchWithExact = false,
  } = {}) => {
    const duration = requireSearchableSong('lrclib', song, 'get');
    const exactParams = new URLSearchParams({
      track_name: String(song.title), artist_name: String(song.artist),
    });
    if (duration !== null) exactParams.set('duration', String(Math.round(duration)));
    if (song.album) exactParams.set('album_name', String(song.album));

    let candidates = [];
    if (preferExact) {
      try {
        const exact = await fetchLimitedJson(
          fetchImpl,
          `https://lrclib.net/api/get?${exactParams}`,
          { provider: 'lrclib', stage: 'get', timeoutMs, signal },
        );
        candidates = exact ? [exact] : [];
      } catch (error) {
        if (!(error instanceof LyricSourceError) || error.kind !== 'unavailable') throw error;
      }
    }
    const rankingOptions = {
      titleKeys: ['trackName', 'name'], artistKeys: ['artistName'],
      albumKeys: ['albumName'], durationKeys: ['duration'],
    };

    // Ordinary playback keeps the exact-get fast path. Audit evidence opts into
    // search as well, then ranks the merged raw candidates exactly once.
    const exactCandidate = preferExact ? candidates[0] : null;
    let exactSelection = exactCandidate
      ? scoreLyricCandidate(exactCandidate, song, rankingOptions)
      : null;
    const exactCandidateId = String(exactSelection?.candidate?.id ?? '');
    if (preferExact && !includeSearchWithExact && exactSelection && exactCandidateId) {
      return { selections: [exactSelection], exactSelection };
    }

    // An unreliable exact response must not shadow a reliable search result
    // carrying the same provider id but corrected matching metadata.
    if (preferExact) candidates = exactSelection ? [exactCandidate] : [];

    if (!preferExact || includeSearchWithExact || !exactSelection) {
      const searchParams = new URLSearchParams({
        track_name: String(song.title), artist_name: String(song.artist || ''),
      });
      if (song.album) searchParams.set('album_name', String(song.album));
      const search = await fetchLimitedJson(
        fetchImpl,
        `https://lrclib.net/api/search?${searchParams}`,
        { provider: 'lrclib', stage: 'search', timeoutMs, signal },
      );
      const seen = new Set(candidates.map((candidate) => String(candidate?.id ?? '')).filter(Boolean));
      for (const candidate of Array.isArray(search) ? search : []) {
        const id = String(candidate?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        candidates.push(candidate);
      }
    }
    const selections = rankLyricCandidates(candidates, song, rankingOptions).filter(({ candidate }) => (
      candidate?.id !== undefined && candidate?.id !== null && String(candidate.id)
    ));
    if (preferExact && includeSearchWithExact && exactCandidateId) {
      exactSelection = selections.find(({ candidate }) => String(candidate.id) === exactCandidateId) || null;
    }
    return { selections, exactSelection };
  };

  const loadLrclibSelection = (selection) => {
    const candidate = selection.candidate;
    const providerMeta = createProviderMeta('lrclib', candidate, selection);

    let lyricsfileError = null;
    if (candidate.lyricsfile) {
      try {
        const document = parseLyricsfile(candidate.lyricsfile, { providerMeta });
        if (documentQuality(document) > 0 || candidate.instrumental === true) return document;
      } catch (error) {
        lyricsfileError = asSourceError(error, 'lrclib', 'parse-lyricsfile');
      }
    }
    if (candidate.syncedLyrics) {
      const document = parseLrcDocument(candidate.syncedLyrics, { source: 'lrclib', format: 'lrc', providerMeta });
      if (documentQuality(document) > 0) return document;
    }
    if (candidate.plainLyrics) {
      return createLyricDocument({
        source: 'lrclib', format: 'plain',
        lines: String(candidate.plainLyrics).split(/\r?\n/)
          .filter((line) => line.trim()).map((line) => ({ text: line })),
        providerMeta,
      });
    }
    if (isActionableSourceError(lyricsfileError)) throw lyricsfileError;
    return null;
  };

  const loadBestAutomaticSelection = async (selections, load, provider) => {
    let best = null;
    let lastError = null;
    for (const selection of selections.slice(0, 5)) {
      try {
        const document = await load(selection);
        if (!document || !reliableAutomaticMatch(document)) continue;
        if (preferredAutomaticDocument(document, best)) best = document;
        if (automaticMatchTier(document) === 3 && resolutionQuality(document) === 7) return document;
      } catch (error) {
        const sourceError = asSourceError(error, provider, 'lyrics');
        if (sourceError.kind === 'aborted') throw sourceError;
        lastError = sourceError;
      }
    }
    if (best) return best;
    if (lastError) throw lastError;
    throw new LyricSourceError('unavailable', provider, 'lyrics', `${provider} candidates have no usable lyrics`);
  };

  const getLrclibDocument = (song, { signal, providerLyricId = null } = {}) => withCircuit('lrclib', async () => {
    const automatic = providerLyricId === null || providerLyricId === undefined;
    if (automatic) {
      const exact = await searchLrclibSelections(song, signal, { preferExact: true });
      let exactDocument = null;
      let exactError = null;
      if (exact.selections.length) {
        try {
          const loaded = loadLrclibSelection(exact.selections[0]);
          if (loaded && reliableAutomaticMatch(loaded)) exactDocument = loaded;
        } catch (error) {
          exactError = asSourceError(error, 'lrclib', 'lyrics');
          // A malformed exact response can still have a usable search result.
        }
        if (exactDocument && automaticMatchTier(exactDocument) === 3
          && documentQuality(exactDocument) === 3) return exactDocument;
      }
      try {
        const searchedSelections = exact.exactSelection
          ? (await searchLrclibSelections(song, signal)).selections
          : exact.selections;
        const bestSearch = await loadBestAutomaticSelection(searchedSelections, loadLrclibSelection, 'lrclib');
        return preferredAutomaticDocument(bestSearch, exactDocument) ? bestSearch : exactDocument;
      } catch (error) {
        if (error?.kind === 'aborted') throw error;
        if (exactDocument) return exactDocument;
        if (exactError && !isActionableSourceError(error)) throw exactError;
        throw error;
      }
    }
    const { selections } = await searchLrclibSelections(song, signal);
    const selection = selections.find(({ candidate }) => String(candidate.id) === String(providerLyricId));
    if (!selection) {
      throw new LyricSourceError(
        'unavailable',
        'lrclib',
        'override-candidate',
        'The selected LRCLIB candidate is no longer reliable',
      );
    }
    const document = loadLrclibSelection(selection);
    if (!document) throw new LyricSourceError('unavailable', 'lrclib', 'lyrics', 'LRCLIB candidate has no usable lyrics');
    return document;
  });

  const getNeteaseDocument = (song, { signal, providerLyricId = null } = {}) => withCircuit('netease', async () => {
    const selections = await searchNeteaseSelections(song, signal, { fetchImpl, timeoutMs });
    if (providerLyricId === null || providerLyricId === undefined) {
      return loadBestAutomaticSelection(selections,
        (selection) => loadNeteaseSelection(selection, signal, { fetchImpl, timeoutMs }), 'netease');
    }
    const selection = selections.find(({ candidate }) => String(candidate.id) === String(providerLyricId));
    if (!selection) {
      throw new LyricSourceError(
        'unavailable',
        'netease',
        'override-candidate',
        'The selected Netease candidate is no longer reliable',
      );
    }
    return loadNeteaseSelection(selection, signal, { fetchImpl, timeoutMs });
  });

  const fetchSourceAuditEvidence = (source, song, { signal } = {}) => {
    if (!isValidLyricSource(source)) {
      return Promise.reject(new LyricSourceError('invalid', source, 'audit-evidence', 'Invalid lyric source'));
    }
    return withCircuit(source, async () => {
      let selections;
      let selection;
      if (source === 'kugou') {
        selections = await searchKugouSelections(song, signal);
        [selection] = selections;
      } else if (source === 'netease') {
        selections = await searchNeteaseSelections(song, signal, { fetchImpl, timeoutMs });
        [selection] = selections;
      } else {
        const snapshot = await searchLrclibSelections(song, signal, {
          preferExact: true,
          includeSearchWithExact: true,
        });
        selections = snapshot.selections;
        const exactId = String(snapshot.exactSelection?.candidate?.id ?? '');
        selection = exactId
          ? selections.find(({ candidate }) => String(candidate.id) === exactId)
          : selections[0];
      }
      if (!selection) {
        throw new LyricSourceError('unavailable', source, 'match', `${source} has no reliable candidate`);
      }
      const document = source === 'kugou'
        ? await loadKugouSelection(selection, signal)
        : (source === 'netease'
          ? await loadNeteaseSelection(selection, signal, { fetchImpl, timeoutMs })
          : loadLrclibSelection(selection));
      if (!document) {
        throw new LyricSourceError('unavailable', source, 'lyrics', `${source} candidate has no usable lyrics`);
      }
      return normalizeAuditEvidence(source, {
        document,
        candidates: selections.map((ranked) => createAuditCandidateDto(source, ranked)).filter(Boolean),
        selectedProviderLyricId: String(selection.candidate.id),
      });
    });
  };

  const listSourceCandidates = (source, song, { signal } = {}) => {
    if (!isValidLyricSource(source)) {
      return Promise.reject(new LyricSourceError('invalid', source, 'search', 'Invalid lyric source'));
    }
    return withCircuit(source, async () => {
      let selections;
      if (source === 'kugou') {
        selections = await searchKugouSelections(song, signal);
      } else if (source === 'netease') {
        selections = await searchNeteaseSelections(song, signal, { fetchImpl, timeoutMs });
      } else {
        selections = (await searchLrclibSelections(song, signal, { preferExact: false })).selections;
      }
      return selections.map((selection) => createSafeCandidateDto(source, selection)).filter(Boolean);
    });
  };

  const createCandidateInspectionSnapshot = (source, song, { signal } = {}) => {
    if (!isValidLyricSource(source)) {
      return Promise.reject(new LyricSourceError('invalid', source, 'search', 'Invalid lyric source'));
    }
    return withCircuit(source, async () => {
      let selections;
      if (source === 'kugou') {
        selections = await searchKugouSelections(song, signal);
      } else if (source === 'netease') {
        selections = await searchNeteaseSelections(song, signal, { fetchImpl, timeoutMs });
      } else {
        selections = (await searchLrclibSelections(song, signal, { preferExact: false })).selections;
      }
      const byId = new Map(selections.map((selection) => [String(selection.candidate.id), selection]));
      return {
        providerLyricIds: [...byId.keys()],
        loadDocument: (providerLyricId, { signal: downloadSignal } = {}) => withCircuit(source, async () => {
          const selection = byId.get(String(providerLyricId));
          if (!selection) throw new LyricSourceError('unavailable', source, 'preview', 'Candidate is not in the fresh snapshot');
          const document = source === 'kugou'
            ? await loadKugouSelection(selection, downloadSignal)
            : (source === 'netease'
              ? await loadNeteaseSelection(selection, downloadSignal, { fetchImpl, timeoutMs })
              : loadLrclibSelection(selection));
          if (!document) throw new LyricSourceError('unavailable', source, 'preview', 'Candidate has no usable lyrics');
          return document;
        }),
      };
    });
  };

  const fetchSourceDocument = (source, song, options) => {
    if (!isValidLyricSource(source)) {
      return Promise.reject(new LyricSourceError('invalid', source, 'adapter', 'Invalid lyric source'));
    }
    if (source === 'kugou') return getKugouDocument(song, options);
    if (source === 'netease') return getNeteaseDocument(song, options);
    return getLrclibDocument(song, options);
  };
  const getKugouLyricsText = async (title, artist, duration = null, album = '') => (
    (await getKugouDocument({ title, artist, duration, album })).lrc
  );
  const getNeteaseLyricsText = async (title, artist, duration = null, album = '') => (
    (await getNeteaseDocument({ title, artist, duration, album })).lrc
  );
  const getLrclibLyricsText = async (title, artist, duration = null, album = '') => (
    (await getLrclibDocument({ title, artist, duration, album })).lrc
  );
  const fetchSourceLyrics = async (source, title, artist, duration = null, album = '') => (
    (await fetchSourceDocument(source, { title, artist, duration, album })).lrc
  );

  return {
    fetchSourceDocument, fetchSourceLyrics, getKugouDocument, getKugouLyricsText,
    getNeteaseDocument, getNeteaseLyricsText,
    createCandidateInspectionSnapshot, fetchSourceAuditEvidence, getLrclibDocument,
    getLrclibLyricsText, listSourceCandidates,
  };
};

const defaultLoader = createLyricSourceLoader();
const fetchSourceDocumentSingleFlight = createSingleFlightDocumentFetcher(defaultLoader.fetchSourceDocument);
const fetchSourceDocumentCached = createCachedSourceDocumentFetcher(fetchSourceDocumentSingleFlight);

export const fetchSourceDocument = fetchSourceDocumentCached;
export const fetchSourceLyricsDocument = fetchSourceDocumentCached;
export const fetchUncachedSourceLyricsDocument = defaultLoader.fetchSourceDocument;
export const fetchSourceLyrics = defaultLoader.fetchSourceLyrics;
export const fetchSourceAuditEvidence = defaultLoader.fetchSourceAuditEvidence;
export const listSourceLyricCandidates = defaultLoader.listSourceCandidates;
export const createSourceCandidateInspectionSnapshot = defaultLoader.createCandidateInspectionSnapshot;
export const invalidateSourceLyricsDocumentCache = (songId) => (
  fetchSourceDocumentCached.invalidateSong(songId)
);
