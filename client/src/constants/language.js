/**
 * 歌曲语言定义与元数据映射
 */

export const PRIMARY_LANGUAGES = Object.freeze([
  { code: 'zh', label: '中文', shortLabel: '中文' },
  { code: 'ja', label: '日语', shortLabel: '日语' },
  { code: 'en', label: '英语', shortLabel: '英语' },
  { code: 'ko', label: '韩语', shortLabel: '韩语' },
  { code: 'instrumental', label: '纯音乐', shortLabel: '纯音' },
]);

export const EXTENDED_LANGUAGES = Object.freeze([
  { code: 'ru', label: '俄语', shortLabel: '俄语' },
  { code: 'es', label: '西班牙语', shortLabel: '西语' },
  { code: 'fr', label: '法语', shortLabel: '法语' },
  { code: 'de', label: '德语', shortLabel: '德语' },
  { code: 'sv', label: '瑞典语', shortLabel: '瑞典' },
  { code: 'vi', label: '越南语', shortLabel: '越语' },
  { code: 'yue', label: '粤语', shortLabel: '粤语' },
  { code: 'it', label: '意大利语', shortLabel: '意语' },
  { code: 'th', label: '泰语', shortLabel: '泰语' },
  { code: 'pt', label: '葡萄牙语', shortLabel: '葡语' },
  { code: 'other', label: '其他语言', shortLabel: '其他' },
]);

export const ALL_LANGUAGES = Object.freeze([
  ...PRIMARY_LANGUAGES,
  ...EXTENDED_LANGUAGES,
]);

export const ALL_LANGUAGE_CODES = Object.freeze(
  ALL_LANGUAGES.map((item) => item.code)
);

const LANGUAGE_CODE_SET = new Set(ALL_LANGUAGE_CODES);

const LANGUAGE_LABEL_MAP = new Map(
  ALL_LANGUAGES.map((item) => [item.code, item.label])
);

const LANGUAGE_SHORT_LABEL_MAP = new Map(
  ALL_LANGUAGES.map((item) => [item.code, item.shortLabel])
);

export function getLanguageLabel(code, fallback = '未设置') {
  if (!code) return fallback;
  return LANGUAGE_LABEL_MAP.get(code) || code;
}

export function getLanguageShortLabel(code, fallback = '未知') {
  if (!code) return fallback;
  return LANGUAGE_SHORT_LABEL_MAP.get(code) || code;
}

export function isPrimaryLanguage(code) {
  return PRIMARY_LANGUAGES.some((item) => item.code === code);
}

export function isValidSongLanguage(code) {
  return typeof code === 'string' && LANGUAGE_CODE_SET.has(code);
}

export function songLanguageHasLyrics(code) {
  return isValidSongLanguage(code) && code !== 'instrumental';
}

export function songLanguageNeedsTranslation(code) {
  return songLanguageHasLyrics(code) && code !== 'zh';
}
