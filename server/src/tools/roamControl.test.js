import test from 'node:test';
import assert from 'node:assert/strict';
import { roamControlTool } from './roamControl.js';

test('roam_control enable defaults to the whole library and only claims a dispatched instruction', async () => {
  const res = await roamControlTool.execute({ action: 'enable' });
  assert.equal(res.eventData.ok, true);
  assert.equal(res.eventData.action, 'enable');
  assert.equal(res.eventData.language, 'all');
  assert.equal(res.eventData.instruction_status, 'generated');
  assert.equal(res.eventData.browser_execution, 'unknown');
  assert.equal(Object.hasOwn(res, 'cards'), false);
  assert.deepEqual(res.playerAction, { type: 'roam', action: 'enable', language: 'all' });
  assert.match(res.modelText, /已下发开启【全库】随机漫游的指令/);
  assert.match(res.modelText, /待确认/);
  for (const text of [res.modelText, res.summary]) {
    assert.doesNotMatch(text, /已开启|已经开启|漫游已生效|正在漫游/);
  }
});

test('roam_control enable keeps the requested language', async () => {
  for (const language of ['zh', 'en', 'ja', 'ko', 'instrumental', 'other']) {
    const res = await roamControlTool.execute({ action: 'enable', language });
    assert.equal(res.playerAction.language, language, language);
    assert.equal(res.eventData.language, language, language);
  }
});

test('roam_control disable omits the language and reports a dispatched instruction', async () => {
  const res = await roamControlTool.execute({ action: 'disable', language: 'zh' });
  assert.equal(res.eventData.ok, true);
  assert.equal(res.eventData.action, 'disable');
  assert.equal(Object.hasOwn(res.eventData, 'language'), false);
  assert.deepEqual(res.playerAction, { type: 'roam', action: 'disable' });
  assert.equal(Object.hasOwn(res.playerAction, 'language'), false);
  assert.match(res.modelText, /已下发关闭随机漫游的指令/);
  assert.match(res.modelText, /待确认/);
  assert.doesNotMatch(res.modelText, /已关闭|已经关闭/);
});

test('roam_control rejects unknown actions and unsupported languages without emitting an instruction', async () => {
  const badAction = await roamControlTool.execute({ action: 'toggle' });
  assert.equal(badAction.eventData.ok, false);
  assert.equal(badAction.eventData.error.code, 'invalid_arguments');
  assert.equal(badAction.playerAction, null);

  const badLanguage = await roamControlTool.execute({ action: 'enable', language: 'yue' });
  assert.equal(badLanguage.eventData.ok, false);
  assert.equal(badLanguage.eventData.error.code, 'invalid_language');
  assert.equal(badLanguage.playerAction, null);
});

test('roam_control parameter contract matches the frozen language enum', () => {
  assert.deepEqual(roamControlTool.parameters.required, ['action']);
  assert.deepEqual(roamControlTool.parameters.properties.action.enum, ['enable', 'disable']);
  assert.deepEqual(
    roamControlTool.parameters.properties.language.enum,
    ['all', 'zh', 'en', 'ja', 'ko', 'instrumental', 'other'],
  );
});
