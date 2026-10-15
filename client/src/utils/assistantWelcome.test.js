import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '../i18n/index.js';
import { resolveAssistantWelcome } from './assistantWelcome.js';

test('custom instance and Demo welcomes remain verbatim in every supported language', async () => {
  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) {
    await setUiLanguage(locale);
    for (const welcomeMessage of ['欢迎回来，先选一首歌吧', 'Demo: fixed example reply; no AI model is called.']) {
      assert.equal(resolveAssistantWelcome({ name: 'Library helper', welcomeMessage }), welcomeMessage);
    }
  }
});

test('missing and legacy default welcomes localize with the configured name', async () => {
  await setUiLanguage('en');
  for (const welcomeMessage of [undefined, '', '  ', '你好，我是小A。想听什么？']) {
    const welcome = resolveAssistantWelcome({ name: 'Library helper', welcomeMessage });
    assert.match(welcome, /Library helper/);
    assert.doesNotMatch(welcome, /你好/);
  }
  assert.doesNotMatch(resolveAssistantWelcome(null), /Library helper/);
  await setUiLanguage('zh');
  assert.equal(resolveAssistantWelcome({ name: '音乐管家' }), '你好，我是音乐管家。想听什么？');
});
