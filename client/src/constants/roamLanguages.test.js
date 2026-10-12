import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRoamLanguageScope, localizeLibraryPlaylist } from './roamLanguages.js';
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
        await setUiLanguage('fr');
        const french = localizeLibraryPlaylist(playlist, info);
        assert.notEqual(french.playlist.name, english.playlist.name);
        assert.doesNotMatch(french.info.description, /[\u3400-\u9fff]/);
        assert.equal(localizeLibraryPlaylist(personal, info).playlist, personal);
        assert.equal(localizeLibraryPlaylist(personal, info).info, info);
        assert.equal(playlist.name, '英语歌曲');
    } finally { await setUiLanguage('zh'); }
});
