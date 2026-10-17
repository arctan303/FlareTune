import { fetchLimitedJson } from './lyricSourceHttp.js';
import { createLrclibRequestCoordinator } from './lrclibRequestCoordinator.js';
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
  buildCustomKrcDurationMsCandidates, buildCustomKrcSearchKeywords, candidateValue, createAuditCandidateDto, createProviderMeta,
  createSafeCandidateDto, hasVersionMismatch, normalizeDurationSeconds, rankLyricCandidates, scoreLyricCandidate,
  splitArtistKeys,
} from './lyricSourceMatching.js';
import {
  createCachedSourceDocumentFetcherCore,
  createSingleFlightDocumentFetcherCore,
} from './lyricSourceCache.js';
import { LyricSourceError } from './lyricSourceError.js';
import { createLyricRequestBudget } from './lyricRequestBudget.js';
import { searchCustomLrcSelections, loadCustomLrcSelection } from './customLrcLyricLoader.js';
import { parseLyricsfile } from './lyricPlainParsers.js';
import { DEFAULT_LYRIC_SOURCES, normalizeLyricSources, isLyricSourceId } from '../../../shared/lyricSources.js';
import {
  AUTOMATIC_LYRIC_CANDIDATE_LIMIT, documentQuality, isBestPossibleAutomaticDocument,
  preferredAutomaticDocument, reliableAutomaticMatch, reliableAutomaticMetadata, resolutionQuality,
} from './lyricAutomaticSelection.js';

export { LyricSourceError } from './lyricSourceError.js';
export { parseLyricsfile } from './lyricPlainParsers.js';
export { buildCustomKrcDurationMsCandidates, buildCustomKrcSearchKeyword, buildCustomKrcSearchKeywords, rankLyricCandidates, scoreLyricCandidate } from './lyricSourceMatching.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_KRC_COMPRESSED_BYTES = 2_000_000;
const MAX_KRC_DECOMPRESSED_BYTES = LYRIC_DOCUMENT_LIMITS.maxLyricTextLength;

export const isValidLyricSource = isLyricSourceId;

export function resolveLyricSourceOrder(source, enabledSources) {
  if (enabledSources) return (source === 'auto' ? enabledSources : [source]).filter(id => isLyricSourceId(id) && enabledSources.includes(id));
  if (isLyricSourceId(source)) return [source];
  if (source === 'lrclib') return ['lrclib'];
  if (source === 'custom_lrc') return ['custom_lrc'];
  if (source === 'custom_krc') return ['custom_krc'];
  return ['custom_krc', 'custom_lrc', 'lrclib'];
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
      throw new LyricSourceError('invalid', 'custom_krc', error.stage, error.message, { cause: error });
    }
    throw error;
  }
}

export function parseKrcLyrics(krcText, { providerMeta } = {}) {
  const text = String(krcText || '').replace(/\r\n?/g, '\n');
  if (!text.trim() || text.length > MAX_KRC_DECOMPRESSED_BYTES) {
    throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC text is empty or exceeds safe size');
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
      if (looksTimed) throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC contains a malformed timed line');
      continue;
    }
    if (!/^\d+$/u.test(lineMatch[1]) || !/^\d+$/u.test(lineMatch[2])) {
      throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC contains an invalid timed line');
    }
    const lineStartMs = Number(lineMatch[1]) + globalOffsetMs;
    const lineDurationMs = Number(lineMatch[2]);
    const payload = lineMatch[3];
    if (!Number.isSafeInteger(lineStartMs) || lineStartMs < 0
      || !Number.isSafeInteger(lineDurationMs) || lineDurationMs < 0) {
      throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC timed line is outside the valid range');
    }

    const words = [];
    const tags = [...payload.matchAll(/<([^>]*)>/gu)];
    if ((payload.includes('<') || payload.includes('>')) && tags.length === 0) {
      throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC contains a malformed word tag');
    }
    if (tags.length > 0 && payload.slice(0, tags[0].index).length > 0) {
      throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC word timing does not cover the line prefix');
    }
    for (let index = 0; index < tags.length; index += 1) {
      const match = tags[index];
      const fields = match[1].split(',');
      if (fields.length !== 3 || !/^\d+$/u.test(fields[0]) || !/^\d+$/u.test(fields[1]) || fields[2] !== '0') {
        throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC contains an invalid word tag');
      }
      const nextTagIndex = tags[index + 1]?.index ?? payload.length;
      const wordText = payload.slice(match.index + match[0].length, nextTagIndex);
      if (wordText.includes('<') || wordText.includes('>')) {
        throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC contains a malformed word boundary');
      }
      const startTime = (lineStartMs + Number(fields[0])) / 1_000;
      const endTime = startTime + (Number(fields[1]) / 1_000);
      words.push({ text: wordText, startTime, endTime });
      wordCount += 1;
      if (wordCount > LYRIC_DOCUMENT_LIMITS.maxWords) {
        throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC exceeds safe word count');
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
      throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC exceeds safe line count');
    }
  }
  if (lines.length === 0) {
    throw new LyricSourceError('invalid', 'custom_krc', 'parse-krc', 'KRC contains no timed lyric lines');
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
  return createLyricDocument({ source: 'custom_krc', format: 'krc', lines, providerMeta: meta });
}

const decodePlainContent = (content) => {
  const bytes = decodeBase64(content, 'custom_krc', 'download-lrc');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new LyricSourceError('invalid', 'custom_krc', 'decode-lrc', 'CustomKrc LRC is not valid UTF-8', { cause: error });
  }
};

const asSourceError = (error, provider, stage) => (
  error instanceof LyricSourceError
    ? error
    : new LyricSourceError('invalid', provider, stage, `${provider} ${stage} failed`, { cause: error })
);

const isActionableSourceError = (error) => (
  error instanceof LyricSourceError && error.kind !== 'unavailable'
);

const combinedFailure = (errors, kind, stage) => {
  const matching = errors.filter(error => error.kind === kind);
  const retryAfterSeconds = Math.max(0, ...matching.filter(error => error.stage !== 'budget')
    .map(error => error.retryAfterSeconds || 0));
  return {
    stage: kind === 'rate_limited' && matching.every(error => error.stage === 'budget') ? 'budget' : stage,
    retryAfterSeconds: retryAfterSeconds || undefined,
  };
};

// Upgrade callers can retain completed candidates when their total search
// budget expires. The source request itself still rejects real cancellation.
// This observer is deliberately limited to uncached automatic source loading.
const automaticProgressReporter = (onAutomaticCandidate, signal) => {
  let reported = null;
  return (document) => {
    if (signal?.aborted) throw abortError(document?.source, 'progress');
    if (typeof onAutomaticCandidate !== 'function'
      || !reliableAutomaticMatch(document) || !preferredAutomaticDocument(document, reported)) return;
    reported = document;
    try { onAutomaticCandidate(document); } catch { /* Observer failures do not change provider results. */ }
    if (signal?.aborted) throw abortError(document?.source, 'progress');
  };
};

const optionsKey = ({ providerLyricId = '', cacheScope = '', cacheEpoch = '' } = {}) => (
  `${providerLyricId === null ? '' : String(providerLyricId)}\u0001${String(cacheScope || '')}\u0001${String(cacheEpoch)}`
);

export async function fetchLyricsDocumentWithFallback(source, song, fetchSourceDocument, options = {}) {
  options = { ...options, requestBudget: options.requestBudget || createLyricRequestBudget() };
  const order = resolveLyricSourceOrder(source, options.enabledSources);
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
    if (source === 'auto' && isBestPossibleAutomaticDocument(validated)) return validated;
  }
  if (bestDocument) return bestDocument;
  const actionableErrors = errors.filter((error) => error.kind !== 'unavailable');
  if (actionableErrors.length > 0) {
    const priority = ['timeout', 'rate_limited', 'network', 'upstream', 'invalid', 'circuit_open'];
    const kind = priority.find((candidate) => actionableErrors.some((error) => error.kind === candidate)) || 'upstream';
    const failure = combinedFailure(actionableErrors, kind, 'fallback');
    throw new LyricSourceError(kind, source === 'auto' ? 'multiple' : order[0], failure.stage, 'Lyric providers did not produce a reliable result', {
      cause: new AggregateError(actionableErrors, 'Lyric provider failures'),
      retryAfterSeconds: failure.retryAfterSeconds,
    });
  }
  return null;
}

export async function fetchLyricsAuditEvidenceWithFallback(source, song, fetchSourceEvidence, options = {}) {
  options = { ...options, requestBudget: options.requestBudget || createLyricRequestBudget() };
  const order = resolveLyricSourceOrder(source, options.enabledSources);
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
    const failure = combinedFailure(actionableErrors, kind, 'fallback');
    throw new LyricSourceError(kind, source === 'auto' ? 'multiple' : order[0], failure.stage, 'Lyric providers did not produce reliable audit evidence', {
      cause: new AggregateError(actionableErrors, 'Lyric provider failures'),
      retryAfterSeconds: failure.retryAfterSeconds,
    });
  }
  return null;
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
  sources = DEFAULT_LYRIC_SOURCES,
} = {}) => {
  const config = normalizeLyricSources(sources);
  const enabledSources = resolveLyricSourceOrder('auto').filter(source => config[source].enabled);
  const endpoint = (source, field, params, suffix = '') => {
    if (!config[source]?.enabled) throw new LyricSourceError('unavailable', source, 'config', 'Lyric source is disabled');
    const url = new URL(config[source][field] + suffix);
    url.search = params.toString();
    return url.href;
  };
  const lrcOptions = { fetchImpl, timeoutMs, config: config.custom_lrc };
  const circuits = new Map();
  const countedFailures = new WeakSet();
  const lrclib = createLrclibRequestCoordinator({ fetchImpl, timeoutMs });

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
      const shouldTrip = sourceError.stage !== 'budget'
        && !(provider === 'lrclib' && sourceError.kind === 'rate_limited' && sourceError.retryAfterSeconds)
        && ['network', 'timeout', 'rate_limited', 'upstream'].includes(sourceError.kind);
      if (shouldTrip && !countedFailures.has(sourceError)) {
        countedFailures.add(sourceError);
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

  const searchCustomKrcSelections = async (song, signal, requestBudget) => {
    const duration = requireSearchableSong('custom_krc', song, 'search');
    const rankingOptions = {
      titleKeys: ['song', 'songname'], artistKeys: ['singer', 'singername'],
      albumKeys: ['album', 'album_name'], durationKeys: ['duration'],
    };
    let firstError = null;
    const durationMsList = buildCustomKrcDurationMsCandidates(duration);
    for (const keyword of buildCustomKrcSearchKeywords(song)) {
      for (const durationMs of durationMsList) {
        try {
          const searchParams = new URLSearchParams({ ver: '1', man: 'yes', client: 'pc', keyword });
          if (durationMs !== null) searchParams.set('duration', durationMs);
          const searchData = await fetchLimitedJson(
            fetchImpl,
            endpoint('custom_krc', 'searchUrl', searchParams),
            { provider: 'custom_krc', stage: 'search', timeoutMs, signal, requestBudget },
          );
          if (!Array.isArray(searchData?.candidates)) {
            throw new LyricSourceError('invalid', 'custom_krc', 'search', 'Search response omitted candidates');
          }
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

  const loadCustomKrcSelection = async (selection, signal, requestBudget) => {
    const providerMeta = createProviderMeta('custom_krc', selection.candidate, selection);
    const download = async (format) => {
      const params = new URLSearchParams({
        ver: '1', client: 'pc', id: String(selection.candidate.id),
        accesskey: String(selection.candidate.accesskey), fmt: format, charset: 'utf8',
      });
      return fetchLimitedJson(
        fetchImpl,
        endpoint('custom_krc', 'downloadUrl', params),
        { provider: 'custom_krc', stage: `download-${format}`, timeoutMs, signal, requestBudget },
      );
    };

    let krcError = null;
    try {
      const krcDownload = await download('krc');
      const krcText = await decodeKrcContent(krcDownload?.content);
      const krcDocument = parseKrcLyrics(krcText, { providerMeta });
      if (documentQuality(krcDocument) > 0) return createLyricDocument({ ...krcDocument, providerMeta: { ...krcDocument.providerMeta, translationLanguage: config.custom_krc.translationLanguage } });
    } catch (error) {
      krcError = asSourceError(error, 'custom_krc', 'krc');
      if (krcError.kind === 'aborted' || krcError.stage === 'budget') throw krcError;
    }

    try {
      const lrcDownload = await download('lrc');
      const lrcText = decodePlainContent(lrcDownload?.content);
      const lrcDocument = parseLrcDocument(lrcText, { source: 'custom_krc', format: 'lrc', providerMeta });
      if (documentQuality(lrcDocument) > 0) return lrcDocument;
      throw new LyricSourceError('unavailable', 'custom_krc', 'parse-lrc', 'CustomKrc LRC contains no lyrics');
    } catch (error) {
      const lrcError = asSourceError(error, 'custom_krc', 'lrc');
      if (lrcError.kind === 'unavailable' && isActionableSourceError(krcError)) throw krcError;
      throw lrcError;
    }
  };

  const getCustomKrcDocument = (song, { signal, providerLyricId = null, onAutomaticCandidate,
    requestBudget = createLyricRequestBudget() } = {}) => withCircuit('custom_krc', async () => {
    const selections = await searchCustomKrcSelections(song, signal, requestBudget);
    if (providerLyricId !== null && providerLyricId !== undefined) {
      const selection = selections.find(({ candidate }) => String(candidate.id) === String(providerLyricId));
      if (!selection) {
        throw new LyricSourceError(
          'unavailable',
          'custom_krc',
          'override-candidate',
          'The selected CustomKrc candidate is no longer reliable',
        );
      }
      return loadCustomKrcSelection(selection, signal, requestBudget);
    }
    if (selections.length === 0) {
      throw new LyricSourceError('unavailable', 'custom_krc', 'match', 'CustomKrc has no reliable candidate');
    }
    return loadBestAutomaticSelection(selections,
      (selection) => loadCustomKrcSelection(selection, signal, requestBudget), 'custom_krc',
      automaticProgressReporter(onAutomaticCandidate, signal));
  });

  const searchLrclibSelections = async (song, signal, {
    preferExact = false,
    includeSearchWithExact = false,
    requestBudget,
    executionContext,
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
        const exact = await lrclib.request(
          endpoint('lrclib', 'baseUrl', exactParams, '/get'),
          { stage: 'get', signal, requestBudget, executionContext },
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

    // Return exact metadata first; playback compares its usable document with
    // search unless it is already optimal. Audit evidence merges both snapshots.
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
      const search = await lrclib.request(
        endpoint('lrclib', 'baseUrl', searchParams, '/search'),
        { stage: 'search', signal, requestBudget, executionContext },
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

  const loadBestAutomaticSelection = async (selections, load, provider, reportCandidate = () => {}) => {
    let best = null;
    const errors = [];
    const reliableSelections = selections.filter(reliableAutomaticMetadata)
      .slice(0, AUTOMATIC_LYRIC_CANDIDATE_LIMIT);
    for (const selection of reliableSelections) {
      try {
        const document = await load(selection);
        if (!document || !reliableAutomaticMatch(document)) continue;
        if (preferredAutomaticDocument(document, best)) {
          best = document;
          reportCandidate(document);
        }
        if (isBestPossibleAutomaticDocument(document)) return document;
      } catch (error) {
        const sourceError = asSourceError(error, provider, 'lyrics');
        if (sourceError.kind === 'aborted') throw sourceError;
        if (sourceError.stage === 'budget') {
          if (best) return best;
          throw sourceError;
        }
        errors.push(sourceError);
      }
    }
    if (best) return best;
    const actionableErrors = errors.filter(isActionableSourceError);
    if (actionableErrors.length === 1) throw actionableErrors[0];
    if (actionableErrors.length) {
      const priority = ['timeout', 'rate_limited', 'network', 'upstream', 'invalid', 'circuit_open'];
      const kind = priority.find((value) => actionableErrors.some((error) => error.kind === value)) || 'upstream';
      const failure = combinedFailure(actionableErrors, kind, 'lyrics');
      throw new LyricSourceError(kind, provider, failure.stage, `${provider} candidate downloads failed`, {
        cause: new AggregateError(actionableErrors, 'Lyric candidate failures'),
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    }
    if (errors.length) throw errors[errors.length - 1];
    throw new LyricSourceError('unavailable', provider, 'lyrics', `${provider} candidates have no usable lyrics`);
  };

  const getLrclibDocument = (song, { signal, providerLyricId = null, onAutomaticCandidate, executionContext,
    requestBudget = createLyricRequestBudget() } = {}) => withCircuit('lrclib', async () => {
    const automatic = providerLyricId === null || providerLyricId === undefined;
    if (automatic) {
      const reportCandidate = automaticProgressReporter(onAutomaticCandidate, signal);
      const exact = await searchLrclibSelections(song, signal, { preferExact: true, requestBudget, executionContext });
      let exactDocument = null;
      let exactError = null;
      if (exact.selections.length) {
        try {
          const loaded = loadLrclibSelection(exact.selections[0]);
          if (loaded && reliableAutomaticMatch(loaded)) {
            exactDocument = loaded;
            reportCandidate(loaded);
          }
        } catch (error) {
          exactError = asSourceError(error, 'lrclib', 'lyrics');
          if (exactError.kind === 'aborted') throw exactError;
          // A malformed exact response can still have a usable search result.
        }
        if (exactDocument && isBestPossibleAutomaticDocument(exactDocument)) return exactDocument;
      }
      try {
        const searchedSelections = exact.exactSelection
          ? (await searchLrclibSelections(song, signal, { requestBudget, executionContext })).selections
          : exact.selections;
        const bestSearch = await loadBestAutomaticSelection(searchedSelections, loadLrclibSelection, 'lrclib', reportCandidate);
        return preferredAutomaticDocument(bestSearch, exactDocument) ? bestSearch : exactDocument;
      } catch (error) {
        if (error?.kind === 'aborted') throw error;
        if (exactDocument) return exactDocument;
        if (exactError && !isActionableSourceError(error)) throw exactError;
        throw error;
      }
    }
    const { selections } = await searchLrclibSelections(song, signal, { requestBudget, executionContext });
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

  const getCustomLrcDocument = (song, { signal, providerLyricId = null, onAutomaticCandidate,
    requestBudget = createLyricRequestBudget() } = {}) => withCircuit('custom_lrc', async () => {
    const options = { ...lrcOptions, requestBudget };
    const selections = await searchCustomLrcSelections(song, signal, options);
    if (providerLyricId === null || providerLyricId === undefined) {
      return loadBestAutomaticSelection(selections,
        (selection) => loadCustomLrcSelection(selection, signal, options), 'custom_lrc',
        automaticProgressReporter(onAutomaticCandidate, signal));
    }
    const selection = selections.find(({ candidate }) => String(candidate.id) === String(providerLyricId));
    if (!selection) {
      throw new LyricSourceError(
        'unavailable',
        'custom_lrc',
        'override-candidate',
        'The selected CustomLrc candidate is no longer reliable',
      );
    }
    return loadCustomLrcSelection(selection, signal, options);
  });

  const fetchSourceAuditEvidence = (source, song, { signal, executionContext, requestBudget = createLyricRequestBudget() } = {}) => {
    if (!isValidLyricSource(source)) {
      return Promise.reject(new LyricSourceError('invalid', source, 'audit-evidence', 'Invalid lyric source'));
    }
    if (!enabledSources.includes(source)) return Promise.reject(new LyricSourceError('unavailable', source, 'config', 'Lyric source is disabled'));
    return withCircuit(source, async () => {
      let selections;
      let selection;
      if (source === 'custom_krc') {
        selections = await searchCustomKrcSelections(song, signal, requestBudget);
        [selection] = selections;
      } else if (source === 'custom_lrc') {
        selections = await searchCustomLrcSelections(song, signal, { ...lrcOptions, requestBudget });
        [selection] = selections;
      } else {
        const snapshot = await searchLrclibSelections(song, signal, {
          preferExact: true,
          includeSearchWithExact: true,
          requestBudget,
          executionContext,
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
      const document = source === 'custom_krc'
        ? await loadCustomKrcSelection(selection, signal, requestBudget)
        : (source === 'custom_lrc'
          ? await loadCustomLrcSelection(selection, signal, { ...lrcOptions, requestBudget })
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

  const listSourceCandidates = (source, song, { signal, executionContext, requestBudget = createLyricRequestBudget() } = {}) => {
    if (!isValidLyricSource(source)) {
      return Promise.reject(new LyricSourceError('invalid', source, 'search', 'Invalid lyric source'));
    }
    if (!enabledSources.includes(source)) return Promise.reject(new LyricSourceError('unavailable', source, 'config', 'Lyric source is disabled'));
    return withCircuit(source, async () => {
      if (signal?.aborted) throw abortError(source, 'search');
      const cacheKey = source === 'lrclib' ? JSON.stringify([
        String(song.title || ''), String(song.artist || ''), String(song.album || ''),
        normalizeDurationSeconds(song.duration),
      ]) : null;
      const cached = cacheKey === null ? undefined : lrclib.getCandidates(cacheKey);
      if (cached !== undefined) return cached;
      let selections;
      if (source === 'custom_krc') {
        selections = await searchCustomKrcSelections(song, signal, requestBudget);
      } else if (source === 'custom_lrc') {
        selections = await searchCustomLrcSelections(song, signal, { ...lrcOptions, requestBudget });
      } else {
        selections = (await searchLrclibSelections(song, signal, { preferExact: false, requestBudget, executionContext })).selections;
      }
      const result = selections.map((selection) => createSafeCandidateDto(source, selection)).filter(Boolean);
      if (cacheKey !== null) lrclib.setCandidates(cacheKey, result);
      return result;
    });
  };

  const createCandidateInspectionSnapshot = (source, song, { signal, executionContext, requestBudget = createLyricRequestBudget() } = {}) => {
    if (!isValidLyricSource(source)) {
      return Promise.reject(new LyricSourceError('invalid', source, 'search', 'Invalid lyric source'));
    }
    if (!enabledSources.includes(source)) return Promise.reject(new LyricSourceError('unavailable', source, 'config', 'Lyric source is disabled'));
    return withCircuit(source, async () => {
      let selections;
      if (source === 'custom_krc') {
        selections = await searchCustomKrcSelections(song, signal, requestBudget);
      } else if (source === 'custom_lrc') {
        selections = await searchCustomLrcSelections(song, signal, { ...lrcOptions, requestBudget });
      } else {
        selections = (await searchLrclibSelections(song, signal, { preferExact: false, requestBudget, executionContext })).selections;
      }
      const byId = new Map(selections.map((selection) => [String(selection.candidate.id), selection]));
      return {
        providerLyricIds: [...byId.keys()],
        loadDocument: (providerLyricId, { signal: downloadSignal } = {}) => withCircuit(source, async () => {
          const selection = byId.get(String(providerLyricId));
          if (!selection) throw new LyricSourceError('unavailable', source, 'preview', 'Candidate is not in the fresh snapshot');
          const document = source === 'custom_krc'
            ? await loadCustomKrcSelection(selection, downloadSignal, requestBudget)
            : (source === 'custom_lrc'
              ? await loadCustomLrcSelection(selection, downloadSignal, { ...lrcOptions, requestBudget })
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
    if (!enabledSources.includes(source)) return Promise.reject(new LyricSourceError('unavailable', source, 'config', 'Lyric source is disabled'));
    if (source === 'custom_krc') return getCustomKrcDocument(song, options);
    if (source === 'custom_lrc') return getCustomLrcDocument(song, options);
    return getLrclibDocument(song, options);
  };
  const getCustomKrcLyricsText = async (title, artist, duration = null, album = '') => (
    (await getCustomKrcDocument({ title, artist, duration, album })).lrc
  );
  const getCustomLrcLyricsText = async (title, artist, duration = null, album = '') => (
    (await getCustomLrcDocument({ title, artist, duration, album })).lrc
  );
  const getLrclibLyricsText = async (title, artist, duration = null, album = '') => (
    (await getLrclibDocument({ title, artist, duration, album })).lrc
  );
  const fetchSourceLyrics = async (source, title, artist, duration = null, album = '') => (
    (await fetchSourceDocument(source, { title, artist, duration, album })).lrc
  );

  return {
    enabledSources, fetchSourceDocument, fetchSourceLyrics, getCustomKrcDocument, getCustomKrcLyricsText,
    getCustomLrcDocument, getCustomLrcLyricsText,
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
let sourceCacheRevision = 0;
export const lyricSourceCacheRevision = () => sourceCacheRevision;
export const invalidateSourceLyricsDocumentCache = (songId) => {
  sourceCacheRevision += 1;
  return fetchSourceDocumentCached.invalidateSong(songId);
};
