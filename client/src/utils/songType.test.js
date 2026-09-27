import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSongLanguage } from './songType.js';

test('resolveSongLanguage accepts only the explicit supported language', () => {
  assert.equal(resolveSongLanguage({ language: 'ja' }), 'ja');
  assert.equal(resolveSongLanguage({ language: 'instrumental' }), 'instrumental');
  assert.equal(resolveSongLanguage({ language: 'ru' }), 'ru');
  assert.equal(resolveSongLanguage({ has_lyrics: 0, needs_translation: 0 }), null);
  assert.equal(resolveSongLanguage({ language: 'foreign' }), null);
  assert.equal(resolveSongLanguage({ language: 'zh' }, { song: 'foreign' }), 'zh');
});
