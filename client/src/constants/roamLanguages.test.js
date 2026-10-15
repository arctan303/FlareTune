import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatRoamLanguageScope,
    localizeLibraryPlaylist,
    getMatchingRoamLanguageKey,
    getRoamShortcutLabel,
    getRoamShortcutToast,
} from './roamLanguages.js';
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

test('cached system playlist labels change with language while personal content stays untouched', async () => {
    const playlist = {id:'lang-en', type:'library', langKey:'en', name:'英语歌曲', pagination:{total:23,sort:'desc'}};
    const personal = {id:'member-1', source:'member', name:'我的 English 名称'};
    const info = {description:'用户原文'};
    try {
        await setUiLanguage('en');
        const english = localizeLibraryPlaylist(playlist, info);
        assert.match(english.playlist.name, /English/);
        assert.match(english.info.description, /23/);
        await setUiLanguage('ko');
        const korean = localizeLibraryPlaylist(playlist, info);
        assert.notEqual(korean.playlist.name, english.playlist.name);
        assert.doesNotMatch(korean.info.description, /[\u3400-\u9fff]/);
        assert.equal(localizeLibraryPlaylist(personal, info).playlist, personal);
        assert.equal(localizeLibraryPlaylist(personal, info).info, info);
        assert.equal(playlist.name, '英语歌曲');
    } finally { await setUiLanguage('zh'); }
});

test('matching roam language resolves native categories and hides unsupported locales', async () => {
    assert.equal(getMatchingRoamLanguageKey('zh'), 'zh');
    assert.equal(getMatchingRoamLanguageKey('zh-CN'), 'zh');
    assert.equal(getMatchingRoamLanguageKey('zh-Hant'), 'zh');
    assert.equal(getMatchingRoamLanguageKey('en'), 'en');
    assert.equal(getMatchingRoamLanguageKey('en-US'), 'en');
    assert.equal(getMatchingRoamLanguageKey('ja'), 'ja');
    assert.equal(getMatchingRoamLanguageKey('ko'), 'ko');
    assert.equal(getMatchingRoamLanguageKey('fr'), null);
    assert.equal(getMatchingRoamLanguageKey('de'), null);
    assert.equal(getMatchingRoamLanguageKey('es'), null);
    assert.equal(getMatchingRoamLanguageKey('pt-BR'), null);
    assert.equal(getMatchingRoamLanguageKey(null), null);

    try {
        await setUiLanguage('zh');
        assert.equal(getRoamShortcutLabel('zh'), '仅中文');
        assert.equal(getRoamShortcutToast('zh'), '已切换为仅中文漫游');

        await setUiLanguage('en');
        assert.equal(getRoamShortcutLabel('en'), 'English only');
        assert.equal(getRoamShortcutToast('en'), 'Roam language set to English');
    } finally {
        await setUiLanguage('zh');
    }
});
