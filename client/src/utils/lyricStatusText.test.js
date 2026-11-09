import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import english from '../i18n/en.js';
import { LYRIC_STATUS_TEXTS, localizeLyricStatusText } from './lyricStatusText.js';

test('loader status rows follow the interface language while real lyric rows stay original', () => {
    const translate = (text) => `ui:${text}`;
    for (const status of LYRIC_STATUS_TEXTS) {
        assert.equal(localizeLyricStatusText(status, translate), `ui:${status}`);
    }
    for (const lyric of ['暂无歌词的那一天', 'はい喜んで', '纯音乐', '', undefined, null]) {
        assert.equal(localizeLyricStatusText(lyric, translate), lyric);
    }
});

test('every lyric status row has an English and locale translation', async () => {
    for (const status of LYRIC_STATUS_TEXTS) assert.ok(english[status], `en: ${status}`);
    for (const locale of ['zh-Hant', 'ja', 'ko']) {
        const catalog = JSON.parse(await readFile(new URL(`../i18n/locales/${locale}.json`, import.meta.url), 'utf8'));
        for (const status of LYRIC_STATUS_TEXTS) assert.ok(catalog[status], `${locale}: ${status}`);
    }
});
