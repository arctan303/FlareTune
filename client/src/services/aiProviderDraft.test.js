import test from 'node:test';
import assert from 'node:assert/strict';
import { providerDraft, changeProviderSource, providerLabel, providerNeedsKey, featureDraft, changeFeatureProvider, changeFeatureModel, modelListError } from './aiProviderDraft.js';
test('official draft contains display name, Key and source while only custom contains connection fields', () => {
  assert.deepEqual(providerDraft('deepseek'), { source: 'deepseek', name: 'DeepSeek', apiKey: '' });
  assert.deepEqual(Object.keys(providerDraft('custom')).sort(), ['source', 'apiKey', 'name', 'protocol', 'baseUrl'].sort());
});
test('source choice resets credentials/custom fields but preserves a chosen display name', () => {
  assert.deepEqual(changeProviderSource({ ...providerDraft('deepseek'), apiKey: 'test-key' }, 'openai'), providerDraft('openai'));
  assert.deepEqual(changeProviderSource({ ...providerDraft('custom'), name: 'My connection', baseUrl: 'https://fixture.example', apiKey: 'test-key' }, 'deepseek'),
    { source: 'deepseek', name: 'My connection', apiKey: '' });
  assert.equal(providerLabel({ source: 'deepseek', name: 'DeepSeek 2' }), 'DeepSeek 2');
  assert.equal(providerDraft('deepseek', { name: 'Old name' }).name, 'Old name');
});
test('Key retention requires readable key and the same custom protocol/endpoint', () => {
  const previous = { id: 'id', source: 'custom', protocol: 'responses', baseUrl: 'https://proxy.example/v1', hasKey: true };
  const draft = providerDraft('custom', previous); assert.equal(providerNeedsKey(draft, previous), false);
  assert.equal(providerNeedsKey({ ...draft, baseUrl: 'https://other.example/v1' }, previous), true);
  assert.equal(providerNeedsKey({ ...draft, protocol: 'chat_completions' }, previous), true);
  assert.equal(providerNeedsKey(draft, { ...previous, hasKey: false }), true);
});
test('feature selection separates model and resets vision on actual model/provider changes', () => {
  const draft = featureDraft({ providerId: 'a', model: 'vision', supportsImages: true });
  assert.equal(changeFeatureModel(draft, 'vision').supportsImages, true);
  assert.equal(changeFeatureModel(draft, 'text').supportsImages, false);
  assert.deepEqual(changeFeatureProvider(draft, 'b'), { providerId: 'b', model: '', supportsImages: false });
  assert.match(modelListError({ code: 'ai_model_list_auth_failed' }), /认证/); assert.match(modelListError({ code: 'ai_model_list_unsupported' }), /手动/);
});
