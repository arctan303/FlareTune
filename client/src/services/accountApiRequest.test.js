import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAccountJson } from './accountApiRequest.js';
import { setUiLanguage, t } from '../i18n/index.js';

class RequestError extends Error {
  constructor(message, details) { super(message); Object.assign(this, details); }
}

test('empty HTTP failures localize the request label and preserve status and code', async () => {
  try {
    for (const [locale, expected] of [
      ['zh', '歌词请求失败（503）'], ['en', 'Lyrics request failed (503)'],
      ['zh-Hant', '歌詞請求失敗（503）'], ['ja', '歌詞のリクエストに失敗しました（503）'],
      ['ko', '가사 요청 실패 (503)'],
    ]) {
      await setUiLanguage(locale);
      await assert.rejects(requestAccountJson({
        base: '', path: '/lyrics', ErrorType: RequestError, errorLabel: '歌词请求失败',
        fetchImpl: async () => new Response('{}', { status: 503 }),
      }), error => t(error.message) === expected && error.status === 503);
    }
    await assert.rejects(requestAccountJson({
      base: '', path: '/lyrics', ErrorType: RequestError, errorLabel: '歌词请求失败',
      fetchImpl: async () => new Response(JSON.stringify({ message: 'Provider detail', error: 'UNAVAILABLE', data: { retry: true } }), { status: 503 }),
    }), error => t(error.message).includes('Provider detail') && error.code === 'UNAVAILABLE' && error.data.retry);
  } finally { await setUiLanguage('en'); }
});

test('saved request failures retranslate after switching languages and known server codes override English copy', async () => {
  let failure;
  const request = payload => requestAccountJson({
    base: '', path: '/lyrics', ErrorType: RequestError, errorLabel: '歌词请求失败',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 404 }),
  });
  try {
    await setUiLanguage('zh');
    try { await request({}); } catch (error) { failure = error; }
    assert.equal(t(failure.message), '歌词请求失败（404）');
    await setUiLanguage('en');
    assert.equal(t(failure.message), 'Lyrics request failed (404)');
    for (const locale of ['en', 'zh-Hant', 'ja', 'ko']) {
      await setUiLanguage(locale);
      await assert.rejects(request({ error: 'SONG_NOT_FOUND', message: 'Song not found' }), error => {
        assert.equal(t(error.message), t('未找到歌曲'));
        if (locale !== 'en') assert.notEqual(t(error.message), 'Song not found');
        return true;
      });
    }
    await setUiLanguage('en');
    await assert.rejects(request({ error: '__proto__', message: 'Provider detail {value}' }), error =>
      t(error.message) === 'Lyrics request failed (404): Provider detail {value}');
  } finally { await setUiLanguage('en'); }
});
