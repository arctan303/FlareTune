import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../subsonic/test-support.js';
import { pluginRegistry } from '../registry.js';
import { DEFAULT_LYRIC_AI_CONFIG } from '../../utils/lyricAiConfig.js';

async function setup(t, gateway = true) {
  const f = await fixture(); t.after(() => f.close());
  for (const id of gateway ? ['lyrics-workbench', 'ai-gateway'] : ['lyrics-workbench']) {
    await pluginRegistry.setInstalled(f.env, f.signed.session, id, { installed: true, revision: 0 });
  }
  const source = { ...DEFAULT_LYRIC_AI_CONFIG, model: 'saved-legacy-model', temperature: 1.3 };
  f.sqlite.prepare("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('lyrics.ai',?,5,1,?)").run(JSON.stringify(source), f.owner);
  const call = (path = 'model', method = 'GET', body, auth = f.signed) => f.api(`admin/plugins/lyrics-workbench/${path}`, method, body, auth,
    { 'X-FlareTune-Plugin-Build': pluginRegistry.getBuildDigest('lyrics-workbench') });
  const saved = () => f.sqlite.prepare("SELECT value_json,revision FROM instance_settings WHERE key='plugin.data.lyrics-workbench.instance.ai-model'").get();
  return { ...f, source, call, saved };
}
test('workbench model GET never imports; explicit admin handoff preserves its stored model and generation settings', async t => {
  const f = await setup(t); const get = await f.call(); assert.equal(get.status, 200);
  assert.equal((await get.json()).updateRequired, true); assert.equal(f.saved(), undefined);
  const member = await f.signIn('member'); assert.equal((await f.call('model/initialize', 'POST', { expectedRevision: 0 }, member)).status, 403);
  const result = await f.call('model/initialize', 'POST', { expectedRevision: 0 }); assert.equal(result.status, 200, await result.clone().text());
  const dto = await result.json(); assert.equal(dto.value.selection.providerId, null);
  assert.equal(dto.value.selection.model, f.source.model); assert.equal(dto.value.selection.generationOptions.temperature, 1.3);
  f.sqlite.exec("UPDATE instance_settings SET value_json='{}',revision=revision+1 WHERE key='lyrics.ai'");
  const repeated = await f.call('model/initialize', 'POST', { expectedRevision: 0 });
  assert.equal(repeated.status, 200); assert.equal((await repeated.json()).revision, 1);
});
test('a source revision changing before the handoff transaction cannot create a partial target or resource use', async t => {
  const f = await setup(t), prepare = f.db.prepare.bind(f.db), batch = f.db.batch.bind(f.db); let changed = false;
  f.db.prepare = sql => { const statement = prepare(sql); statement.sql = sql; return statement; };
  f.db.batch = async statements => {
    if (!changed && statements.some(statement => /INSERT INTO instance_settings/.test(statement.sql || '') && /ON CONFLICT/.test(statement.sql || ''))) {
      changed = true; f.sqlite.exec("UPDATE instance_settings SET revision=revision+1 WHERE key='lyrics.ai'");
    }
    return batch(statements);
  };
  const response = await f.call('model/initialize', 'POST', { expectedRevision: 0 });
  assert.equal(changed, true); assert.equal(response.status, 409, await response.clone().text()); assert.equal(f.saved(), undefined);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_settings WHERE key='plugin.service-use.ai-gateway.lyrics-workbench.ai-model'").get().n, 0);
});
test('missing optional gateway reports a concrete model error while ordinary workbench settings remain available', async t => {
  const f = await setup(t, false);
  assert.equal((await f.call('settings')).status, 200);
  const model = await f.call(); assert.equal(model.status, 409); assert.match((await model.json()).error, /^PLUGIN_/);
  assert.equal(f.saved(), undefined);
});
