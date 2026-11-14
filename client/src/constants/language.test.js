import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_LANGUAGE_CODES, isValidSongLanguage, songLanguageHasLyrics, songLanguageNeedsTranslation } from './language.js';

test('an unknown or unsupported song language is not evidence of instrumental audio', () => {
  for (const language of [null, undefined, '', 'unknown', 'foreign']) {
    assert.equal(isValidSongLanguage(language), false);
    assert.equal(songLanguageHasLyrics(language), true);
    assert.equal(songLanguageNeedsTranslation(language), false, 'unknown language must not opt into automatic translation');
  }
});

test('only explicit instrumental metadata disables lyric loading and known translation behavior is preserved', () => {
  for (const language of ALL_LANGUAGE_CODES) {
    assert.equal(songLanguageHasLyrics(language), language !== 'instrumental');
    assert.equal(songLanguageNeedsTranslation(language), !['zh', 'instrumental'].includes(language));
  }
});
