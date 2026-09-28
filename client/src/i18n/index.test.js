import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLocale, getLocale, resolveLocale, setUiLanguage, t } from './index.js';

test('browser language accepts Chinese variants and otherwise falls back to English', () => {
  assert.equal(browserLocale({ languages: ['zh-TW', 'en-US'] }), 'zh');
  assert.equal(browserLocale({ language: 'zh-CN' }), 'zh');
  assert.equal(browserLocale({ languages: ['en-GB', 'zh-CN'] }), 'en');
  assert.equal(browserLocale({ languages: ['fr-FR', 'zh-CN'] }), 'en');
  assert.equal(resolveLocale('zh', { language: 'en-US' }), 'zh');
  assert.equal(resolveLocale('en', { language: 'zh-CN' }), 'en');
});

test('account choice changes rendered copy and document language', () => {
  const original = globalThis.document;
  globalThis.document = { documentElement: { lang: '' } };
  try {
    setUiLanguage('zh');
    assert.equal(getLocale(), 'zh');
    assert.equal(t('登录'), '登录');
    assert.equal(document.documentElement.lang, 'zh-CN');
    setUiLanguage('en');
    assert.equal(t('登录'), 'Sign in');
    assert.equal(t('已处理 {count} 条记录，继续升级以完成下一批。', { count: 3 }),
      'Processed 3 records. Continue the upgrade to complete the next batch.');
    assert.equal(document.documentElement.lang, 'en');
  } finally {
    globalThis.document = original;
    setUiLanguage('auto');
  }
});
