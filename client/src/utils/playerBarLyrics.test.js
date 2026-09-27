import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlayerBarLyricLayout } from './playerBarLyrics.js';

const bilingualLyrics = [
    { text: 'First', translation: '第一句' },
    { text: 'Second', translation: '第二句' },
];

test('player bar scrolls independent original/translation rows as one 36px unit', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        translationEnabled: true,
        lyrics: bilingualLyrics,
        currentLyricIndex: 1,
    }), {
        isBilingual: true,
        rowHeight: 36,
        translateY: 36,
    });
});

test('player bar detects inline newline translation for 36px layout', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        translationEnabled: true,
        lyrics: [{ text: 'First\n第一句' }, { text: 'Second\n第二句' }],
        currentLyricIndex: 1,
    }), {
        isBilingual: true,
        rowHeight: 36,
        translateY: 36,
    });
});

test('player bar disables bilingual layout when translationEnabled is false', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        translationEnabled: false,
        lyrics: bilingualLyrics,
        currentLyricIndex: 1,
    }), {
        isBilingual: false,
        rowHeight: 18,
        translateY: 18,
    });
});

test('untranslated lyrics retain 18px rows', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        translationEnabled: true,
        lyrics: [{ text: 'Only original' }],
        currentLyricIndex: 2,
    }), {
        isBilingual: false,
        rowHeight: 18,
        translateY: 36,
    });
});

test('any usable translation enables the bilingual capsule layout', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        translationEnabled: true,
        lyrics: [
            { text: 'Translated', translation: '已翻译' },
            { text: 'Original only' },
        ],
        currentLyricIndex: 1,
    }), {
        isBilingual: true,
        rowHeight: 36,
        translateY: 36,
    });
});

test('capsule keeps the original two-line queue preview when the song has no translation switch', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        canTranslate: false,
        translationEnabled: true,
        lyrics: bilingualLyrics,
        currentLyricIndex: 1,
    }), {
        isBilingual: false,
        rowHeight: 18,
        translateY: 18,
    });
});

test('same-language newline lyrics stay on one row instead of treating the second original line as translation', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        translationEnabled: true,
        lyrics: [{ text: 'First\nSecond' }, { text: 'Third\nFourth' }],
        currentLyricIndex: 1,
    }), {
        isBilingual: false,
        rowHeight: 18,
        translateY: 18,
    });
});

test('intro metadata does not disable a complete bilingual lyric layout', () => {
    assert.deepEqual(getPlayerBarLyricLayout({
        translationEnabled: true,
        lyrics: [
            { text: 'Artist — Title', isIntro: true },
            { text: 'First', translation: '第一句' },
            { text: 'Second', translation: '第二句' },
        ],
        currentLyricIndex: 2,
    }), {
        isBilingual: true,
        rowHeight: 36,
        translateY: 72,
    });
});
