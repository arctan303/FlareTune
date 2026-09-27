import { isNonLyricText } from './lyricsParsing.js';

const DOCUMENT_VERSION = 2;
const MAX_LINES = 2_000;
const MAX_WORDS = 20_000;
const MAX_LINE_TEXT_LENGTH = 4_000;
const MAX_WORD_TEXT_LENGTH = 500;
const MAX_LYRIC_TEXT_LENGTH = 2_000_000;
const MAX_TIME_SECONDS = 24 * 60 * 60;
const TIME_BOUNDARY_TOLERANCE_SECONDS = 0.002;

const LRC_TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_METADATA = /^\[[A-Za-z][\w-]*:/;
const SEMANTIC_LYRIC_CHARACTER = /[\p{L}\p{N}]/u;

export const LYRIC_DOCUMENT_LIMITS = Object.freeze({
  maxLines: MAX_LINES,
  maxWords: MAX_WORDS,
  maxLineTextLength: MAX_LINE_TEXT_LENGTH,
  maxWordTextLength: MAX_WORD_TEXT_LENGTH,
  maxLyricTextLength: MAX_LYRIC_TEXT_LENGTH,
  maxTimeSeconds: MAX_TIME_SECONDS,
});

const isFiniteTime = (value) => (
  Number.isFinite(value) && value >= 0 && value <= MAX_TIME_SECONDS
);

const normalizeText = (value, maxLength, label) => {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
  if (text.length > maxLength) throw new RangeError(`${label} exceeds safe length`);
  return text;
};

export function isSingableLineText(value, options = null) {
  const text = String(value || '').trim();
  if (!text || isNonLyricText(text) || !SEMANTIC_LYRIC_CHARACTER.test(text)) {
    return false;
  }
  const meta = (options && typeof options === 'object' && ('matchedTitle' in options || 'matchedArtist' in options || 'title' in options || 'artist' in options))
    ? options
    : options?.providerMeta;
  if (meta) {
    const textKey = normalizeSongDataKey(text);
    const titleKey = normalizeSongDataKey(meta.matchedTitle || meta.title);
    const artistKey = normalizeSongDataKey(meta.matchedArtist || meta.artist);
    if (textKey) {
      if ((titleKey && textKey === titleKey) || (artistKey && textKey === artistKey)) return false;
      if (titleKey && artistKey && (textKey === `${titleKey}${artistKey}` || textKey === `${artistKey}${titleKey}`)) return false;
    }
  }
  return true;
}

const normalizeSongDataKey = (value) => String(value || '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

export function isLeadingProviderMetadata(line, index, providerMeta) {
  if (index !== undefined && index !== null && index > 7) return false;
  if (isFiniteTime(line?.time) && line.time > 30) return false;
  const rawText = line?.text !== undefined ? line.text : line;
  const text = String(rawText || '').trim();
  if (!text || isNonLyricText(text)) return true;

  const textKey = normalizeSongDataKey(text);
  if (!textKey) return true;

  const matchedTitle = providerMeta?.matchedTitle || providerMeta?.title;
  const matchedArtist = providerMeta?.matchedArtist || providerMeta?.artist;
  const titleKey = normalizeSongDataKey(matchedTitle);
  const artistKey = normalizeSongDataKey(matchedArtist);

  if ((titleKey && textKey === titleKey) || (artistKey && textKey === artistKey)) return true;

  if (matchedArtist) {
    const artists = String(matchedArtist).split(/[/／,，&、+]/).map(normalizeSongDataKey).filter(Boolean);
    if (artists.some((key) => key === textKey)) return true;
    if (titleKey && artists.some((key) => textKey === `${titleKey}${key}` || textKey === `${key}${titleKey}`)) return true;
  }

  if (titleKey && artistKey && (textKey === `${titleKey}${artistKey}` || textKey === `${artistKey}${titleKey}`)) {
    return true;
  }

  if (titleKey && artistKey && textKey.includes(titleKey) && textKey.includes(artistKey)) {
    return true;
  }

  const matchedAlbum = providerMeta?.matchedAlbum || providerMeta?.album;
  const albumKey = normalizeSongDataKey(matchedAlbum);
  if (albumKey && textKey === albumKey) return true;

  return false;
}

const lrcFractionToSeconds = (fraction = '') => {
  if (!fraction) return 0;
  if (fraction.length === 1) return Number(fraction) / 10;
  if (fraction.length === 2) return Number(fraction) / 100;
  return Number(fraction.slice(0, 3).padEnd(3, '0')) / 1_000;
};

const formatLrcTimestamp = (seconds) => {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1_000));
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const remainder = totalMilliseconds % 60_000;
  const wholeSeconds = Math.floor(remainder / 1_000);
  const milliseconds = remainder % 1_000;
  return `[${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]`;
};

export function projectCanonicalLrc(lines = []) {
  const timed = lines.filter((line) => isFiniteTime(line?.time));
  if (timed.length > 0) {
    return timed
      .map((line) => `${formatLrcTimestamp(line.time)}${String(line.text || '')}`)
      .join('\n');
  }
  return lines.map((line) => String(line?.text || '')).join('\n').trim();
}

export function parseLrcDocument(lrcText, { source, format = 'lrc', providerMeta } = {}) {
  const text = normalizeText(lrcText, MAX_LYRIC_TEXT_LENGTH, 'lyrics');
  if (!text.trim()) return createLyricDocument({ source, format, lines: [], providerMeta });

  const lines = [];
  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || LRC_METADATA.test(trimmed)) continue;
    const matches = [...trimmed.matchAll(LRC_TIMESTAMP)];
    const lyricText = trimmed.replace(LRC_TIMESTAMP, '').trim();
    if (!lyricText) continue;
    if (matches.length === 0) {
      lines.push({ text: lyricText });
      if (lines.length > MAX_LINES) throw new RangeError('lyrics exceed safe line count');
      continue;
    }
    for (const match of matches) {
      const time = (Number(match[1]) * 60) + Number(match[2]) + lrcFractionToSeconds(match[3]);
      lines.push({ time, text: lyricText });
      if (lines.length > MAX_LINES) throw new RangeError('lyrics exceed safe line count');
    }
  }
  lines.sort((left, right) => {
    if (!isFiniteTime(left.time)) return 1;
    if (!isFiniteTime(right.time)) return -1;
    return left.time - right.time;
  });
  return createLyricDocument({ source, format, lines: coalesceSameTimeLines(lines), providerMeta });
}

const scriptProfile = (text) => ({
  han: /[\u3400-\u9fff]/u.test(text),
  kana: /[\u3040-\u30ff]/u.test(text),
  hangul: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text),
  latin: /[A-Za-z\u00c0-\u024f]/u.test(text),
});

const TRANSLATION_LABEL = /^[（(【\[]\s*翻译\s*[）)】\]]/u;

const stripTranslationLabel = (text) => String(text || '')
  .replace(TRANSLATION_LABEL, '')
  .trim();

function isStaticTranslationCandidate(original, candidate) {
  if (TRANSLATION_LABEL.test(String(candidate?.text || ''))) return true;
  const originalProfile = scriptProfile(original?.text || '');
  const candidateProfile = scriptProfile(candidate?.text || '');
  return ['han', 'kana', 'hangul', 'latin']
    .some((script) => originalProfile[script] !== candidateProfile[script]);
}

function coalesceSameTimeLines(lines) {
  const result = [];
  for (const current of lines) {
    const previous = result.at(-1);
    if (!previous || !isFiniteTime(previous.time) || !isFiniteTime(current.time)
      || Math.abs(previous.time - current.time) > 0.001) {
      result.push(current);
      continue;
    }
    if (isStaticTranslationCandidate(previous, current)) {
      const translation = stripTranslationLabel(current.text);
      previous.tlyric = previous.tlyric
        ? `${previous.tlyric}\n${translation}`
        : translation;
      continue;
    }
    previous.text = `${previous.text}\n${current.text}`;
  }
  return result;
}

function normalizeWord(rawWord) {
  const text = normalizeText(rawWord?.text, MAX_WORD_TEXT_LENGTH, 'word text');
  const startTime = Number(rawWord?.startTime);
  const endTime = Number(rawWord?.endTime);
  if (!text || !isFiniteTime(startTime) || !isFiniteTime(endTime) || endTime < startTime) return null;
  return { text, startTime, endTime };
}

function normalizeLine(rawLine, state) {
  const text = normalizeText(rawLine?.text, MAX_LINE_TEXT_LENGTH, 'line text');
  if (!text.trim()) return null;

  const rawTime = rawLine?.time;
  const hasTime = rawTime !== undefined && rawTime !== null;
  const time = Number(rawTime);
  if (hasTime && !isFiniteTime(time)) return { text };

  const line = hasTime ? { time, text } : { text };
  const tlyric = normalizeText(rawLine?.tlyric, MAX_LINE_TEXT_LENGTH, 'translated line text').trim();
  if (tlyric) line.tlyric = tlyric;
  const rawEndTime = rawLine?.endTime;
  if (rawEndTime !== undefined && rawEndTime !== null) {
    const endTime = Number(rawEndTime);
    if (hasTime && isFiniteTime(endTime) && endTime >= time) line.endTime = endTime;
  }

  if (!hasTime || !Array.isArray(rawLine?.words) || rawLine.words.length === 0) return line;
  if ((state.wordCount + rawLine.words.length) > MAX_WORDS) {
    throw new RangeError('lyrics exceed safe word count');
  }
  state.wordCount += rawLine.words.length;

  const words = rawLine.words.map(normalizeWord);
  if (words.some((word) => !word)) return line;
  if (words.map((word) => word.text).join('') !== text) return line;

  let previousStart = -1;
  let previousEnd = -1;
  for (const word of words) {
    if (word.startTime < time
      || word.startTime < previousStart
      || word.startTime + TIME_BOUNDARY_TOLERANCE_SECONDS < previousEnd) return line;
    if (line.endTime !== undefined
      && word.endTime > (line.endTime + TIME_BOUNDARY_TOLERANCE_SECONDS)) return line;
    previousStart = word.startTime;
    previousEnd = Math.max(previousEnd, word.endTime);
  }

  const derivedEndTime = Math.max(...words.map((word) => word.endTime));
  if (line.endTime === undefined || derivedEndTime > line.endTime) line.endTime = derivedEndTime;
  line.words = words;
  return line;
}

export function createLyricDocument({
  source,
  format,
  lines = [],
  lrc = '',
  providerMeta,
} = {}) {
  if (!['kugou', 'netease', 'lrclib', 'manual'].includes(source)) throw new TypeError('invalid lyric source');
  if (!['krc', 'lyricsfile', 'lrc', 'plain'].includes(format)) throw new TypeError('invalid lyric format');
  if (!Array.isArray(lines)) throw new TypeError('lyrics lines must be an array');
  if (lines.length > MAX_LINES) throw new RangeError('lyrics exceed safe line count');
  normalizeText(lrc, MAX_LYRIC_TEXT_LENGTH, 'canonical lrc');

  const state = { wordCount: 0 };
  const normalizedLines = lines.map((line) => normalizeLine(line, state)).filter(Boolean);
  normalizedLines.sort((left, right) => {
    if (!isFiniteTime(left.time)) return 1;
    if (!isFiniteTime(right.time)) return -1;
    return left.time - right.time;
  });
  const singableLines = normalizedLines.filter((line, index) => (
    isSingableLineText(line.text, providerMeta) && !isLeadingProviderMetadata(line, index, providerMeta)
  ));
  const allSingableLinesHaveWords = singableLines.length > 0
    && singableLines.every((line) => isFiniteTime(line.time) && line.words?.length > 0);
  const hasTimedSingableLine = singableLines.some((line) => isFiniteTime(line.time));
  const syncMode = allSingableLinesHaveWords ? 'word' : (hasTimedSingableLine ? 'line' : 'none');

  const document = {
    version: DOCUMENT_VERSION,
    source,
    format,
    syncMode,
    lrc: projectCanonicalLrc(normalizedLines) || normalizeText(lrc, MAX_LYRIC_TEXT_LENGTH, 'canonical lrc'),
    lines: normalizedLines,
  };
  if (providerMeta && typeof providerMeta === 'object') {
    const safeMeta = {};
    if (providerMeta.providerLyricId !== undefined) {
      safeMeta.providerLyricId = normalizeText(String(providerMeta.providerLyricId), 256, 'provider lyric id');
    }
    if (providerMeta.matchedTitle !== undefined) {
      safeMeta.matchedTitle = normalizeText(String(providerMeta.matchedTitle), 1_000, 'matched title');
    }
    if (providerMeta.matchedArtist !== undefined) {
      safeMeta.matchedArtist = normalizeText(String(providerMeta.matchedArtist), 1_000, 'matched artist');
    }
    const matchedDuration = Number(providerMeta.matchedDuration);
    if (Number.isFinite(matchedDuration) && matchedDuration > 0 && matchedDuration <= MAX_TIME_SECONDS) {
      safeMeta.matchedDuration = matchedDuration;
    }
    if (providerMeta.durationDelta !== null && providerMeta.durationDelta !== undefined
      && providerMeta.durationDelta !== '') {
      const durationDelta = Number(providerMeta.durationDelta);
      if (Number.isFinite(durationDelta) && durationDelta >= 0 && durationDelta <= MAX_TIME_SECONDS) {
        safeMeta.durationDelta = durationDelta;
      }
    }
    if (providerMeta.versionMismatch !== undefined) {
      safeMeta.versionMismatch = Boolean(providerMeta.versionMismatch);
    }
    if (Object.keys(safeMeta).length > 0) document.providerMeta = safeMeta;
  }
  return document;
}

export function validateLyricDocument(document) {
  try {
    const normalized = createLyricDocument(document);
    return { valid: true, document: normalized, errors: [] };
  } catch (error) {
    return { valid: false, document: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
