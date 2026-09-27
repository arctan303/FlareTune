export const SONG_LANGUAGES = Object.freeze([
  'zh',
  'ja',
  'en',
  'ko',
  'instrumental',
  'ru',
  'es',
  'fr',
  'de',
  'sv',
  'vi',
  'yue',
  'it',
  'th',
  'pt',
  'other',
]);

export const PRIMARY_SONG_LANGUAGES = Object.freeze([
  'zh',
  'en',
  'ja',
  'ko',
  'instrumental',
]);

export const EXTENDED_SONG_LANGUAGES = Object.freeze(
  SONG_LANGUAGES.filter((language) => !PRIMARY_SONG_LANGUAGES.includes(language)),
);

const SONG_LANGUAGE_SET = new Set(SONG_LANGUAGES);
const CLEAR_SCRIPT_RATIO = 0.8;
const CLEAR_FOREIGN_MAX_HAN_RATIO = 0.2;
const CLEAR_EAST_ASIAN_FOREIGN_RATIO = 0.2;

export function isValidSongLanguage(value) {
  return typeof value === 'string' && SONG_LANGUAGE_SET.has(value);
}

export function songHasLyrics(language) {
  return isValidSongLanguage(language) && language !== 'instrumental';
}

export function songNeedsTranslation(language) {
  return songHasLyrics(language) && language !== 'zh';
}

export function resolveSongTranslationNeed(language, contentAnalysis) {
  if (language === 'instrumental') return false;
  const effectiveCharacterCount = Number(contentAnalysis?.effectiveCharacterCount);
  if (!Number.isFinite(effectiveCharacterCount) || effectiveCharacterCount <= 0
    || contentAnalysis?.detectedLang === 'empty') return songNeedsTranslation(language);

  const ratio = (value) => {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? count / effectiveCharacterCount : 0;
  };
  const chineseRatio = Number(contentAnalysis?.chineseRatio);
  const hanRatio = Number.isFinite(chineseRatio) ? chineseRatio : ratio(contentAnalysis?.hanCount);
  const kanaRatio = ratio(contentAnalysis?.kanaCount);
  const hangulRatio = ratio(contentAnalysis?.hangulCount);
  const latinRatio = ratio(contentAnalysis?.latinCount);
  const otherLetterRatio = ratio(contentAnalysis?.otherLetterCount);
  const nonHanRatio = kanaRatio + hangulRatio + latinRatio + otherLetterRatio;

  // Han-only text cannot distinguish Chinese from Japanese by script alone.
  // Use the coarse library hint only for the Japanese case; unrelated foreign
  // metadata must not turn clearly Han lyrics into an AI translation request.
  if (hanRatio >= CLEAR_SCRIPT_RATIO && nonHanRatio === 0) return language === 'ja';
  if (hanRatio <= CLEAR_FOREIGN_MAX_HAN_RATIO
    && (latinRatio + otherLetterRatio) >= CLEAR_SCRIPT_RATIO) return true;
  if (kanaRatio >= CLEAR_EAST_ASIAN_FOREIGN_RATIO
    || hangulRatio >= CLEAR_EAST_ASIAN_FOREIGN_RATIO) return true;

  // Mixed scripts and sparse kana/Hangul are inherently ambiguous. Only here
  // does the persisted song language break the tie.
  return songNeedsTranslation(language);
}

export function buildSongLanguageFilter(language, field = 's.language') {
  if (!language) return { sql: '', bindings: [] };
  const rawCodes = Array.isArray(language)
    ? language
    : String(language).split(',').map((s) => s.trim()).filter(Boolean);
  if (rawCodes.length === 0) return { sql: '', bindings: [] };
  if (!rawCodes.every(isValidSongLanguage)) return null;

  const expandedCodes = new Set();
  for (const code of rawCodes) {
    if (code === 'other') {
      EXTENDED_SONG_LANGUAGES.forEach((c) => expandedCodes.add(c));
    } else {
      expandedCodes.add(code);
    }
  }
  const uniqueList = Array.from(expandedCodes);
  if (uniqueList.length === 0) return { sql: '', bindings: [] };
  if (uniqueList.length === 1) {
    return { sql: `${field} = ?`, bindings: [uniqueList[0]] };
  }
  return {
    sql: `${field} IN (${uniqueList.map(() => '?').join(', ')})`,
    bindings: uniqueList,
  };
}
