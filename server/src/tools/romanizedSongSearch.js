import { isRomanizedSearchQuery, romanizeJapaneseKana } from '../utils/japaneseRomanization.js';

const PAGE_SIZE = 200;

export async function queryRomanizedSongs(db, rawQuery, limit, offset = 0, {
  languageFilter = { sql: '', bindings: [] }, excludeIds = [],
} = {}) {
  if (!isRomanizedSearchQuery(rawQuery)) return [];
  const query = romanizeJapaneseKana(rawQuery);
  if (!query) return [];
  const excluded = new Set(excludeIds);
  const matches = [];
  let scanned = 0;
  while (matches.length < offset + limit) {
    const { results = [] } = await db.prepare(`
      SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
      FROM Songs s
      WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
        ${languageFilter.sql ? `AND ${languageFilter.sql}` : ''}
        AND (s.title GLOB '*[ぁ-ゖァ-ヺ]*' OR s.artist GLOB '*[ぁ-ゖァ-ヺ]*'
          OR s.album GLOB '*[ぁ-ゖァ-ヺ]*')
      ORDER BY LOWER(s.title) ASC, LOWER(s.artist) ASC, s.id ASC
      LIMIT ? OFFSET ?
    `).bind(...languageFilter.bindings, PAGE_SIZE, scanned).all();
    for (const song of results) {
      if (excluded.has(song.id)) continue;
      if ([song.title, song.artist, song.album].some((field) => romanizeJapaneseKana(field).includes(query))) {
        matches.push(song);
      }
    }
    scanned += results.length;
    if (results.length < PAGE_SIZE) break;
  }
  return matches.slice(offset, offset + limit);
}
