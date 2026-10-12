export const LYRIC_SOURCE_LABELS = Object.freeze({
  lrclib: 'LRCLIB', custom_krc: '自定义逐字源', custom_lrc: '自定义逐行源', manual: '手动整理',
});
// Stored asset IDs from earlier versions are read-only compatibility aliases.
export const LEGACY_LYRIC_SOURCES = Object.freeze({ kugou: 'custom_krc', netease: 'custom_lrc' });
export const lyricSourceLabel = source => LYRIC_SOURCE_LABELS[LEGACY_LYRIC_SOURCES[source] || source] || '某歌词源';
export const storedLyricTranslationLanguage = translation => translation?.language
  || (['custom_krc', 'custom_lrc', 'kugou', 'netease', 'ai'].includes(translation?.source) ? 'zh' : null);
export const DEFAULT_LYRIC_SOURCES = Object.freeze({
  lrclib: Object.freeze({ enabled: true, baseUrl: 'https://lrclib.net/api' }),
  custom_krc: Object.freeze({ enabled: false, searchUrl: '', downloadUrl: '', translationLanguage: 'zh' }),
  custom_lrc: Object.freeze({ enabled: false, searchUrl: '', downloadUrl: '', translationLanguage: 'zh' }),
});

export function validateLyricEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()
    || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new Error('LYRIC_ENDPOINT_INVALID');
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  // Public DNS names only. Reject literals (including alternative IPv4 forms),
  // local suffixes, non-standard ports, and credential/query injection.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host)
    || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/u.test(host)) {
    throw new Error('LYRIC_ENDPOINT_INVALID');
  }
  return url.href.replace(/\/+$/u, '');
}

export function normalizeLyricSources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_LYRIC_SOURCES, key))) throw new Error('LYRIC_SOURCES_INVALID');
  const result = {};
  for (const [id, defaults] of Object.entries(DEFAULT_LYRIC_SOURCES)) {
    const input = value[id] ?? defaults;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !Object.hasOwn(defaults, key)) || typeof input.enabled !== 'boolean') throw new Error('LYRIC_SOURCES_INVALID');
    const config = { ...defaults, ...input };
    for (const field of id === 'lrclib' ? ['baseUrl'] : ['searchUrl', 'downloadUrl']) {
      if (config[field] === '' && !config.enabled) continue;
      config[field] = validateLyricEndpoint(config[field]);
    }
    if (id !== 'lrclib' && !['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'it', 'vi', 'th', 'sv', 'yue'].includes(config.translationLanguage)) throw new Error('LYRIC_SOURCES_INVALID');
    result[id] = config;
  }
  return result;
}
