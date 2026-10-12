import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserLocale, getLocale, resolveLocale, setUiLanguage, t, formatNumber, formatRelative } from './index.js';
import { UI_LANGUAGES, isUiLanguage, matchUiLanguage } from '../../../shared/uiLanguages.js';
import english from './en.js';
test('browser languages match scripts, regions and ordered fallbacks', () => {
  for (const [tag,expected] of [['zh-TW','zh-Hant'],['zh-Hans-TW','zh'],['zh-Hant-CN','zh-Hant'],['zh-HK','zh-Hant'],['zh-CN','zh'],['pt-PT','pt-BR'],['ja-JP','ja'],['de-AT','de'],['unknown',null]]) assert.equal(matchUiLanguage(tag),expected);
  assert.equal(browserLocale({languages:['unsupported','fr-FR','zh-CN']}),'fr');
  assert.equal(browserLocale({languages:['en-GB','zh-CN']}),'en');
  assert.equal(browserLocale({language:'unknown'}),'en');
  for (const {id} of UI_LANGUAGES) { assert.ok(isUiLanguage(id)); assert.equal(resolveLocale(id,{language:'en'}),id); }
  assert.equal(isUiLanguage('xx'),false);
});
test('account language updates copy, interpolation and document tag', async () => {
  const original=globalThis.document;
  globalThis.document={documentElement:{lang:''}};
  try {
    await setUiLanguage('zh'); assert.equal(t('登录'),'登录'); assert.equal(document.documentElement.lang,'zh-CN');
    await setUiLanguage('en'); assert.equal(t('登录'),'Sign in'); assert.equal(document.documentElement.lang,'en');
    assert.equal(t('已处理 {count} 条记录，继续升级以完成下一批。',{count:3}),'Processed 3 records. Continue the upgrade to complete the next batch.');
  } finally { globalThis.document=original; await setUiLanguage('en'); }
});
test('late language load cannot override a newer account choice; failures retry', async () => {
  const isolated=await import('./index.js?race');
  let finish;
  const older=isolated.setUiLanguage('ja',{load:()=>new Promise(resolve=>{finish=resolve;})});
  await Promise.resolve();
  await isolated.setUiLanguage('zh'); finish({default:{登录:'古い'}});
  assert.equal(await older,false); assert.equal(isolated.getLocale(),'zh');
  let attempts=0;
  assert.equal(await isolated.setUiLanguage('ko',{load:()=>{attempts++;throw Error('offline');}}),false);
  assert.equal(isolated.getLocale(),'zh');
  assert.equal(await isolated.setUiLanguage('ko',{load:()=>{attempts++;return {登录:'로그인'};}}),true);
  assert.equal(attempts,2); assert.equal(isolated.t('登录'),'로그인');
});
test('all seven lazy dictionaries have complete keys and exact interpolation tokens', async () => {
  const tokens=value=>[...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(m=>m[1]).sort();
  for (const {id} of UI_LANGUAGES.filter(l=>!['zh','en'].includes(l.id))) {
    const catalog=JSON.parse(await readFile(new URL(`./locales/${id}.json`,import.meta.url),'utf8'));
    assert.deepEqual(Object.keys(catalog).sort(),Object.keys(english).sort(),id);
    for (const [key,value] of Object.entries(catalog)) {
      for (const form of typeof value === 'string' ? [value] : Object.values(value)) {
        assert.equal(typeof form,'string',`${id}: ${key}`); assert.ok(form.trim(),`${id}: ${key}`);
        assert.deepEqual(tokens(form),tokens(key),`${id}: ${key}`);
      }
    }
    assert.equal(await setUiLanguage(id),true,id); assert.notEqual(t('登录'),'登录',id);
    assert.equal(t('这个键不存在'),'这个键不存在');
    assert.ok(formatNumber(1234.5)); assert.ok(formatRelative(-1,'day'));
  }
  await setUiLanguage('en'); assert.equal(getLocale(),'en');
  assert.equal(t('{p0} 首歌曲',{p0:1}),'1 song');
  assert.equal(t('{p0} 首歌曲',{p0:2}),'2 songs');
});
