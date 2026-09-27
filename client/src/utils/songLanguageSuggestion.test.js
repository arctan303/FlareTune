import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestSongLanguage } from './songLanguageSuggestion.js';

test('explicit audio language wins over script and supports common tag forms', () => {
  assert.deepEqual(suggestSongLanguage({ language: 'jpn', title: '東京' }),
    { code: 'ja', source: 'tag', reason: '音频语言标签' });
  assert.equal(suggestSongLanguage({ language: 'en-US', title: '你好' }).code, 'en');
  assert.equal(suggestSongLanguage({ language: 'yue' }).code, 'yue');
});

test('visible text supplies editable guesses when no language tag exists', () => {
  assert.equal(suggestSongLanguage({ title: 'さくら' }).code, 'ja');
  assert.equal(suggestSongLanguage({ artist: '高胜美', title: '美酒加咖啡' }).code, 'zh');
  assert.equal(suggestSongLanguage({ title: '봄날' }).code, 'ko');
  assert.equal(suggestSongLanguage({ title: 'Yesterday' }).code, 'en');
  assert.equal(suggestSongLanguage({ title: 'Instrumental Version' }).code, 'instrumental');
  assert.equal(suggestSongLanguage({ title: 'Yesterday' }).source, 'text');
});

test('ambiguous or absent metadata remains unset', () => {
  assert.equal(suggestSongLanguage({ language: 'en;ja', title: 'Yesterday' }).code, '');
  assert.equal(suggestSongLanguage({ language: 'pol', title: 'Yesterday' }).code, '');
  assert.equal(suggestSongLanguage({ title: '1234' }).code, '');
  assert.equal(suggestSongLanguage().code, '');
});
