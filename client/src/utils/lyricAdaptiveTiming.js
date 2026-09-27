/**
 * Adaptive timing algorithms for immersive lyrics.
 * Dynamically calculates line transitions, word lead-in, and animation durations
 * based on line gaps, word tempo, and singing progress.
 */

const DEFAULT_GAP_SECONDS = 0.8;
const DEFAULT_WORD_DURATION_SECONDS = 0.35;

/**
 * Clamp a number between min and max.
 */
const clamp = (val, min, max) => Math.min(max, Math.max(min, val));

/**
 * Compute adaptive transition timing for a lyric line based on neighboring gaps and word tempo.
 *
 * @param {Object} params
 * @param {Object} [params.line] - Current line object
 * @param {Object} [params.prevLine] - Previous line object
 * @param {Object} [params.nextLine] - Next line object
 * @param {number} [params.prevGap] - Explicit preceding gap in seconds
 * @param {number} [params.nextGap] - Explicit succeeding gap in seconds
 * @returns {{
 *   lineEnterMs: number,
 *   lineDwellMs: number,
 *   lineExitMs: number,
 *   avgWordDuration: number,
 *   prevGap: number,
 *   nextGap: number
 * }}
 */
export function computeAdaptiveLineTiming({
  line = null,
  prevLine = null,
  nextLine = null,
  prevGap = null,
  nextGap = null,
} = {}) {
  // 1. Resolve gap before current line
  let resolvedPrevGap = DEFAULT_GAP_SECONDS;
  if (typeof prevGap === 'number' && Number.isFinite(prevGap)) {
    resolvedPrevGap = Math.max(0, prevGap);
  } else if (line && prevLine) {
    const curStart = Number(line.startTime ?? line.start ?? 0);
    const prevEnd = Number(prevLine.endTime ?? prevLine.end ?? prevLine.startTime ?? prevLine.start ?? curStart);
    resolvedPrevGap = Math.round(Math.max(0, curStart - prevEnd) * 1000) / 1000;
  }

  // 2. Resolve gap after current line
  let resolvedNextGap = DEFAULT_GAP_SECONDS;
  if (typeof nextGap === 'number' && Number.isFinite(nextGap)) {
    resolvedNextGap = Math.max(0, nextGap);
  } else if (typeof line?.gapToNext === 'number' && Number.isFinite(line.gapToNext)) {
    resolvedNextGap = Math.max(0, line.gapToNext);
  } else if (line && nextLine) {
    const curEnd = Number(line.endTime ?? line.end ?? line.startTime ?? line.start ?? 0);
    const nextStart = Number(nextLine.startTime ?? nextLine.start ?? curEnd);
    resolvedNextGap = Math.round(Math.max(0, nextStart - curEnd) * 1000) / 1000;
  }

  // 3. Dynamic transition durations
  // Tight gap (e.g. 0.15s rap): fast 150ms snap
  // Generous gap (e.g. 0.8s pop): smooth 280-440ms transition
  const lineEnterMs = Math.round(clamp(resolvedPrevGap * 350, 150, 440));
  const lineDwellMs = Math.round(clamp(resolvedNextGap * 300, 100, 850));
  const lineExitMs = Math.round(clamp(resolvedNextGap * 280, 150, 420));

  // 4. Calculate average word duration for tempo adaptation
  let avgWordDuration = DEFAULT_WORD_DURATION_SECONDS;
  const words = Array.isArray(line?.words) ? line.words : [];
  const meaningfulWords = words.filter((w) => !w?.isSpace && String(w?.text || '').trim().length > 0);

  if (meaningfulWords.length > 0) {
    const firstWord = meaningfulWords[0];
    const lastWord = meaningfulWords[meaningfulWords.length - 1];
    const firstStart = Number(firstWord.startTime ?? firstWord.start ?? 0);
    const lastEnd = Number(lastWord.endTime ?? lastWord.end ?? firstStart);
    const totalSpan = Math.max(0.05, lastEnd - firstStart);
    avgWordDuration = totalSpan / meaningfulWords.length;
  }

  return {
    lineEnterMs,
    lineDwellMs,
    lineExitMs,
    avgWordDuration,
    prevGap: resolvedPrevGap,
    nextGap: resolvedNextGap,
  };
}

/**
 * Compute adaptive animation duration and lead-in for a single word.
 *
 * @param {Object} word - Word object with startTime/endTime or start/end
 * @param {number} [avgWordDuration=0.35] - Fallback duration
 * @returns {{
 *   wordDur: number,
 *   wordAnimMs: number,
 *   wordLeadIn: number
 * }}
 */
export function computeAdaptiveWordTiming(word, avgWordDuration = DEFAULT_WORD_DURATION_SECONDS) {
  const start = Number(word?.startTime ?? word?.start ?? 0);
  const end = Number(word?.endTime ?? word?.end ?? (start + avgWordDuration));
  const wordDur = Math.max(0.05, end - start);

  // Fast rap words (~120ms): 160ms animation, 80ms lead-in
  // Slow ballad words (~800ms): 460ms animation, 350ms lead-in
  const wordAnimMs = Math.round(clamp(wordDur * 1.1 * 1000, 160, 460));
  const wordLeadIn = clamp(wordDur * 0.65, 0.08, 0.35);

  return {
    wordDur,
    wordAnimMs,
    wordLeadIn,
  };
}

/**
 * Compute adaptive animation duration for translation companion micro-motion.
 *
 * @param {number} [avgWordDuration=0.35]
 * @returns {{ transAnimMs: number }}
 */
export function computeAdaptiveTranslationTiming(avgWordDuration = DEFAULT_WORD_DURATION_SECONDS) {
  const transAnimMs = Math.round(clamp((avgWordDuration || DEFAULT_WORD_DURATION_SECONDS) * 1000, 180, 440));
  return { transAnimMs };
}
