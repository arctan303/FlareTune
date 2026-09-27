import { buildSongLanguageFilter } from '../utils/songLanguage.js';
import { queryRomanizedSongs } from './romanizedSongSearch.js';
import { isRomanizedSearchQuery } from '../utils/japaneseRomanization.js';

const escapeLikePattern = (value) => value.replace(/[\\%_]/g, '\\$&');

const normalizeSearchQuery = (value) => (
  String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '')
);

const compactSqlField = (field) => (
  `REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${field}), ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), '')`
);

const MAX_SEARCH_OFFSET = 2000;

export async function querySongs(db, rawQuery, limit, offset = 0, { language = null } = {}) {
  const q0 = String(rawQuery || '').trim();
  if (!q0) return [];
  const lim = Math.min(Math.max(limit === undefined ? 8 : Number(limit), 1), 50);
  const off = Math.min(Math.max(Number(offset) || 0, 0), MAX_SEARCH_OFFSET);
  const languageFilter = buildSongLanguageFilter(language);
  if (languageFilter === null) throw new TypeError('invalid_language');

  const queryCandidates = [q0];

  // 清洗后缀：如 (Mr. Collipark Remix), （feat. xxx）, - Remix 等
  const cleanedQuery = q0.replace(/\(.*?\)|（.*?）|\[.*?\]|-.*$/g, '').trim();
  if (cleanedQuery && cleanedQuery !== q0 && cleanedQuery.length >= 2) {
    queryCandidates.push(cleanedQuery);
  }

  // 主歌词分词备选：如果空格较多，拆出最长词
  const words = q0.split(/\s+/).filter(w => w.length >= 3);
  if (words.length > 1) {
    const longestWord = words.reduce((max, w) => w.length > max.length ? w : max, '');
    if (longestWord && !queryCandidates.includes(longestWord)) {
      queryCandidates.push(longestWord);
    }
  }

  const searchWhereSql = (languageSql) => `
      s.audio_url IS NOT NULL
        AND TRIM(s.audio_url) <> ''
        ${languageSql ? `AND ${languageSql}` : ''}
        AND (
          LOWER(s.title) LIKE ? ESCAPE '\\'
          OR LOWER(s.artist) LIKE ? ESCAPE '\\'
          OR LOWER(s.album) LIKE ? ESCAPE '\\'
          OR ${compactSqlField('s.title')} LIKE ? ESCAPE '\\'
          OR ${compactSqlField('s.artist')} LIKE ? ESCAPE '\\'
          OR ${compactSqlField('s.album')} LIKE ? ESCAPE '\\'
        )`;

  let selectedPatterns = null;
  for (const qStr of queryCandidates) {
    const q = `%${escapeLikePattern(qStr.toLowerCase())}%`;
    const compactQuery = normalizeSearchQuery(qStr);
    const compactPattern = `%${escapeLikePattern(compactQuery)}%`;
    if (!compactQuery) continue;
    const patterns = [q, q, q, compactPattern, compactPattern, compactPattern];
    const existence = await db.prepare(`
      SELECT 1 AS found
      FROM Songs s
      WHERE ${searchWhereSql(languageFilter.sql)}
      LIMIT 1
    `).bind(...languageFilter.bindings, ...patterns).all();
    if ((existence.results || []).length > 0) {
      selectedPatterns = patterns;
      break;
    }
  }

  if (!selectedPatterns) {
    for (const candidate of queryCandidates) {
      const existence = await queryRomanizedSongs(db, candidate, 1, 0, { languageFilter });
      if (existence.length === 0) continue;
      const romanized = await queryRomanizedSongs(db, candidate, lim, off, { languageFilter });
      return romanized;
    }
    return [];
  }
  const rows = await db.prepare(`
      SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
      FROM Songs s
      WHERE ${searchWhereSql(languageFilter.sql)}
      ORDER BY LOWER(s.title) ASC, LOWER(s.artist) ASC, s.id ASC
      LIMIT ? OFFSET ?
    `).bind(...languageFilter.bindings, ...selectedPatterns, lim, off).all();
  const direct = rows.results || [];
  if (direct.length === lim || !isRomanizedSearchQuery(q0)) return direct;
  const countRows = await db.prepare(`
    SELECT COUNT(*) AS total FROM Songs s WHERE ${searchWhereSql(languageFilter.sql)}
  `).bind(...languageFilter.bindings, ...selectedPatterns).all();
  const directCount = Number(countRows.results?.[0]?.total) || 0;
  const directIds = await db.prepare(`
    SELECT s.id FROM Songs s WHERE ${searchWhereSql(languageFilter.sql)}
  `).bind(...languageFilter.bindings, ...selectedPatterns).all();
  const romanized = await queryRomanizedSongs(db, q0, lim - direct.length,
    Math.max(0, off - directCount), {
      languageFilter, excludeIds: (directIds.results || []).map((song) => song.id),
    });
  return [...direct, ...romanized];
}
