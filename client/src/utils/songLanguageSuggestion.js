const TAG_CODES = Object.freeze({
  zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh', cmn: 'zh',
  yue: 'yue', cantonese: 'yue',
  ja: 'ja', jpn: 'ja', jp: 'ja', japanese: 'ja',
  ko: 'ko', kor: 'ko', korean: 'ko',
  en: 'en', eng: 'en', english: 'en',
  ru: 'ru', rus: 'ru', russian: 'ru',
  es: 'es', spa: 'es', spanish: 'es',
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr',
  de: 'de', deu: 'de', ger: 'de', german: 'de',
  sv: 'sv', swe: 'sv', swedish: 'sv',
  vi: 'vi', vie: 'vi', vietnamese: 'vi',
  it: 'it', ita: 'it', italian: 'it',
  th: 'th', tha: 'th', thai: 'th',
  pt: 'pt', por: 'pt', portuguese: 'pt',
  instrumental: 'instrumental',
});

const suggestion = (code, source, reason) => ({ code, source, reason });

export function suggestSongLanguage(common = {}) {
  const rawTag = Array.isArray(common.language) ? common.language.join(';') : common.language;
  const tags = String(rawTag || '').toLowerCase().split(/[;,/]/)
    .map((value) => value.trim().replace(/_/g, '-').split('-')[0])
    .filter(Boolean);
  const explicit = [...new Set(tags.map((value) => TAG_CODES[value]).filter(Boolean))];
  if (explicit.length > 1) return suggestion('', 'unknown', '语言标签包含多个不同值');
  if (tags.some((value) => !TAG_CODES[value] && !['und', 'unknown', 'none'].includes(value))) {
    return suggestion('', 'unknown', '音频语言标签不在可选范围，请人工确认');
  }
  if (explicit.length === 1) return suggestion(explicit[0], 'tag', '音频语言标签');

  const text = [common.title, common.artist, common.album].filter(Boolean).join(' ');
  if (!text.trim()) return suggestion('', 'unknown', '没有可判断的文字信息');
  if (/(?:\binstrumental\b|纯音乐|纯音樂|伴奏|カラオケ|インスト)/iu.test(text)) {
    return suggestion('instrumental', 'text', '标题或专辑包含纯音乐标记');
  }
  if (/[\u3040-\u30ff]/u.test(text)) return suggestion('ja', 'text', '标题等包含日文假名');
  if (/[\uac00-\ud7af]/u.test(text)) return suggestion('ko', 'text', '标题等包含韩文');
  if (/[\u0e00-\u0e7f]/u.test(text)) return suggestion('th', 'text', '标题等包含泰文');
  if (/\p{Script=Cyrillic}/u.test(text)) return suggestion('ru', 'text', '标题等包含西里尔字母');
  if (/[¿¡ñ]/iu.test(text)) return suggestion('es', 'text', '标题等包含西班牙语特征字符');
  if (/[œç]/iu.test(text)) return suggestion('fr', 'text', '标题等包含法语特征字符');
  if (/[ßäöü]/iu.test(text)) return suggestion('de', 'text', '标题等包含德语常见字符');
  if (/\p{Script=Han}/u.test(text)) return suggestion('zh', 'text', '标题等包含汉字，可能需人工修正');
  if (/[a-z]/iu.test(text)) return suggestion('en', 'text', '标题等使用拉丁字母，暂按英语推测');
  return suggestion('', 'unknown', '文字特征不足');
}
