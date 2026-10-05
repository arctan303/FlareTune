import { createLyricDocument } from '../utils/lyricDocument.js';
import {
  invalidateSourceLyricsDocumentCache,
  listSourceLyricCandidates,
  LyricSourceError,
} from './lyricSourceLoader.js';

const hasTimeline = (value) => value !== undefined && value !== null && Number.isFinite(Number(value));
const shiftedTime = (value, offsetSeconds) => Math.max(0,
  Math.round((Number(value) + offsetSeconds) * 1000) / 1000);

const SOURCE_RANK = Object.freeze({ kugou: 0, netease: 1, lrclib: 2 });

const finiteOr = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const compareText = (left, right) => {
  const first = String(left ?? '');
  const second = String(right ?? '');
  if (first === second) return 0;
  return first < second ? -1 : 1;
};

const candidateIdentity = (candidate) => {
  const source = String(candidate?.source || '');
  const providerLyricId = String(candidate?.providerLyricId || '');
  return source && providerLyricId ? `${source}:${providerLyricId}` : '';
};

const compareResolutionCandidates = (left, right) => (
  finiteOr(right?.score, Number.NEGATIVE_INFINITY)
    - finiteOr(left?.score, Number.NEGATIVE_INFINITY)
  || finiteOr(left?.durationDelta, Number.POSITIVE_INFINITY)
    - finiteOr(right?.durationDelta, Number.POSITIVE_INFINITY)
  || finiteOr(SOURCE_RANK[left?.source], Number.POSITIVE_INFINITY)
    - finiteOr(SOURCE_RANK[right?.source], Number.POSITIVE_INFINITY)
  || compareText(left?.providerLyricId, right?.providerLyricId)
  || compareText(left?.matchedTitle, right?.matchedTitle)
  || compareText(left?.matchedArtist, right?.matchedArtist)
  || compareText(left?.matchedAlbum, right?.matchedAlbum)
  || finiteOr(left?.matchedDuration, Number.POSITIVE_INFINITY)
    - finiteOr(right?.matchedDuration, Number.POSITIVE_INFINITY)
  || compareText(left?.versionMismatch, right?.versionMismatch)
);

export function mergeLyricsResolutionCandidates(providerCandidateGroups) {
  const ranked = (Array.isArray(providerCandidateGroups) ? providerCandidateGroups : [])
    .flatMap((group) => (Array.isArray(group) ? group : []))
    .filter((candidate) => candidateIdentity(candidate))
    .sort(compareResolutionCandidates);
  const seen = new Set();
  return ranked.filter((candidate) => {
    const identity = candidateIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function applyLyricOffset(document, offsetMs) {
  const numericOffset = Number(offsetMs);
  if (!Number.isInteger(numericOffset) || numericOffset < -5000 || numericOffset > 5000) {
    throw new RangeError('lyric offset must be an integer between -5000 and 5000 milliseconds');
  }
  if (!document || numericOffset === 0) return createLyricDocument(document);
  const offsetSeconds = numericOffset / 1_000;
  const lines = document.lines.map((line) => {
    if (!hasTimeline(line.time)) return { ...line };
    const time = shiftedTime(line.time, offsetSeconds);
    const shifted = { ...line, time };
    if (hasTimeline(line.endTime)) shifted.endTime = Math.max(time, shiftedTime(line.endTime, offsetSeconds));
    if (Array.isArray(line.words) && line.words.length > 0) {
      shifted.words = line.words.map((word) => {
        const startTime = Math.max(time, shiftedTime(word.startTime, offsetSeconds));
        return {
          ...word,
          startTime,
          endTime: Math.max(startTime, shiftedTime(word.endTime, offsetSeconds)),
        };
      });
      const lastWordEnd = Math.max(...shifted.words.map((word) => word.endTime));
      shifted.endTime = Math.max(shifted.endTime ?? time, lastWordEnd);
    }
    return shifted;
  });
  return createLyricDocument({
    source: document.source,
    format: document.format,
    lines,
    providerMeta: document.providerMeta,
  });
}

export async function listLyricsResolutionCandidates(song, {
  signal,
  source: selectedSource = 'all',
  listCandidates = listSourceLyricCandidates,
} = {}) {
  if (!['all', 'kugou', 'netease', 'lrclib'].includes(selectedSource)) {
    throw new RangeError('invalid lyric source filter');
  }
  const providerCandidateGroups = [];
  const warnings = [];
  for (const source of selectedSource === 'all' ? ['kugou', 'netease', 'lrclib'] : [selectedSource]) {
    try {
      const providerCandidates = await listCandidates(source, song, { signal });
      if (!Array.isArray(providerCandidates)) throw new TypeError('provider candidates must be an array');
      providerCandidateGroups.push(providerCandidates);
    } catch (error) {
      if (error instanceof LyricSourceError && error.kind === 'aborted') throw error;
      warnings.push({
        source,
        code: error instanceof LyricSourceError ? error.kind : 'invalid',
      });
    }
  }
  return {
    candidates: mergeLyricsResolutionCandidates(providerCandidateGroups),
    warnings,
  };
}

export function invalidateLyricsResolutionCache(songId) {
  return invalidateSourceLyricsDocumentCache(songId);
}
