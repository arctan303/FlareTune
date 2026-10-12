import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRoamLanguageScope } from './roamLanguages.js';
import { setUiLanguage } from '../i18n/index.js';

test('roam scope reports single and combined language filters without calling them the whole library', () => {
    setUiLanguage('zh');
    assert.equal(formatRoamLanguageScope('all'), '全曲库');
    assert.equal(formatRoamLanguageScope('ko'), '韩语');
    assert.equal(formatRoamLanguageScope('other'), '其他语言');
    assert.match(formatRoamLanguageScope('ko,instrumental'), /韩语.*纯音乐/);
    assert.equal(formatRoamLanguageScope('yue'), '粤语');
    setUiLanguage('en');
    assert.match(formatRoamLanguageScope('en,ko'), /English.*Korean/);
    assert.equal(formatRoamLanguageScope('en'), 'English');
});
