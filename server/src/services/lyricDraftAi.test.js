import test from 'node:test';
import assert from 'node:assert/strict';
import { completeLyricDraft } from './lyricDraftAi.js';
import { makeSong } from '../test/lyricAssetFixtures.js';

test('AI completes an imported draft without persisting lyrics or song language', async () => {
  let languageWrites = 0;
  const db = { prepare(sql) {
    if (/^SELECT value_json/u.test(sql)) return { first: async () => null };
    languageWrites += 1;
    throw new Error('draft must not write D1');
  } };
  const result = await completeLyricDraft({
    env: { SETUP_SECRET: 's'.repeat(48) }, db,
    song: makeSong({ language: 'ja' }), actorAccountId: 'admin', etag: null,
    lines: [{ time: 1, text: 'Hello world' }],
    deps: {
      reserveDailyQuota: async () => true,
      getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test',
        targetLanguage: 'zh', detectLanguage: true, cleanDirtyLyrics: false }),
      resolveAiFeature: async () => null,
      askAI: async () => ({ translations: [{ unitId: 0, text: '你好世界' }], songLanguage: 'en',
        discardLineIndices: [] }),
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.lines[0].tlyric, '你好世界');
  assert.equal(result.translationLanguage, 'zh');
  assert.equal(result.inferredLanguage, 'en');
  assert.equal(typeof result.receipt, 'string');
  assert.equal(languageWrites, 0);
});

test('AI redo replaces English provider translation with the actual configured target language', async () => {
  const result = await completeLyricDraft({
    env: { SETUP_SECRET: 's'.repeat(48) }, db: {},
    song: makeSong({ language: 'ja' }), actorAccountId: 'admin', etag: null,
    translationLanguage: 'en', lines: [{ time: 1, text: 'こんにちは', tlyric: 'Hello' }],
    deps: {
      reserveDailyQuota: async () => true,
      getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test',
        targetLanguage: 'zh', detectLanguage: false, cleanDirtyLyrics: false }),
      resolveAiFeature: async () => null,
      askAI: async () => ({ translations: [{ unitId: 0, text: '你好' }] }),
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.lines[0].tlyric, '你好');
  assert.equal(result.translationLanguage, 'zh');
});

test('draft AI removes identified credits before returning editable lyrics and receipt', async () => {
  const result = await completeLyricDraft({
    env: { SETUP_SECRET: 's'.repeat(48) }, db: {},
    song: makeSong({ language: 'ja' }), actorAccountId: 'admin', etag: null,
    lines: [{ time: 0, text: 'Lyrics by: Someone' }, { time: 1, text: 'Hello world' }],
    deps: {
      reserveDailyQuota: async () => true,
      getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test',
        targetLanguage: 'zh', detectLanguage: true, cleanDirtyLyrics: true }),
      resolveAiFeature: async () => null,
      askAI: async () => ({ translations: [{ unitId: 1, text: '你好世界' }],
        songLanguage: 'en', discardLineIndices: [0] }),
    },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.lines.map((line) => [line.text, line.tlyric]),
    [['Hello world', '你好世界']]);
  assert.equal(typeof result.receipt, 'string');
  assert.equal(Object.hasOwn(result, 'cleanupCandidateIndices'), false);
});
