import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLrcLanguage, isNonLyricText } from './lyricsParsing.js';

test('language analysis treats Cyrillic and other Unicode letters as translatable content', () => {
  const cyrillic = analyzeLrcLanguage('[00:01.00]Под луной мы вдвоём');
  assert.equal(cyrillic.detectedLang, 'other');
  assert.equal(cyrillic.needsTranslation, true);
  assert.ok(cyrillic.effectiveCharacterCount > 0);

  const thai = analyzeLrcLanguage('[00:01.00]คืนนี้เราอยู่ด้วยกัน');
  assert.equal(thai.detectedLang, 'other');
  assert.equal(thai.needsTranslation, true);
  assert.ok(thai.effectiveCharacterCount > 0);
});

test('language analysis keeps Chinese, Japanese, Korean and empty behavior stable', () => {
  assert.equal(analyzeLrcLanguage('[00:01.00]我们一起看月亮').detectedLang, 'zh');
  assert.equal(analyzeLrcLanguage('[00:01.00]僕らは今').detectedLang, 'ja');
  assert.equal(analyzeLrcLanguage('[00:01.00]우리는 지금').detectedLang, 'ko');
  assert.equal(analyzeLrcLanguage('[00:01.00]♪ ---').detectedLang, 'empty');
});

test('isNonLyricText identifies expanded credit labels, compound roles, and flexible delimiters', () => {
  const credits = [
    '词曲：米津玄师',
    '词曲 米津玄师',
    '作词/作曲：米津玄师',
    '词/曲: 米津玄师',
    '作词、作曲：米津玄师',
    '作词 & 作曲 米津玄师',
    '作词 米津玄师',
    '编配：张三',
    '编配 张三',
    '统筹：李四',
    '统筹 李四',
    '企划：王五',
    '监制：赵六',
    '总监制：钱七',
    '音乐总监：孙八',
    '出品：某某文化',
    '出品人：周九',
    '发行：某某唱片',
    '唱片公司：Sony Music',
    '录音：李四',
    '混音：王五',
    '母带：赵六',
    '吉他 / 贝斯：张三',
    '吉他 | 张三',
    '吉他 ~ 张三',
    '吉他 - 张三',
    '鼓：李四',
    '钢琴：王五',
    '键盘：赵六',
    '弦乐：孙七',
    '和声：周八',
    '和音：吴九',
    '原唱：周杰伦',
    '原唱 周杰伦',
    'OP: Sony Music Publishing',
    'SP: Universal Music Publishing',
    'ISRC: CNE041200001',
    'Vocal: 米津玄师',
    'Vocal 米津玄师',
    'Written by Kenshi Yonezu',
    'Produced by Max Martin',
    'Engineered by Bob Ludwig',
    'Published by Sony Music',
  ];
  for (const text of credits) {
    assert.equal(isNonLyricText(text), true, `Should identify "${text}" as non-lyric`);
  }

  const realLyrics = [
    '僕らは今靴を脱ぐ',
    'Ah 1, 2, 3',
    'Words cannot describe how much I miss you',
    'Music is my life',
    '词不达意的时候请抱紧我',
    '歌声在夜空中回荡',
  ];
  for (const text of realLyrics) {
    assert.equal(isNonLyricText(text), false, `Should NOT identify "${text}" as non-lyric`);
  }
});
