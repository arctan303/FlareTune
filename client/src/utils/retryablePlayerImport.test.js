import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryablePlayerImport, getFailedPlayerModuleUrl } from './retryablePlayerImport.js';

test('a rejected native module fetch retries a new URL and reuses its successful module', async () => {
  let normalCalls = 0;
  const retryUrls = [];
  const module = { default: () => null };
  const load = createRetryablePlayerImport(() => {
    normalCalls++;
    throw new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/Player-abc.js');
  }, { baseUrl: 'https://example.test/', importUrl: async url => { retryUrls.push(url); return module; } });
  const first = load();
  assert.equal(load(), first);
  await assert.rejects(first);
  assert.equal(await load(), module);
  assert.equal(await load(), module);
  assert.equal(normalCalls, 1);
  assert.deepEqual(retryUrls, ['https://example.test/assets/Player-abc.js?player_retry=1']);
});

test('subsequent failed retry advances its URL without an automatic retry loop', async () => {
  const retryUrls = [];
  const error = new TypeError('error loading dynamically imported module: https://example.test/assets/Player.js?other=value');
  const load = createRetryablePlayerImport(async () => { throw error; }, {
    baseUrl: 'https://example.test/', importUrl: async url => { retryUrls.push(url); throw error; },
  });
  await assert.rejects(load());
  await assert.rejects(load());
  await assert.rejects(load());
  assert.deepEqual(retryUrls, ['https://example.test/assets/Player.js?other=value&player_retry=1', 'https://example.test/assets/Player.js?other=value&player_retry=2']);
});

test('render errors and unrelated URLs never become module imports', async () => {
  for (const message of ['render failed', 'Failed to fetch dynamically imported module: https://other.test/assets/Player.js', 'Failed to fetch dynamically imported module: https://example.test/api/private']) {
    assert.equal(getFailedPlayerModuleUrl(new Error(message), 'https://example.test/'), null);
  }
  let calls = 0;
  const load = createRetryablePlayerImport(async () => { if (++calls === 1) throw new Error('temporary loader error'); return { default: 1 }; });
  await assert.rejects(load());
  assert.equal((await load()).default, 1);
  assert.equal(calls, 2);
});
