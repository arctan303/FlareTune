const LRC_TIMESTAMP_PATTERN = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g;
const LRC_TIMESTAMP_PREFIX_PATTERN = /^(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/;
const LRC_METADATA_PATTERN = /^\[[A-Za-z][\w-]*:/;
const CREDIT_LABELS = [
  '作词', '作詞', '填词', '填詞', '词', '詞',
  '作曲', '曲',
  '词曲', '詞曲',
  '编曲', '編曲', '编配', '編配',
  '统筹', '統籌', '企划', '企劃',
  '监制', '監製', '总监制', '總監製', '音乐总监', '音樂總監',
  '制作人', '製作人', '制作', '製作',
  '出品人', '出品', '发行', '發行', '唱片公司',
  '录音', '錄音', '混音', '母带', '母帶',
  '吉他', '贝斯', '貝斯', '鼓', '钢琴', '鋼琴', '键盘', '鍵盤', '弦乐', '弦樂',
  '和声', '和聲', '和音',
  '演唱', '歌手', '主唱', '原唱',
  '歌名', '歌曲', '歌曲名', '曲名', '专辑', '專輯',
  '翻译', '翻譯',
  'OP', 'SP', 'ISRC', 'Vocal',
  'lyrics?', 'lyricist', 'words', 'composer', 'music',
  'arranger', 'arrangement', 'vocals?', 'singer', 'artist', 'album', 'title',
  'producer', 'produced', 'written', 'engineered', 'published',
  'mix(?:ed|ing)?', 'master(?:ed|ing)?',
  'record(?:ed|ing)?', 'translation',
  'guitar', 'bass', 'drums?', 'piano', 'keyboard', 'strings',
  '歌', '唄', 'プロデュース', 'ミックス', 'マスタリング',
  '작사', '작곡', '편곡', '노래', '가수', '보컬', '프로듀서', '믹싱', '마스터링',
];

const SPACE_SEPARABLE_CREDIT_LABELS = [
  '作词', '作詞', '填词', '填詞', '词', '詞',
  '作曲', '曲',
  '词曲', '詞曲',
  '编曲', '編曲', '编配', '編配',
  '统筹', '統籌', '企划', '企劃',
  '监制', '監製', '总监制', '總監製', '音乐总监', '音樂總監',
  '制作人', '製作人', '制作', '製作',
  '出品人', '出品', '发行', '發行', '唱片公司',
  '录音', '錄音', '混音', '母带', '母帶',
  '吉他', '贝斯', '貝斯', '鼓', '钢琴', '鋼琴', '键盘', '鍵盤', '弦乐', '弦樂',
  '和声', '和聲', '和音',
  '演唱', '歌手', '主唱', '原唱',
  '歌名', '歌曲', '歌曲名', '曲名', '专辑', '專輯',
  '翻译', '翻譯',
  'OP', 'SP', 'ISRC', 'Vocal',
  'lyricist', 'composer', 'arranger', 'producer',
  '歌', '唄', 'プロデュース', 'ミックス', 'マスタリング',
  '작사', '작곡', '편곡', '노래', '가수', '보컬', '프로듀서', '믹싱', '마스터링',
];

const CREDIT_DELIMITER_PATTERN = '(?::|：|[/／|｜~～\\-—–―])';
const CREDIT_ROLE_CONNECTOR = '[/／、&,+|｜~～\\-—–―]';
const SINGLE_LABEL_PATTERN = `(?:${CREDIT_LABELS.join('|')})`;
const COMPOUND_LABEL_PATTERN = `${SINGLE_LABEL_PATTERN}(?:\\s*${CREDIT_ROLE_CONNECTOR}\\s*${SINGLE_LABEL_PATTERN})*`;
const COMPOUND_WITH_CONNECTOR = `${SINGLE_LABEL_PATTERN}(?:\\s*${CREDIT_ROLE_CONNECTOR}\\s*${SINGLE_LABEL_PATTERN})+`;
const SPACE_SEPARABLE_LABEL_PATTERN = `(?:${SPACE_SEPARABLE_CREDIT_LABELS.join('|')})`;

const CREDIT_LINE_PATTERN = new RegExp(
  `^(?:`
  + `${COMPOUND_LABEL_PATTERN}\\s*${CREDIT_DELIMITER_PATTERN}`
  + `|`
  + `${COMPOUND_WITH_CONNECTOR}\\s+\\S+`
  + `|`
  + `${SPACE_SEPARABLE_LABEL_PATTERN}\\s+\\S+`
  + `)`,
  'iu',
);
const CREDIT_BY_LINE_PATTERN = /^(?:lyrics?|words|written|composed|arranged|vocals?|sung|produced|engineered|published|mixed|mastered|recorded|translated)\s+by\b/iu;
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const KANA_PATTERN = /[\u3040-\u30ff\u31f0-\u31ff]/u;
const HANGUL_PATTERN = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const LATIN_PATTERN = /[A-Za-z\u00c0-\u024f]/u;
const LETTER_PATTERN = /\p{L}/u;

const emptyLanguageAnalysis = () => ({
  chineseRatio: 0,
  needsTranslation: false,
  detectedLang: 'empty',
  effectiveCharacterCount: 0,
  hanCount: 0,
  kanaCount: 0,
  hangulCount: 0,
  latinCount: 0,
  otherLetterCount: 0,
});

export function normalizeLrcForHash(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export async function computeHash(text) {
  const bytes = new TextEncoder().encode(normalizeLrcForHash(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function isNonLyricText(text) {
  const normalized = String(text || '').trim();
  return !normalized || CREDIT_LINE_PATTERN.test(normalized) || CREDIT_BY_LINE_PATTERN.test(normalized);
}

function stripLrcLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || LRC_METADATA_PATTERN.test(trimmed)) return '';
  const withoutTimestamps = trimmed.replace(LRC_TIMESTAMP_PATTERN, '').trim();
  return isNonLyricText(withoutTimestamps) ? '' : withoutTimestamps;
}

export function analyzeLrcLanguage(lrcText, threshold = 0.5) {
  if (typeof lrcText !== 'string' || !lrcText.trim()) {
    return emptyLanguageAnalysis();
  }
  const lyricText = lrcText.split(/\r?\n/).map(stripLrcLine).filter(Boolean).join('');
  let hanCount = 0;
  let kanaCount = 0;
  let hangulCount = 0;
  let latinCount = 0;
  let otherLetterCount = 0;
  for (const character of lyricText) {
    if (HAN_PATTERN.test(character)) hanCount += 1;
    else if (KANA_PATTERN.test(character)) kanaCount += 1;
    else if (HANGUL_PATTERN.test(character)) hangulCount += 1;
    else if (LATIN_PATTERN.test(character)) latinCount += 1;
    else if (LETTER_PATTERN.test(character)) otherLetterCount += 1;
  }
  const effectiveCharacterCount = hanCount + kanaCount + hangulCount + latinCount + otherLetterCount;
  if (effectiveCharacterCount === 0) {
    return emptyLanguageAnalysis();
  }

  const chineseRatio = hanCount / effectiveCharacterCount;
  let detectedLang = 'other';
  let needsTranslation = chineseRatio < threshold;
  if (kanaCount > 0) {
    detectedLang = 'ja';
    needsTranslation = true;
  } else if (hangulCount > 0) {
    detectedLang = 'ko';
    needsTranslation = true;
  } else if (chineseRatio >= threshold) {
    detectedLang = 'zh';
    needsTranslation = false;
  } else if (latinCount > 0 && latinCount >= otherLetterCount) {
    detectedLang = 'latin';
    needsTranslation = true;
  } else if (otherLetterCount > 0) {
    detectedLang = 'other';
    needsTranslation = true;
  }
  return {
    chineseRatio,
    needsTranslation,
    detectedLang,
    effectiveCharacterCount,
    hanCount,
    kanaCount,
    hangulCount,
    latinCount,
    otherLetterCount,
  };
}

const normalizeRepeatKey = (text) => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const normalizeSongDataKey = (text) => String(text || '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

function isLeadingSongData(text, songTitle, artist) {
  const textKey = normalizeSongDataKey(text);
  const titleKey = normalizeSongDataKey(songTitle);
  const artistKey = normalizeSongDataKey(artist);
  if (!textKey) return false;
  if (titleKey && textKey === titleKey) return true;
  if (artistKey && textKey === artistKey) return true;
  if (!titleKey || !artistKey) return false;
  return textKey === `${artistKey}${titleKey}` || textKey === `${titleKey}${artistKey}`;
}

export function parseLrcLines(lrcText, { songTitle = '', artist = '' } = {}) {
  if (typeof lrcText !== 'string' || !lrcText.trim()) return [];
  const units = [];
  for (const line of lrcText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || LRC_METADATA_PATTERN.test(trimmed)) continue;
    const timestampPrefix = trimmed.match(LRC_TIMESTAMP_PREFIX_PATTERN)?.[0] || '';
    const text = (timestampPrefix ? trimmed.slice(timestampPrefix.length) : trimmed).trim();
    if (isNonLyricText(text) || (units.length === 0 && isLeadingSongData(text, songTitle, artist))) continue;

    const timestamps = timestampPrefix.match(LRC_TIMESTAMP_PATTERN) || [];
    const repeatKey = normalizeRepeatKey(text);
    const previous = units.at(-1);
    if (previous?.repeatKey === repeatKey) {
      previous.occurrences.push(timestamps);
      previous.timestamps.push(...timestamps);
      previous.repeatCount += 1;
      continue;
    }
    const unitId = units.length;
    units.push({
      unitId,
      index: unitId,
      timestamps: [...timestamps],
      occurrences: [[...timestamps]],
      text,
      repeatKey,
      repeatCount: 1,
    });
  }
  return units;
}
