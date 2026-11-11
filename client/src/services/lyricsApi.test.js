import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLyricTranslation, putLyricSourceOrder } from './lyricsApi.js';

test('unified translation submits only the signed result with session mutation guards', async () => {
  let request;
  const result = await requestLyricTranslation('opaque-result', {
    session: { csrfToken: 'csrf-fixture', user: { accountId: 'account-fixture' } },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => ({ code: 200, data: { translation: { state: 'pending' } } }) };
    },
  });
  assert.ok(request.url.endsWith('/api/lyrics/translation'));
  assert.deepEqual(JSON.parse(request.init.body), { resultRef: 'opaque-result' });
  assert.equal(request.init.headers['X-CSRF-Token'], 'csrf-fixture');
  assert.equal(request.init.headers['X-FlareTune-Expected-Account'], 'account-fixture');
  assert.equal(result.data.translation.state, 'pending');
});

test('source order saves the revision and preserves a backend displayable failure', async () => {
  let body;
  await assert.rejects(putLyricSourceOrder(['file', 'youtube-music'], 4, {
    session: {}, fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: false, status: 409, json: async () => ({ message: '来源顺序已更新，请刷新。', error: 'revision_conflict' }) };
    },
  }), error => error.status === 409 && error.message === '来源顺序已更新，请刷新。');
  assert.deepEqual(body, { order: ['file', 'youtube-music'], expectedRevision: 4 });
});
