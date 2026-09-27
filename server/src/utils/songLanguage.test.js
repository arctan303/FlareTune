import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SONG_LANGUAGES,
  EXTENDED_SONG_LANGUAGES,
  buildSongLanguageFilter,
  isValidSongLanguage,
  resolveSongTranslationNeed,
  songHasLyrics,
  songNeedsTranslation,
} from './songLanguage.js';
import { analyzeLrcLanguage } from './lyricsParsing.js';

test('song language rules cover every supported code without legacy fallbacks', () => {
  assert.ok(SONG_LANGUAGES.every(isValidSongLanguage));
  assert.equal(isValidSongLanguage('foreign'), false);
  assert.equal(songHasLyrics('instrumental'), false);
  assert.equal(songNeedsTranslation('instrumental'), false);
  assert.equal(songHasLyrics('zh'), true);
  assert.equal(songNeedsTranslation('zh'), false);
  for (const language of SONG_LANGUAGES.filter((code) => !['zh', 'instrumental'].includes(code))) {
    assert.equal(songHasLyrics(language), true);
    assert.equal(songNeedsTranslation(language), true);
  }
  assert.equal(songHasLyrics(null), false);
  assert.equal(songNeedsTranslation('foreign'), false);
});

test('clear lyric scripts override metadata while ambiguous mixtures use song language', () => {
  const chineseContent = analyzeLrcLanguage('[00:01.00]我们一起看月亮');
  const englishContent = analyzeLrcLanguage('[00:01.00]We sing beneath the moon');
  const cyrillicContent = analyzeLrcLanguage('[00:01.00]Под луной мы вдвоём');
  const sparseKanaJapanese = analyzeLrcLanguage('[00:01.00]東京夜空世界君夢の');
  const hanOnlyJapanese = analyzeLrcLanguage('[00:01.00]東京夜空世界君夢');
  const mixedContent = analyzeLrcLanguage('[00:01.00]今夜一起Sing with me');
  const emptyContent = {
    detectedLang: 'empty', needsTranslation: false, effectiveCharacterCount: 0,
  };

  assert.equal(resolveSongTranslationNeed('en', chineseContent), false);
  assert.equal(resolveSongTranslationNeed('ja', chineseContent), true);
  assert.equal(resolveSongTranslationNeed('zh', englishContent), true);
  assert.equal(resolveSongTranslationNeed('zh', cyrillicContent), true);
  assert.equal(resolveSongTranslationNeed('ja', sparseKanaJapanese), true);
  assert.equal(resolveSongTranslationNeed('zh', sparseKanaJapanese), false);
  assert.equal(resolveSongTranslationNeed('ja', hanOnlyJapanese), true);
  assert.equal(resolveSongTranslationNeed('zh', hanOnlyJapanese), false);
  assert.equal(resolveSongTranslationNeed('en', mixedContent), true);
  assert.equal(resolveSongTranslationNeed('zh', mixedContent), false);
  assert.equal(resolveSongTranslationNeed('instrumental', cyrillicContent), false);
  assert.equal(resolveSongTranslationNeed('ja', emptyContent), true);
  assert.equal(resolveSongTranslationNeed('zh', emptyContent), false);
});

test('other filter groups supported non-primary languages before pagination', () => {
  const exact = buildSongLanguageFilter('ja');
  assert.deepEqual(exact, { sql: 's.language = ?', bindings: ['ja'] });
  const other = buildSongLanguageFilter('other', 'song.language');
  assert.match(other.sql, /^song\.language IN/);
  assert.deepEqual(other.bindings, EXTENDED_SONG_LANGUAGES);
  assert.equal(buildSongLanguageFilter('foreign'), null);
});

test('multi-language filter supports comma-separated list and arrays with expansion', () => {
  const multi = buildSongLanguageFilter('zh,en');
  assert.deepEqual(multi, { sql: 's.language IN (?, ?)', bindings: ['zh', 'en'] });

  const multiArray = buildSongLanguageFilter(['ja', 'ko']);
  assert.deepEqual(multiArray, { sql: 's.language IN (?, ?)', bindings: ['ja', 'ko'] });

  const multiWithOther = buildSongLanguageFilter('zh,other');
  assert.match(multiWithOther.sql, /^s\.language IN/);
  assert.equal(multiWithOther.bindings.includes('zh'), true);
  assert.equal(multiWithOther.bindings.includes('fr'), true);

  assert.equal(buildSongLanguageFilter('zh,invalid_code'), null);
});
