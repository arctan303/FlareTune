import { isSingableLineText } from '../utils/lyricDocument.js';

export const AUTOMATIC_LYRIC_CANDIDATE_LIMIT = 5;
export const AUTOMATIC_LYRIC_CLOSE_DURATION_SECONDS = 5;
export const AUTOMATIC_LYRIC_MAX_DURATION_SECONDS = 15;

export const documentQuality = (document) => {
  if (document?.syncMode === 'word') return 3;
  if (document?.syncMode === 'line') return 2;
  if (document?.lines?.some((line) => isSingableLineText(line.text, document.providerMeta))) return 1;
  return 0;
};

export const resolutionQuality = (document) => {
  const quality = documentQuality(document);
  return quality ? quality * 2
    + (document?.lines?.some((line) => String(line?.tlyric || '').trim()) ? 1 : 0) : 0;
};

export const reliableAutomaticMetadata = (meta) => !meta?.versionMismatch
  && (!Number.isFinite(meta?.durationDelta)
    || (meta.durationDelta >= 0 && meta.durationDelta <= AUTOMATIC_LYRIC_MAX_DURATION_SECONDS));

export const reliableAutomaticMatch = (document) => reliableAutomaticMetadata(document?.providerMeta);

const automaticScore = (document) => {
  if (!document || !reliableAutomaticMatch(document) || resolutionQuality(document) === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const delta = document.providerMeta?.durationDelta;
  // Close recordings compare precision, then translation. Outside that window,
  // confidence decays continuously: 14-second word timing loses to a close LRC.
  const durationPenalty = Number.isFinite(delta)
    ? Math.max(0, delta - AUTOMATIC_LYRIC_CLOSE_DURATION_SECONDS) * 0.5
    : 1;
  return resolutionQuality(document) - durationPenalty;
};

const durationDelta = (document) => Number.isFinite(document?.providerMeta?.durationDelta)
  ? document.providerMeta.durationDelta : Number.POSITIVE_INFINITY;

// Positive means left is preferred. Equality deliberately keeps the current
// candidate, so equal-quality provider results do not cause asset churn.
export function compareAutomaticDocuments(left, right) {
  const leftScore = automaticScore(left);
  const rightScore = automaticScore(right);
  if (leftScore !== rightScore) return leftScore > rightScore ? 1 : -1;
  if (leftScore === Number.NEGATIVE_INFINITY) return 0;
  const leftDelta = durationDelta(left);
  const rightDelta = durationDelta(right);
  return leftDelta === rightDelta ? 0 : (leftDelta < rightDelta ? 1 : -1);
}

export const preferredAutomaticDocument = (candidate, current) => (
  compareAutomaticDocuments(candidate, current) > 0
);

export const isBestPossibleAutomaticDocument = (document) => (
  reliableAutomaticMatch(document) && resolutionQuality(document) === 7
  && durationDelta(document) === 0
);
