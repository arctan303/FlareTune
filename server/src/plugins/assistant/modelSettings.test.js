import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from '../../routes/localAssistant.fixture.js';
import { createAssistantHandler } from './handler.js';
import { createPluginContext } from '../context.js';
import { pluginRegistry } from '../registry.js';
import { KNOWN_MIGRATIONS } from '../../instance/schemaManifest.js';

async function setup(t) {
  const f = fixture({ modelInitialized: false }); t.after(() => f.sqlite.close());
  f.sqlite.exec(readFileSync(new URL('../../../db/migrations-flaretune/0011_ai_feature_models.sql', import.meta.url), 'utf8'));
  f.sqlite.exec("UPDATE accounts SET role='admin' WHERE account_id='account-A'");
  const migration = KNOWN_MIGRATIONS.find(row => row.version === 2);
  f.sqlite.prepare(`INSERT INTO ft_migrations(version,name,checksum,stage,state,started_at,completed_at)
    VALUES (?,?,?,?,'completed',1,1)`).run(migration.version, migration.name, migration.checksum, migration.stage);
  f.sqlite.exec('UPDATE ft_instance SET schema_version=2,initialized_at=1 WHERE id=1');
  const env = { DB: f.db, DEEPSEEK_API_KEY: 'model-settings-test-only', SETUP_SECRET: 'model-settings-fixture-secret-32-characters' };
  const session = f.session('account-A'), context = await createPluginContext({ env, session, pluginId: 'assistant' });
  const handler = createAssistantHandler(env, session);
  const call = (path, method = 'GET', body) => handler({ request: f.request(path, method, body), path, scope: 'admin', context });
  const saved = () => f.sqlite.prepare("SELECT value_json,revision FROM instance_settings WHERE key='plugin.data.assistant.instance.ai-model'").get();
  return { ...f, env, adminSession: session, context, call, saved };
}

test('model GET is read-only; explicit initialization preserves deployment model and generation options and is idempotent', async t => {
  const f = await setup(t);
  const original = f.sqlite.prepare("SELECT provider,model,temperature FROM music_assistant_configs WHERE id='xiaoa'").get();
  const overview = await f.call('/model'); assert.equal(overview.status, 200);
  assert.equal((await overview.json()).updateRequired, true); assert.equal(f.saved(), undefined);
  const initialized = await f.call('/model/initialize', 'POST', { expectedRevision: 0 });
  assert.equal(initialized.status, 200, await initialized.clone().text());
  const dto = await initialized.json(); assert.equal(dto.revision, 1);
  assert.equal(dto.value.selection.providerId, null); assert.equal(dto.value.selection.model, original.model);
  assert.equal(dto.value.selection.generationOptions.temperature, original.temperature);
  assert.doesNotMatch(JSON.stringify(dto), /model-settings-test-only|SETUP_SECRET|apiKey|encrypted/i);
  assert.equal((await f.call('/model/initialize', 'POST', { expectedRevision: 0 })).status, 200);
  assert.equal(f.saved().revision, 1);
  assert.equal((await f.call('/model')).status, 200); assert.equal(f.saved().revision, 1);
});

test('model routes reject non-admins and browser supplied legacy data or source predicates', async t => {
  const f = await setup(t);
  for (const extra of [{ legacyConfig: { model: 'injected' } }, { legacyConstraints: [] }]) {
    assert.equal((await f.call('/model/initialize', 'POST', { expectedRevision: 0, ...extra })).status, 400);
  }
  const session = f.session('account-B'), context = await createPluginContext({ env: f.env, session, pluginId: 'assistant' });
  const handler = createAssistantHandler(f.env, session);
  for (const path of ['/model', '/model/models', '/model/initialize']) {
    const response = await handler({ request: f.request(path), path, scope: 'admin', context });
    assert.equal(response.status, 403);
  }
  assert.equal(f.saved(), undefined);
});

test('legacy source changes during initialization cannot leave imported configuration or an occupancy row', async t => {
  const f = await setup(t);
  const prepare = f.db.prepare.bind(f.db), batch = f.db.batch.bind(f.db);
  f.db.prepare = sql => { const statement = prepare(sql); statement.sql = sql; return statement; };
  let raced = false;
  f.db.batch = async statements => {
    if (!raced && statements.some(statement => /INSERT INTO instance_settings/.test(statement.sql || '') && /ON CONFLICT/.test(statement.sql || ''))) {
      raced = true; f.sqlite.exec("UPDATE music_assistant_configs SET model='new-legacy-model',revision=revision+1 WHERE id='xiaoa'");
    }
    return batch(statements);
  };
  const response = await f.call('/model/initialize', 'POST', { expectedRevision: 0 });
  assert.equal(raced, true); assert.equal(response.status, 409, await response.clone().text());
  assert.equal(f.saved(), undefined);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM instance_settings WHERE key LIKE 'plugin.service-use.%'").get().n, 0);
});

test('an uninitialized model gives a concrete error before reserving a conversation turn', async t => {
  const f = await setup(t);
  const response = await f.route('/api/ai/chat', 'POST', { revision: 0, client_message_id: 'unready-model', message: 'hello' });
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'PLUGIN_UPDATE_REQUIRED');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM music_chat_turns').get().n, 0);
});
