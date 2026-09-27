export const AI_TYPEWRITER_INTERVAL_MS = 19;

export function reconcileAiResponseContent(streamedContent, finalContent) {
  if (finalContent.startsWith(streamedContent)) {
    return { reset: false, append: finalContent.slice(streamedContent.length) };
  }
  return { reset: true, append: finalContent };
}

function segmentGraphemes(text) {
  if (!text) return [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), ({ segment }) => segment);
  }
  return Array.from(text);
}

export function insertInlineCursorHtml(rawHtml) {
  const cursorHtml = '<span class="ai-typing-cursor" aria-hidden="true"></span>';
  if (!rawHtml) return cursorHtml;

  const trimmed = rawHtml.trimEnd();
  const closingChain = trimmed.match(/((?:\s*<\/(?:p|li|blockquote|h[1-6]|code|pre|span|em|strong|b|i|a|td|th|tr|thead|tbody|tfoot|table|ul|ol)>)+)$/i);
  if (closingChain && closingChain.index !== undefined) {
    const before = trimmed.slice(0, closingChain.index).replace(/\s+$/, '');
    return `${before}${cursorHtml}${closingChain[1].trimStart()}`;
  }

  return `${trimmed}${cursorHtml}`;
}

export function createAiResponseTypewriter({
  onDisplay,
  prefersReducedMotion = false,
  intervalMs = AI_TYPEWRITER_INTERVAL_MS,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (timerId) => clearTimeout(timerId),
} = {}) {
  if (typeof onDisplay !== 'function') {
    throw new TypeError('onDisplay must be a function');
  }

  let sourceText = '';
  let graphemes = [];
  let displayedCount = 0;
  let timerId = null;
  let inputClosed = false;
  let cancelled = false;
  let finishPromise = null;
  let resolveFinish = null;

  const getDisplayedText = () => graphemes.slice(0, displayedCount).join('');
  const getFullText = () => sourceText;

  const settleIfReady = () => {
    if (!inputClosed || timerId !== null || displayedCount < graphemes.length) return;
    if (resolveFinish) resolveFinish(getDisplayedText());
    finishPromise = null;
    resolveFinish = null;
  };

  const scheduleNext = () => {
    if (cancelled || timerId !== null) return;
    if (displayedCount >= graphemes.length) {
      settleIfReady();
      return;
    }
    const step = Math.min(12, Math.max(1, Math.ceil(graphemes.length / 180)));
    const delay = intervalMs;
    timerId = schedule(() => {
      timerId = null;
      if (cancelled) return;
      displayedCount = Math.min(graphemes.length, displayedCount + step);
      onDisplay(getDisplayedText());
      scheduleNext();
    }, delay);
  };

  return {
    append(chunk) {
      if (cancelled || inputClosed || !chunk) return;
      const previousDisplayedText = getDisplayedText();
      sourceText += chunk;
      graphemes = segmentGraphemes(sourceText);
      if (displayedCount > graphemes.length) displayedCount = graphemes.length;
      if (getDisplayedText() !== previousDisplayedText) onDisplay(getDisplayedText());
      if (prefersReducedMotion) {
        displayedCount = graphemes.length;
        onDisplay(getDisplayedText());
        settleIfReady();
        return;
      }
      scheduleNext();
    },
    reset() {
      if (cancelled || inputClosed) return getDisplayedText();
      if (timerId !== null) cancelSchedule(timerId);
      timerId = null;
      sourceText = '';
      graphemes = [];
      displayedCount = 0;
      onDisplay('');
      return '';
    },
    finish() {
      if (cancelled) return Promise.resolve(getDisplayedText());
      inputClosed = true;
      if (prefersReducedMotion && displayedCount < graphemes.length) {
        displayedCount = graphemes.length;
        onDisplay(getDisplayedText());
      }
      if (displayedCount >= graphemes.length && timerId === null) {
        return Promise.resolve(getDisplayedText());
      }
      if (!finishPromise) {
        finishPromise = new Promise((resolve) => {
          resolveFinish = resolve;
        });
      }
      scheduleNext();
      return finishPromise;
    },
    cancel() {
      if (cancelled) return getDisplayedText();
      cancelled = true;
      inputClosed = true;
      if (timerId !== null) cancelSchedule(timerId);
      timerId = null;
      graphemes = graphemes.slice(0, displayedCount);
      sourceText = getDisplayedText();
      if (resolveFinish) resolveFinish(getDisplayedText());
      finishPromise = null;
      resolveFinish = null;
      return getDisplayedText();
    },
    getFullText,
    getDisplayedText,
    isBusy() {
      return displayedCount < graphemes.length;
    },
  };
}
