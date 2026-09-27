import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeLrcLanguage,
  buildTranslationBatches,
  buildTranslationPrompt,
  computeHash,
  getTranslationPromptVersion,
  isNonLyricText,
  normalizeLrcForHash,
  computeLyricsBodyHash,
  parseLrcLines,
  parseTranslationResponse,
  reconstructTranslatedLrc,
  retimeCachedTranslation,
} from './lyricsTranslation.js';

test('language analysis applies the 50% threshold to effective lyric characters', () => {
  const exactThreshold = analyzeLrcLanguage('[00:01.00]中文AB');
  assert.equal(exactThreshold.chineseRatio, 0.5);
  assert.equal(exactThreshold.needsTranslation, false);
  assert.equal(exactThreshold.detectedLang, 'zh');

  const belowThreshold = analyzeLrcLanguage('[00:01.00]中ABC');
  assert.equal(belowThreshold.chineseRatio, 0.25);
  assert.equal(belowThreshold.needsTranslation, true);
  assert.equal(belowThreshold.detectedLang, 'latin');
});

test('language analysis ignores timestamps, metadata, credits, punctuation, and whitespace', () => {
  const result = analyzeLrcLanguage([
    '[ar:English Artist]',
    '[ti:English Song]',
    '[00:01.00]作词：English Name',
    '[00:01.50]Produced by Someone',
    '[00:02.00]你，好！',
    '[00:03.00]A...',
  ].join('\n'));

  assert.equal(result.effectiveCharacterCount, 3);
  assert.equal(result.chineseRatio, 2 / 3);
  assert.equal(result.needsTranslation, false);
});

test('kana and Hangul remain decisive even when Han characters are numerous', () => {
  const japanese = analyzeLrcLanguage('[00:01.00]東京夜空世界君の夢');
  assert.equal(japanese.detectedLang, 'ja');
  assert.equal(japanese.needsTranslation, true);

  const korean = analyzeLrcLanguage('[00:01.00]漢字漢字사랑');
  assert.equal(korean.detectedLang, 'ko');
  assert.equal(korean.needsTranslation, true);
});

test('empty and non-lyric input does not expose translation', () => {
  for (const value of ['', '[ar:Artist]\n[00:01.00]...', '[00:01.00]作曲：Someone']) {
    const result = analyzeLrcLanguage(value);
    assert.equal(result.detectedLang, 'empty');
    assert.equal(result.needsTranslation, false);
  }
});

test('multilingual song metadata and production credits are classified as non-lyrics', () => {
  for (const value of [
    '作词：某某',
    '編曲: Someone',
    'Produced by Someone',
    'Lyrics by Someone',
    'マスタリング：Someone',
    '작곡: Someone',
  ]) {
    assert.equal(isNonLyricText(value), true, value);
  }
  assert.equal(isNonLyricText('I wrote these words for you'), false);
});

test('parseLrcLines excludes metadata and folds only adjacent exact repeats', () => {
  const units = parseLrcLines([
    '[ar:Artist]',
    '[00:01.00]作词：Someone',
    '[00:02.00]Hello world',
    '[00:03.00]Hello   world',
    '[00:04.00]Different',
    '[00:05.00]Hello world',
    '[00:06.00]hello world',
    '[00:07.00][00:08.00]Last line',
  ].join('\n'));

  assert.equal(units.length, 5);
  assert.deepEqual(units[0], {
    unitId: 0,
    index: 0,
    timestamps: ['[00:02.00]', '[00:03.00]'],
    occurrences: [['[00:02.00]'], ['[00:03.00]']],
    text: 'Hello world',
    repeatKey: 'Hello world',
    repeatCount: 2,
  });
  assert.equal(units[2].text, 'Hello world');
  assert.equal(units[3].text, 'hello world');
  assert.deepEqual(units[4].timestamps, ['[00:07.00]', '[00:08.00]']);
});

test('parseLrcLines excludes leading title and artist song data without fixed line skipping', () => {
  const parsed = parseLrcLines([
    '[sign:]',
    '[qq:]',
    '[total:257541]',
    '[00:00.00]放課後ティータイム - NO, Thank You!',
    '[00:01.00]作词：大森祥子',
    '[00:02.00]作曲：前澤寛之',
    '[00:03.00]ホワイトボードで',
    '[00:04.00]NO, Thank You!',
  ].join('\n'), {
    songTitle: 'NO, Thank You!',
    artist: '放課後ティータイム',
  });

  assert.deepEqual(parsed.map(({ text }) => text), [
    'ホワイトボードで',
    'NO, Thank You!',
  ]);
});

test('normalized lyrics hash is stable across line endings and trailing whitespace', async () => {
  const first = '[00:01.00]Hello  \r\n[00:02.00]World\r\n';
  const second = '[00:01.00]Hello\n[00:02.00]World';
  assert.equal(normalizeLrcForHash(first), second);
  assert.equal(await computeHash(first), await computeHash(second));
  assert.notEqual(await computeHash(second), await computeHash(`${second}!`));
  assert.match(await computeHash(second), /^[a-f0-9]{64}$/);
});

test('quality prompt is versioned, separates context, and requests only lyric units', () => {
  const units = parseLrcLines('[00:01.00]Hello\n[00:02.00]World');
  const messages = buildTranslationPrompt(units, 'Song', 'Artist', {
    contextBefore: [{ unitId: 8, text: 'Before' }],
    contextAfter: [{ unitId: 9, text: 'After' }],
  });
  const payload = JSON.parse(messages[1].content);

  assert.equal(getTranslationPromptVersion(), 'lyrics-zh-cn-v5-contextual-polish');
  assert.match(messages[0].content, /信、达、雅/);
  assert.match(messages[0].content, /只翻译 units/);
  assert.match(messages[0].content, /\{"notNeeded":true\}/);
  assert.deepEqual(payload.context, {
    before: [{ unitId: 8, text: 'Before' }],
    after: [{ unitId: 9, text: 'After' }],
  });
  assert.deepEqual(payload.units, [
    { unitId: 0, text: 'Hello', repeatCount: 1 },
    { unitId: 1, text: 'World', repeatCount: 1 },
  ]);
});

test('long lyrics split into bounded batches with adjacent read-only context', () => {
  const units = parseLrcLines([
    '[00:01.00]One',
    '[00:02.00]Two',
    '[00:03.00]Three',
    '[00:04.00]Four',
    '[00:05.00]Five',
  ].join('\n'));
  const batches = buildTranslationBatches(units, 'Song', 'Artist', {
    maxUnits: 2,
    maxCharacters: 100,
    contextUnits: 1,
  });

  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map(({ units: batchUnits }) => batchUnits.map(({ unitId }) => unitId)), [
    [0, 1],
    [2, 3],
    [4],
  ]);
  const middlePayload = JSON.parse(batches[1].messages[1].content);
  assert.deepEqual(middlePayload.context.before, [{ unitId: 1, text: 'Two' }]);
  assert.deepEqual(middlePayload.context.after, [{ unitId: 4, text: 'Five' }]);
});

test('translation response validates exact unit coverage and Chinese target text', () => {
  const units = parseLrcLines('[00:01.00]Hello\n[00:02.00]World');
  assert.deepEqual(parseTranslationResponse({
    translations: [
      { unitId: 0, text: '你好' },
      { unitId: 1, text: '世界' },
    ],
  }, units), [
    { unitId: 0, text: '你好' },
    { unitId: 1, text: '世界' },
  ]);
});

test('translation response accepts only the exact not-needed sentinel', () => {
  const units = parseLrcLines('[00:01.00]中文歌词');
  assert.equal(parseTranslationResponse({ notNeeded: true }, units), null);
  assert.throws(() => parseTranslationResponse({ notNeeded: false }, units));
  assert.throws(() => parseTranslationResponse({ notNeeded: true, translations: [] }, units));
});

test('reconstructTranslatedLrc expands consecutive repeats to every timestamp', () => {
  const units = parseLrcLines([
    '[00:10.00]Hello',
    '[00:20.00]Hello',
    '[00:30.00][00:40.00]World',
    'Plain ending',
  ].join('\n'));
  const result = reconstructTranslatedLrc({
    translations: [
      { unitId: 0, text: '你好' },
      { unitId: 1, text: '世界' },
      { unitId: 2, text: '平静收尾' },
    ],
  }, units);

  assert.equal(result, [
    '[00:10.00]你好',
    '[00:20.00]你好',
    '[00:30.00]世界',
    '[00:40.00]世界',
    '平静收尾',
  ].join('\n'));
});

test('translation body hash ignores timing while preserving ordered repeated text', async () => {
  const first = parseLrcLines('[00:01.00]Hello\n[00:02.00]Hello\n[00:03.00]World');
  const shifted = parseLrcLines('[00:06.00]Hello\n[00:07.00]Hello\n[00:08.00]World');
  const changed = parseLrcLines('[00:06.00]Hello\n[00:07.00]Different\n[00:08.00]World');
  assert.equal(await computeLyricsBodyHash(first), await computeLyricsBodyHash(shifted));
  assert.notEqual(await computeLyricsBodyHash(first), await computeLyricsBodyHash(changed));
});

test('cached translation is projected onto the current source timeline after an offset change', () => {
  const shifted = parseLrcLines('[00:06.00]Hello\n[00:07.00]Hello\n[00:08.00]World');
  assert.equal(
    retimeCachedTranslation('[00:01.00]你好\n[00:02.00]你好\n[00:03.00]世界', shifted),
    '[00:06.00]你好\n[00:07.00]你好\n[00:08.00]世界',
  );
});

test('translation response rejects malformed, partial, duplicate, unsafe, and non-Chinese output', () => {
  const units = parseLrcLines('[00:10.00]Hello\n[00:20.00]World');
  const invalidPayloads = [
    'not-json',
    { translations: [{ unitId: 0, text: '你好' }] },
    { translations: [{ unitId: 0, text: '你好' }, { unitId: 0, text: '世界' }] },
    { translations: [{ unitId: 0, text: '' }, { unitId: 1, text: '世界' }] },
    { translations: [{ unitId: 0, text: '[00:10.00]你好' }, { unitId: 1, text: '世界' }] },
    { translations: [{ unitId: 0, text: '你好\n额外一行' }, { unitId: 1, text: '世界' }] },
    { translations: [{ unitId: 0, text: 'Hi' }, { unitId: 1, text: 'World' }] },
    { translations: [{ unitId: 0, text: '你好', note: 'extra' }, { unitId: 1, text: '世界' }] },
    { translations: [{ unitId: 0, text: '你好' }, { unitId: 1, text: '世界' }], explanation: 'extra' },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(() => parseTranslationResponse(payload, units));
  }
});
