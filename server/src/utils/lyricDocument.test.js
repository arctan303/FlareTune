import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLyricDocument,
  isLeadingProviderMetadata,
  isSingableLineText,
  parseLrcDocument,
  projectCanonicalLrc,
  validateLyricDocument,
} from './lyricDocument.js';

test('singable-line classification excludes credits and punctuation but keeps real multilingual lyrics', () => {
  assert.equal(isSingableLineText('作词：某人'), false);
  assert.equal(isSingableLineText('♪ —— ···'), false);
  assert.equal(isSingableLineText('僕らは今'), true);
  assert.equal(isSingableLineText('Ah 1, 2, 3'), true);
});

test('timed credits, title metadata, separators, and punctuation do not downgrade an otherwise complete word timeline', () => {
  const document = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    providerMeta: { matchedTitle: 'Lemon', matchedArtist: '米津玄師' },
    lines: [
      { time: 0, text: 'Lemon' },
      { time: 0, text: '作词：米津玄師' },
      { time: 0.5, text: '-----' },
      { time: 0.8, text: '♪' },
      {
        time: 1,
        endTime: 2,
        text: '夢ならば',
        words: [
          { text: '夢なら', startTime: 1, endTime: 1.6 },
          { text: 'ば', startTime: 1.6, endTime: 2 },
        ],
      },
    ],
  });
  assert.equal(document.syncMode, 'word');
  assert.equal(document.lines.length, 5);
});

test('a meaningful lyric line without words still downgrades the whole song to line', () => {
  const document = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    lines: [
      { time: 0, text: '---' },
      { time: 1, endTime: 2, text: 'A', words: [{ text: 'A', startTime: 1, endTime: 2 }] },
      { time: 3, endTime: 4, text: 'real lyric without timing' },
    ],
  });
  assert.equal(document.syncMode, 'line');
});

test('a final word up to 2ms past declared line duration is accepted and expands canonical line end', () => {
  const document = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    lines: [{
      time: 1,
      endTime: 2.527,
      text: 'AB',
      words: [
        { text: 'A', startTime: 1, endTime: 2 },
        { text: 'B', startTime: 2, endTime: 2.528 },
      ],
    }],
  });
  assert.equal(document.syncMode, 'word');
  assert.equal(document.lines[0].endTime, 2.528);
  assert.equal(document.lines[0].words.length, 2);
});

test('floating-point equal line boundaries do not drop words, while a real overrun still downgrades', () => {
  const floatingEqual = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    lines: [{
      time: 0,
      endTime: 0.3,
      text: 'A',
      words: [{ text: 'A', startTime: 0, endTime: 0.1 + 0.2 }],
    }],
  });
  assert.equal(floatingEqual.syncMode, 'word');
  assert.equal(floatingEqual.lines[0].endTime, 0.1 + 0.2);

  const realOverrun = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    lines: [{
      time: 1,
      endTime: 2,
      text: 'A',
      words: [{ text: 'A', startTime: 1, endTime: 2.003 }],
    }],
  });
  assert.equal(realOverrun.syncMode, 'line');
  assert.equal(realOverrun.lines[0].words, undefined);
  assert.equal(realOverrun.lines[0].endTime, 2);
});

test('canonical document preserves source segmentation and projects millisecond LRC timestamps', () => {
  const document = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    providerMeta: {
      providerLyricId: 42,
      matchedTitle: '夜航',
      matchedArtist: '歌手甲',
      matchedDuration: 199.75,
      durationDelta: 0.25,
      accesskey: 'must-not-leak',
    },
    lines: [{
      time: 1.234,
      endTime: 2.5,
      text: 'Hello world',
      words: [
        { text: 'Hello ', startTime: 1.234, endTime: 1.8 },
        { text: 'world', startTime: 1.8, endTime: 2.5 },
      ],
    }],
  });
  assert.equal(document.version, 2);
  assert.equal(document.syncMode, 'word');
  assert.equal(document.lrc, '[00:01.234]Hello world');
  assert.deepEqual(document.lines[0].words.map((word) => word.text), ['Hello ', 'world']);
  assert.deepEqual(document.providerMeta, {
    providerLyricId: '42', matchedTitle: '夜航', matchedArtist: '歌手甲',
    matchedDuration: 199.75, durationDelta: 0.25,
  });
  assert.equal(JSON.stringify(document).includes('must-not-leak'), false);
});

test('one malformed or uncovered word line downgrades the whole document to line without synthesizing timing', () => {
  const document = createLyricDocument({
    source: 'lrclib',
    format: 'lyricsfile',
    lines: [
      {
        time: 1,
        endTime: 2,
        text: 'fully timed',
        words: [{ text: 'fully timed', startTime: 1, endTime: 2 }],
      },
      {
        time: 3,
        endTime: 4,
        text: 'not covered',
        words: [{ text: 'not', startTime: 3, endTime: 3.5 }],
      },
    ],
  });
  assert.equal(document.syncMode, 'line');
  assert.ok(document.lines[0].words);
  assert.equal(document.lines[1].words, undefined);
});

test('word timestamps outside the line, backwards starts, missing ends, and mixed untimed lines are not word sync', () => {
  const cases = [
    [{ time: 1, endTime: 2, text: 'A', words: [{ text: 'A', startTime: 0.9, endTime: 1.5 }] }],
    [{ time: 1, endTime: 2, text: 'AB', words: [
      { text: 'A', startTime: 1.5, endTime: 1.7 }, { text: 'B', startTime: 1.4, endTime: 1.8 },
    ] }],
    [{ time: 1, endTime: 3, text: 'AB', words: [
      { text: 'A', startTime: 1, endTime: 2.5 }, { text: 'B', startTime: 2, endTime: 2.4 },
    ] }],
    [{ time: 1, text: 'A', words: [{ text: 'A', startTime: 1, endTime: Number.NaN }] }],
    [
      { time: 1, endTime: 2, text: 'A', words: [{ text: 'A', startTime: 1, endTime: 2 }] },
      { text: 'untimed' },
    ],
  ];
  for (const lines of cases) {
    const document = createLyricDocument({ source: 'kugou', format: 'krc', lines });
    assert.notEqual(document.syncMode, 'word');
  }
});

test('canonical lines are ordered while equal-time bilingual LRC becomes one original line plus static translation', () => {
  const document = parseLrcDocument([
    '[00:03.000]次の行',
    '[00:01.000]僕らは今靴を脱ぐ',
    '[00:01.000]现在 我们脱下鞋子',
  ].join('\n'), { source: 'kugou' });
  assert.equal(document.lines.length, 2);
  assert.equal(document.lines[0].time, 1);
  assert.equal(document.lines[0].text, '僕らは今靴を脱ぐ');
  assert.equal(document.lines[0].tlyric, '现在 我们脱下鞋子');
  assert.equal(document.lines[0].words, undefined);
  assert.equal(document.lrc, '[00:01.000]僕らは今靴を脱ぐ\n[00:03.000]次の行');
});

test('provider order keeps Chinese original canonical when followed by pinyin or English', () => {
  for (const translation of ['yue liang dai biao wo de xin', 'The moon represents my heart']) {
    const document = parseLrcDocument([
      '[00:01.000]月亮代表我的心',
      `[00:01.000]${translation}`,
      '[00:03.000]下一句',
    ].join('\n'), { source: 'kugou' });
    assert.equal(document.lines[0].text, '月亮代表我的心');
    assert.equal(document.lines[0].tlyric, translation);
    assert.equal(document.lrc, '[00:01.000]月亮代表我的心\n[00:03.000]下一句');
    assert.equal(document.tlyric, undefined);
  }
});

test('provider order keeps English original canonical when followed by Chinese translation', () => {
  const document = parseLrcDocument([
    '[00:01.000]Here comes the sun',
    '[00:01.000]太阳升起来了',
  ].join('\n'), { source: 'lrclib' });
  assert.equal(document.lines[0].text, 'Here comes the sun');
  assert.equal(document.lines[0].tlyric, '太阳升起来了');
  assert.equal(document.lrc, '[00:01.000]Here comes the sun');
  assert.equal(document.tlyric, undefined);
});

test('same-script equal-time variants remain canonical text and do not become static translation', () => {
  const document = parseLrcDocument('[00:01.00]第一版本\n[00:01.00]第二版本', { source: 'kugou' });
  assert.equal(document.lines.length, 1);
  assert.equal(document.lines[0].text, '第一版本\n第二版本');
  assert.equal(document.lines[0].tlyric, undefined);
  assert.equal(document.lrc, '[00:01.000]第一版本\n第二版本');
});

test('three equal-time cross-script entries preserve the first canonical original and translation order', () => {
  const document = parseLrcDocument([
    '[00:01.000]月亮代表我的心',
    '[00:01.000]yue liang dai biao wo de xin',
    '[00:01.000]The moon represents my heart',
  ].join('\n'), { source: 'kugou' });
  assert.equal(document.lines.length, 1);
  assert.equal(document.lines[0].text, '月亮代表我的心');
  assert.equal(document.lines[0].tlyric, 'yue liang dai biao wo de xin\nThe moon represents my heart');
  assert.equal(document.lrc, '[00:01.000]月亮代表我的心');
  assert.equal(document.tlyric, undefined);
});

test('a third same-script variant remains canonical after a cross-script static translation', () => {
  const document = parseLrcDocument([
    '[00:01.000]月亮代表我的心',
    '[00:01.000]yue liang dai biao wo de xin',
    '[00:01.000]月亮代表我心',
  ].join('\n'), { source: 'kugou' });
  assert.equal(document.lines.length, 1);
  assert.equal(document.lines[0].text, '月亮代表我的心\n月亮代表我心');
  assert.equal(document.lines[0].tlyric, 'yue liang dai biao wo de xin');
  assert.equal(document.lrc, '[00:01.000]月亮代表我的心\n月亮代表我心');
});

test('plain text remains explicitly unsynchronized and canonical projection never invents timestamps', () => {
  const document = parseLrcDocument('first\nsecond', { source: 'lrclib', format: 'plain' });
  assert.equal(document.syncMode, 'none');
  assert.deepEqual(document.lines, [{ text: 'first' }, { text: 'second' }]);
  assert.equal(projectCanonicalLrc(document.lines), 'first\nsecond');
});

test('document validation rejects unsafe structural sizes and source/format values', () => {
  assert.equal(validateLyricDocument({ source: 'forged', format: 'lrc', lines: [] }).valid, false);
  assert.equal(validateLyricDocument({ source: 'kugou', format: 'binary', lines: [] }).valid, false);
  const lines = Array.from({ length: 2_001 }, (_, index) => ({ time: index, text: 'x' }));
  const result = validateLyricDocument({ source: 'kugou', format: 'lrc', lines });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /safe line count/);
});

test('leading provider metadata and singable line checks exempt opening title and artist lines', () => {
  const providerMeta = {
    matchedTitle: 'Lemon',
    matchedArtist: '米津玄師',
    matchedAlbum: 'STRAY SHEEP',
  };

  assert.equal(isSingableLineText('Lemon', providerMeta), false);
  assert.equal(isSingableLineText('米津玄師', providerMeta), false);
  assert.equal(isSingableLineText('Lemon - 米津玄師', providerMeta), false);
  assert.equal(isSingableLineText('夢ならば', providerMeta), true);

  assert.equal(isLeadingProviderMetadata({ text: 'Lemon', time: 0 }, 0, providerMeta), true);
  assert.equal(isLeadingProviderMetadata({ text: '米津玄師', time: 1.5, words: [{ text: '米津玄師', startTime: 1.5, endTime: 2.5 }] }, 1, providerMeta), true);
  assert.equal(isLeadingProviderMetadata({ text: 'Lemon - 米津玄師', time: 2.0 }, 2, providerMeta), true);
  assert.equal(isLeadingProviderMetadata({ text: 'STRAY SHEEP', time: 2.5 }, 3, providerMeta), true);
  assert.equal(isLeadingProviderMetadata({ text: '作词/作曲：米津玄師', time: 3.0 }, 4, providerMeta), true);
  assert.equal(isLeadingProviderMetadata({ text: '夢ならば', time: 10.0 }, 5, providerMeta), false);

  assert.equal(isLeadingProviderMetadata({ text: 'Lemon', time: 45.0 }, 1, providerMeta), false);
  assert.equal(isLeadingProviderMetadata({ text: 'Lemon', time: 1.0 }, 10, providerMeta), false);
});

test('timed title and artist lines with words do not downgrade syncMode', () => {
  const document = createLyricDocument({
    source: 'kugou',
    format: 'krc',
    providerMeta: { matchedTitle: 'Lemon', matchedArtist: '米津玄師' },
    lines: [
      { time: 0, text: 'Lemon', words: [{ text: 'Lemon', startTime: 0, endTime: 1 }] },
      { time: 1.5, text: '米津玄師', words: [{ text: '米津玄師', startTime: 1.5, endTime: 2.5 }] },
      { time: 2.5, text: '作词/作曲：米津玄師' },
      {
        time: 5,
        endTime: 7,
        text: '夢ならば',
        words: [
          { text: '夢なら', startTime: 5, endTime: 6 },
          { text: 'ば', startTime: 6, endTime: 7 },
        ],
      },
    ],
  });
  assert.equal(document.syncMode, 'word');
  assert.equal(document.lines.length, 4);
});
