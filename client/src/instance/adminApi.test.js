import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  adminErrorMessage, assignAiProfile, createAiProfile, createManagedAccount, getAiModels, getAdminOverview, parseExactHttpsOrigins,
  patchManagedAccount, putAdminSetting, putAssistant, resetManagedPassword,
} from './adminApi.js';

const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('management mutations use local Cookie/CSRF API and never put credentials in URL', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return respond({ ok: true }); };
  await putAdminSetting('instance.name', 'My Tune', 2, 'csrf', fetchImpl);
  await putAssistant({ name: '小A' }, 1, 'csrf', fetchImpl);
  await createManagedAccount({ username: 'member', temporaryPassword: 'secret-password' }, 'csrf', fetchImpl);
  await patchManagedAccount('account_1', { status: 'disabled', expectedUpdatedAt: 123 }, 'csrf', fetchImpl);
  await resetManagedPassword('account_1', 'temporary-password', 'csrf', fetchImpl);
  assert.deepEqual(calls.map(([url]) => url), [
    '/api/admin/settings', '/api/admin/assistant', '/api/admin/accounts',
    '/api/admin/accounts/account_1', '/api/admin/accounts/account_1/reset-password',
  ]);
  assert.deepEqual(calls.map(([, init]) => init.method), ['PUT', 'PUT', 'POST', 'PATCH', 'POST']);
  for (const [, init] of calls) {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['X-CSRF-Token'], 'csrf');
    assert.equal(init.headers['X-Requested-With'], 'FlareTune');
  }
  assert.doesNotMatch(JSON.stringify(calls.map(([url]) => url)), /secret-password|temporary-password/);
  assert.deepEqual(JSON.parse(calls[0][1].body), { key: 'instance.name', value: 'My Tune', expectedRevision: 2 });
});

test('overview reads settings and accounts concurrently with no key value field', async () => {
  const urls = [];
  const result = await getAdminOverview('csrf', async (url) => {
    urls.push(url);
    return respond(url.endsWith('settings') ? { settings: {}, assistant: {}, secrets: { aiApiKeyConfigured: false } } : { accounts: [] });
  });
  assert.deepEqual(urls.sort(), ['/api/admin/accounts', '/api/admin/settings']);
  assert.equal(result.secrets.aiApiKeyConfigured, false);
  assert.deepEqual(result.accounts, []);
});

test('AI profile credential stays in request body and feature assignment uses CSRF', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return respond({ ok: true }); };
  await createAiProfile({ name: 'Primary', provider: 'deepseek', model: 'deepseek-chat',
    apiKey: 'private-key' }, 'csrf', fetchImpl);
  await assignAiProfile('lyrics', 'profile-id', 0, 'csrf', fetchImpl);
  assert.deepEqual(calls.map(([url]) => url), ['/api/admin/ai/profiles', '/api/admin/ai/assignments']);
  assert.equal(JSON.parse(calls[0][1].body).apiKey, 'private-key');
  assert.equal(calls[0][1].headers['X-CSRF-Token'], 'csrf');
  assert.doesNotMatch(calls[0][0], /private-key/);
});

test('model discovery sends secrets only in same-origin POST with CSRF', async () => {
  const result = await getAiModels({ source: 'openai', protocol: 'responses', apiKey: 'fixture-key' },
    'csrf', async (url, init) => {
      assert.equal(url, '/api/admin/ai/models');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.headers['X-CSRF-Token'], 'csrf');
      assert.equal(JSON.parse(init.body).apiKey, 'fixture-key');
      return respond({ models: ['example-model'] });
    });
  assert.deepEqual(result.models, ['example-model']);
});

test('additional origins accept exact HTTPS only', () => {
  assert.deepEqual(parseExactHttpsOrigins('https://one.example\n\nhttps://two.example:8443'), [
    'https://one.example', 'https://two.example:8443',
  ]);
  for (const value of ['*', 'http://site.example', 'https://site.example/', 'https://site.example/path',
    'https://site.example?q=1', 'https://site.example\nhttps://site.example']) {
    assert.throws(() => parseExactHttpsOrigins(value));
  }
});

test('admin UI removes Admin Key flow and provides conflict feedback', () => {
  const source = readFileSync(new URL('../components/AdminView.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /manageApi|AdminAuthPanel|setAdminKey|ADMIN_API_KEY/);
  assert.match(source, /系统管理/);
  assert.match(source, /AiProfilesPanel/);
  assert.match(source, /expectedUpdatedAt/);
  assert.match(adminErrorMessage({ status: 409 }), /刷新/);
});
