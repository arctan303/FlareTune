import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoamControlTool, roamControlTool } from './roamControl.js';
import { roamFixture } from '../plugins/roam/test-support.js';

async function installedTool(t) {
  const f = await roamFixture(t);
  await f.install();
  return { ...f, tool: createRoamControlTool({ registry: f.registry }), context: { env: f.env, session: f.signed.session } };
}

test('roam_control enable defaults to the whole library and only claims a dispatched instruction', async t => {
  const { tool, context } = await installedTool(t);
  const res = await tool.execute({ action: 'enable' }, context);
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

test('roam_control enable keeps the requested language', async t => {
  const { tool, context } = await installedTool(t);
  for (const language of ['zh', 'en', 'ja', 'ko', 'instrumental', 'other']) {
    const res = await tool.execute({ action: 'enable', language }, context);
    assert.equal(res.playerAction.language, language, language);
    assert.equal(res.eventData.language, language, language);
  }
});

test('roam_control disable omits the language and reports a dispatched instruction', async t => {
  const { tool, context } = await installedTool(t);
  const res = await tool.execute({ action: 'disable', language: 'zh' }, context);
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

test('roam_control emits no instruction without a live session and an administrator-installed plugin', async t => {
  const f = await roamFixture(t);
  const member = await f.signIn('member');
  const tool = createRoamControlTool({ registry: f.registry });
  const unavailable = async context => {
    for (const action of ['enable', 'disable']) {
      const result = await tool.execute({ action }, context);
      assert.equal(result.eventData.ok, false);
      assert.equal(result.eventData.error.code, 'plugin_unavailable');
      assert.equal(result.playerAction, null);
      assert.match(result.modelText, /不可用/u);
      assert.doesNotMatch(result.modelText, /已下发|已开启|已关闭/u);
    }
  };
  await unavailable({ env: f.env, session: f.signed.session });
  await unavailable({ env: f.env, session: member.session });
  await unavailable({});
  await f.install();
  assert.equal((await tool.execute({ action: 'enable' }, { env: f.env, session: member.session })).eventData.ok, true);
  await f.install(false);
  await unavailable({ env: f.env, session: member.session });
  await f.install();
  f.sqlite.exec('DELETE FROM account_sessions');
  await unavailable({ env: f.env, session: f.signed.session });
});

test('roam_control refuses an installation epoch replaced during authorization', async t => {
  const f = await roamFixture(t);
  await f.install();
  const registry = { ...f.registry, async requirePluginInstalled(env, id, epoch) {
    const installation = await f.registry.requirePluginInstalled(env, id, epoch);
    if (epoch === undefined) { await f.install(false); await f.install(); }
    return installation;
  } };
  const tool = createRoamControlTool({ registry });
  const result = await tool.execute({ action: 'enable' }, { env: f.env, session: f.signed.session });
  assert.equal(result.eventData.ok, false);
  assert.equal(result.playerAction, null);
});
