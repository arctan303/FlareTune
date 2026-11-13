import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAiCompleteLyrics, projectLyricArtifact, buildReadyLyricArtifact } from './lyricAssetWorkflow.js';
import { makeReadyArtifact, makeSong } from '../test/lyricAssetFixtures.js';
import { createLyricDocument } from '../utils/lyricDocument.js';

const chinese = makeSong({ language: 'zh' });
const original = { source: 'manual', format: 'lrc', syncMode: 'line', lines: [
  { time: 3, text: '把心事写在日记里' },
  { time: 6, text: '今天的心情有点 blue' },
  { time: 9, text: '手机屏幕上的 QQ' },
  { time: 12, text: '窗外的风轻轻吹过' },
] };

test('Chinese dominant tags do not translate individual foreign words or inserted sentences', () => {
  for (const targetLanguage of ['zh', 'zh-Hant']) {
    assert.equal(shouldAiCompleteLyrics(original, chinese, { targetLanguage }), false);
    for (const aiCompletion of [null,
      { status: 'failed', errorCode: 'completion_failed', updatedAt: new Date().toISOString() },
      { status: 'pending', updatedAt: new Date().toISOString() }]) {
      const artifact = makeReadyArtifact({ original, aiCompletion });
      const result = projectLyricArtifact(artifact, { song: chinese, targetLanguage });
      assert.equal(result.translationState, 'unavailable');
      assert.equal(result.translationAvailable, false);
      assert.deepEqual(result.lines, original.lines);
    }
  }
  for (const text of ['I will be waiting for you', '我轻轻说 I love you', 'Yesterday']) {
    assert.equal(shouldAiCompleteLyrics({ ...original, lines: [...original.lines, { time: 30, text }] }, chinese), false);
  }
  assert.equal(shouldAiCompleteLyrics(original, chinese, { targetLanguage: 'en' }), true);
  assert.equal(shouldAiCompleteLyrics(original, { ...chinese, language: 'other' }), true);
});

test('a Chinese paraphrase is not a translation, and reading it never deletes the saved layer', () => {
  const artifact = makeReadyArtifact({ original, translation: { source: 'ai', language: 'zh',
    originalTextHash: 'a'.repeat(64), lines: ['将心事记在本子里', '今天的心情有些忧郁', '手机上的聊天软件', '窗外吹来了微风'],
    updatedAt: new Date().toISOString() } });
  const before = structuredClone(artifact);
  const result = projectLyricArtifact(artifact, { song: chinese, targetLanguage: 'zh' });
  assert.equal(result.translationAvailable, false);
  assert.equal(result.translation, null);
  assert.equal(result.tlyric, '');
  assert.ok(result.lines.every(line => !Object.hasOwn(line, 'tlyric')));
  assert.deepEqual(artifact, before);
});

test('whole-body copies cannot hide behind different credits, and partial copies only render once', () => {
  const song = makeSong({ title: 'A Song', artist: 'Singer', language: 'en' });
  const original = { source: 'manual', format: 'lrc', syncMode: 'line', lines: [
    { time: 1, text: 'A Song - Singer' }, { time: 5, text: 'Come sing with me' }, { time: 8, text: 'Maria' },
  ] };
  for (const [lines, available] of [[['歌曲署名', 'Come sing with me', 'Maria'], false],
    [['歌曲署名', '和我一起歌唱', 'Maria'], true]]) {
    const artifact = makeReadyArtifact({ original, translation: { source: 'manual', language: 'zh',
      originalTextHash: 'a'.repeat(64), lines, updatedAt: new Date().toISOString() } });
    const before = structuredClone(artifact);
    const result = projectLyricArtifact(artifact, { song, targetLanguage: 'zh' });
    assert.equal(result.translationAvailable, available);
    assert.equal(result.lines[2].tlyric, undefined);
    if (available) assert.equal(result.lines[1].tlyric, '和我一起歌唱');
    assert.deepEqual(artifact, before);
  }
});

test('new unknown translation languages stay unknown, while historical providers retain compatibility', () => {
  for (const source of ['manual', 'youtube', 'lyric_' + 'a'.repeat(32), 'custom_krc', 'ai']) {
    const artifact = makeReadyArtifact({ translation: { source, originalTextHash: 'a'.repeat(64),
      lines: ['你好'], updatedAt: new Date().toISOString() } });
    assert.equal(projectLyricArtifact(artifact, { targetLanguage: 'zh' }).translationAvailable,
      ['custom_krc', 'ai'].includes(source), source);
  }
});

test('Traditional Chinese source declarations survive canonicalization and asset creation', async () => {
  const document = createLyricDocument({ source: 'custom_lrc', format: 'lrc',
    lines: [{ time: 1, text: 'Hello world', tlyric: '世界你好' }], providerMeta: { translationLanguage: 'zh-Hant' } });
  const artifact = (await buildReadyLyricArtifact(makeSong(), document)).artifact;
  assert.equal(artifact.translation.language, 'zh-Hant');
  assert.equal(projectLyricArtifact(artifact, { targetLanguage: 'zh-Hant' }).translationAvailable, true);
  assert.equal(projectLyricArtifact(artifact, { targetLanguage: 'zh' }).translationAvailable, false);
});

test('a target-language label does not validate an incompatible translated body', () => {
  for (const [language, text] of [['en', '这仍然只有中文'], ['zh', 'Still only English'], ['ko', '只有汉字'], ['ru', 'Latin only']]) {
    const artifact = makeReadyArtifact({ translation: { source: 'manual', language,
      originalTextHash: 'a'.repeat(64), lines: [text], updatedAt: new Date().toISOString() } });
    const before = structuredClone(artifact);
    assert.equal(projectLyricArtifact(artifact, { targetLanguage: language }).translationAvailable, false);
    assert.deepEqual(artifact, before);
  }
});
