import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLyricTranslationNeed, buildLyricNoTranslationDecision, buildLyricTranslationDecision,
  hasCurrentLyricNoTranslationDecision, getCurrentLyricTranslationDecision } from './lyricTranslationPolicy.js';
import { projectLyricArtifact, shouldAiCompleteLyrics, buildEditedLyricArtifact, buildReadyLyricArtifact } from './lyricAssetWorkflow.js';
import { createLyricArtifactStore, validateLyricArtifact } from './lyricArtifactStore.js';
import { createMemoryR2Bucket, makeReadyArtifact, makeSong } from '../test/lyricAssetFixtures.js';

const original = text => ({ source: 'manual', format: 'lrc', syncMode: 'line', lines: [{ time: 1, text }] });
test('catalog language whitelist follows the selected target and sends contradictions to unknown', () => {
  for (const [language, text, targetLanguage, state] of [
    ['zh', '窗外的春风', 'zh', 'not_needed'], ['zh', '窗外的春风', 'zh-Hant', 'not_needed'],
    ['en', 'Come sing with me', 'en', 'not_needed'], ['fr', 'Bonjour le monde', 'fr', 'not_needed'],
    ['fr', 'Bonjour le monde', 'en', 'needed'], ['zh', '窗外的春风', 'en', 'needed'],
    ['en', '窗外的春风', 'zh', 'unknown'], ['zh', 'Come sing with me', 'zh', 'unknown'],
    ['zh', '窗外的春风 I love you', 'zh', 'unknown'], [undefined, '窗外的春风', 'zh', 'unknown'],
    ['other', 'Come sing with me', 'en', 'unknown'], ['ja', '夢ならば', 'ja', 'not_needed'],
    ['instrumental', 'Anything', 'zh', 'not_needed'],
  ]) assert.equal(resolveLyricTranslationNeed(original(text), { language }, { targetLanguage }).state, state, `${language}/${targetLanguage}`);
  assert.equal(shouldAiCompleteLyrics(original('Come sing with me'), { language: 'en' }, { targetLanguage: 'en' }), false);
});

test('no-op decisions survive R2 reads and bind content, target, language hint and policy version', async () => {
  const song = makeSong({ language: 'other' });
  const artifact = makeReadyArtifact({ original: original('窗外的春风') });
  artifact.translationDecision = buildLyricNoTranslationDecision(artifact, song, { targetLanguage: 'zh', sourceLanguage: 'zh', basis: 'ai' });
  const store = createLyricArtifactStore({ MEDIA_BUCKET: createMemoryR2Bucket() });
  await store.createIfAbsent(song.id, artifact);
  const read = await store.get(song.id);
  assert.deepEqual(read.artifact.translationDecision, artifact.translationDecision);
  assert.equal(hasCurrentLyricNoTranslationDecision(read.artifact, song, { targetLanguage: 'zh' }), true);
  assert.equal(hasCurrentLyricNoTranslationDecision({ ...artifact, offsetMs: 1500 }, song, { targetLanguage: 'zh' }), true);
  for (const [changed, hint, targetLanguage] of [
    [{ ...artifact, textHash: 'b'.repeat(64) }, song, 'zh'], [artifact, song, 'en'], [artifact, song, 'zh-Hant'],
    [artifact, { ...song, language: 'en' }, 'zh'],
    [{ ...artifact, translationDecision: { ...artifact.translationDecision, policyVersion: 2 } }, song, 'zh'],
  ]) assert.equal(hasCurrentLyricNoTranslationDecision(changed, hint, { targetLanguage }), false);
  assert.equal(validateLyricArtifact({ ...artifact, textHash: 'b'.repeat(64) }).valid, true,
    'a stale decision must not make the original lyrics unreadable');
  assert.throws(() => buildLyricNoTranslationDecision(artifact, song, { targetLanguage: 'en', sourceLanguage: 'zh', basis: 'ai' }));
});

test('unknown AI paraphrases require evidence and an accepted no-op hides the old layer without deleting it', () => {
  const song = makeSong({ language: 'other' });
  const artifact = makeReadyArtifact({ original: original('窗外的春风'), translation: {
    source: 'ai', language: 'zh', originalTextHash: 'a'.repeat(64), lines: ['窗边的微风'], updatedAt: new Date().toISOString(),
  } });
  assert.equal(projectLyricArtifact(artifact, { song, targetLanguage: 'zh' }).translationAvailable, false);
  const saved = structuredClone(artifact.translation);
  artifact.translationDecision = buildLyricNoTranslationDecision(artifact, song, { targetLanguage: 'zh', sourceLanguage: 'zh', basis: 'ai' });
  assert.equal(projectLyricArtifact(artifact, { song, targetLanguage: 'zh' }).translationAvailable, false);
  assert.deepEqual(artifact.translation, saved);
  const partialCommit = { ...artifact, aiCompletion: { status: 'failed', errorCode: 'language_update_failed', updatedAt: new Date().toISOString() } };
  assert.equal(hasCurrentLyricNoTranslationDecision(partialCommit, song, { targetLanguage: 'zh' }), false);
  assert.equal(projectLyricArtifact(partialCommit, { song, targetLanguage: 'zh' }).translationState, 'failed');
  const foreign = makeReadyArtifact({ original: original('世界'), translation: {
    source: 'ai', language: 'zh', originalTextHash: 'a'.repeat(64), lines: ['世间'], updatedAt: new Date().toISOString(),
  } });
  foreign.translationDecision = buildLyricTranslationDecision(foreign, song, { targetLanguage: 'zh', sourceLanguage: 'ja', basis: 'ai' });
  assert.equal(getCurrentLyricTranslationDecision(foreign, song, { targetLanguage: 'zh' }).status, 'translated');
  assert.equal(projectLyricArtifact(foreign, { song, targetLanguage: 'zh' }).translationAvailable, true);
  assert.equal(projectLyricArtifact(foreign, { song: { ...song, language: 'en' }, targetLanguage: 'zh' }).translationAvailable, false);
});

test('decision schema rejects unknown fields and false no-op assertions before storage', () => {
  const artifact = makeReadyArtifact({ original: original('窗外的春风') });
  const decision = buildLyricNoTranslationDecision(artifact, { language: 'zh' }, { targetLanguage: 'zh', sourceLanguage: 'zh', basis: 'tag' });
  for (const invalid of [{ ...decision, policyVersion: 0 }, { ...decision, status: 'failed' },
    { ...decision, sourceLanguage: 'other' }, { ...decision, debugPrompt: 'private' }, { ...decision, hasForeignPassages: true }]) {
    assert.equal(validateLyricArtifact({ ...artifact, translationDecision: invalid }).valid, false);
  }
});

test('new provider and edited documents cannot write same-language paraphrases or copied layers', async () => {
  const song = makeSong({ language: 'zh' });
  const lines = [{ time: 1, text: '窗外的春风', tlyric: '窗边的微风' }];
  const edited = await buildEditedLyricArtifact(song, lines, { translationLanguage: 'zh' });
  const imported = (await buildReadyLyricArtifact(song, { source: 'custom_lrc', format: 'lrc', lines,
    providerMeta: { translationLanguage: 'zh' } })).artifact;
  assert.equal(edited.translation, null);
  assert.equal(imported.translation, null);
  assert.equal(edited.original.lines[0].text, lines[0].text);
  const foreign = await buildEditedLyricArtifact(song, [{ ...lines[0], tlyric: 'The spring breeze' }], { translationLanguage: 'en' });
  assert.equal(foreign.translation.lines[0], 'The spring breeze');
});
