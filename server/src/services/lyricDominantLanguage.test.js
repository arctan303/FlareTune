import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLyricTranslationDecision, getCurrentLyricTranslationDecision,
  hasCurrentLyricNoTranslationDecision, LYRIC_TRANSLATION_POLICY_VERSION } from './lyricTranslationPolicy.js';
import { createLyricArtifactStore, validateLyricArtifact } from './lyricArtifactStore.js';
import { projectLyricArtifact } from './lyricAssetWorkflow.js';
import { createMemoryR2Bucket, makeReadyArtifact, makeSong } from '../test/lyricAssetFixtures.js';

test('a needed assessment persists before translation without claiming a ready translated layer', async () => {
  const song=makeSong({ id:'yt:abcdefghijk', language:'other' });
  const artifact=makeReadyArtifact({ songId:song.id });
  artifact.translationDecision=buildLyricTranslationDecision(artifact,song,
    { status:'needed', targetLanguage:'zh', sourceLanguage:'en', basis:'ai' });
  assert.equal(artifact.translationDecision.policyVersion,2);
  const store=createLyricArtifactStore({ MEDIA_BUCKET:createMemoryR2Bucket() });
  await store.createIfAbsent(song.id,artifact);
  const {artifact:saved}=await store.get(song.id);
  assert.equal(getCurrentLyricTranslationDecision(saved,song,{targetLanguage:'zh'}).status,'needed');
  assert.equal(hasCurrentLyricNoTranslationDecision(saved,song,{targetLanguage:'zh'}),false);
  assert.equal(projectLyricArtifact(saved,{song,targetLanguage:'zh'}).translationAvailable,false);
  assert.equal(projectLyricArtifact(saved,{song,targetLanguage:'zh'}).translationState,'missing');
  assert.deepEqual(saved.original,artifact.original);
});

test('a cached assessment expires when text, target, tag or policy changes', () => {
  const song=makeSong({language:'other'}), artifact=makeReadyArtifact();
  artifact.translationDecision=buildLyricTranslationDecision(artifact,song,
    {status:'needed', targetLanguage:'zh', sourceLanguage:'en', basis:'ai'});
  for(const [a,s,options] of [
    [{...artifact,textHash:'b'.repeat(64)},song,{targetLanguage:'zh'}],
    [artifact,song,{targetLanguage:'en'}],
    [artifact,{...song,language:'ja'},{targetLanguage:'zh'}],
    [{...artifact,translationDecision:{...artifact.translationDecision,policyVersion:LYRIC_TRANSLATION_POLICY_VERSION-1}},song,{targetLanguage:'zh'}],
  ]) assert.equal(getCurrentLyricTranslationDecision(a,s,options),null);
});

test('needed assertions cannot bypass the language whitelist or same-target rule', () => {
  const song=makeSong({language:'other'}), artifact=makeReadyArtifact();
  for(const sourceLanguage of ['zh','other','instrumental',null,'bogus']) {
    assert.throws(()=>buildLyricTranslationDecision(artifact,song,
      {status:'needed',targetLanguage:'zh',sourceLanguage,basis:'ai'}));
  }
  const decision=buildLyricTranslationDecision(artifact,song,
    {status:'needed',targetLanguage:'zh',sourceLanguage:'en',basis:'ai'});
  assert.equal(validateLyricArtifact({...artifact,translationDecision:decision}).valid,true);
  assert.equal(validateLyricArtifact({...artifact,translationDecision:{...decision,privatePrompt:'forbidden'}}).valid,false);
});
