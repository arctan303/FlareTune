import test from 'node:test';
import assert from 'node:assert/strict';
import { aiProfileAdvanced, aiProfileDraft, aiProfileNeedsKey, aiProfilePayload, changeAiProtocol, changeAiSource } from './aiProfileDraft.js';

test('official source presets simplify new forms while legacy protocol overrides remain visible', () => {
  const draft = aiProfileDraft();
  assert.equal(draft.source, 'deepseek');
  assert.equal(changeAiSource(draft, 'openai').protocol, 'responses');
  assert.equal(changeAiSource(draft, 'anthropic').protocol, 'anthropic_messages');
  assert.equal(changeAiSource(draft, 'gemini').protocol, 'gemini_native');
  assert.equal(changeAiSource(draft, 'custom').protocol, 'chat_completions');
  assert.equal(aiProfileAdvanced({ provider: 'openai' }), true);
  assert.equal(aiProfileAdvanced({ source: 'openai', protocol: 'responses' }), false);
  assert.equal(aiProfileAdvanced({ provider: 'compatible', baseUrl: 'https://proxy.example/v1' }), true);
});

test('source switch clears unsubmitted secrets and incompatible fields; closing advanced never changes payload', () => {
  const draft = { ...aiProfileDraft(), apiKey: 'unsaved-secret', baseUrl: 'https://proxy.example',
    model: 'old', generationOptions: { temperature: '0.3', thinkingMode: 'adaptive', maxOutputTokens: '8192' } };
  assert.deepEqual(aiProfilePayload(draft).generationOptions, { temperature: 0.3, thinkingMode: 'adaptive', maxOutputTokens: 8192 });
  const next = changeAiSource(draft, 'gemini');
  assert.equal(next.apiKey, '');
  assert.equal(next.model, '');
  assert.equal(next.baseUrl, '');
  assert.deepEqual(next.generationOptions, {});
});

test('key requirement uses source/protocol/effective URL instead of raw strings or model changes', () => {
  const profile = { source: 'openai', protocol: 'responses', baseUrl: '', hasKey: true };
  const draft = aiProfileDraft(profile);
  assert.equal(aiProfileNeedsKey(profile, { ...draft, model: 'new-model' }), false);
  assert.equal(aiProfileNeedsKey(profile, { ...draft, baseUrl: 'https://api.openai.com/v1/' }), false);
  assert.equal(aiProfileNeedsKey(profile, { ...draft, protocol: 'chat_completions' }), true);
  assert.equal(aiProfileNeedsKey(profile, { ...draft, baseUrl: 'https://proxy.example/v1' }), true);
  assert.equal(aiProfileNeedsKey(profile, { ...draft, source: 'custom' }), true);
});

test('protocol switch clears unsupported thinking fields but retains common overrides', () => {
  const draft = { ...aiProfileDraft(), generationOptions: { reasoningEffort: 'xhigh',
    thinkingMode: 'enabled', thinkingBudget: '1024', temperature: '0.3' } };
  assert.deepEqual(changeAiProtocol(draft, 'gemini_native').generationOptions, { temperature: '0.3' });
  assert.deepEqual(changeAiProtocol({ ...draft, generationOptions: { reasoningEffort: 'high' } },
    'anthropic_messages').generationOptions, { reasoningEffort: 'high' });
});
