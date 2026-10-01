import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_BUNDLE } from '../instance/migrationBundle.generated.js';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';
import { runKnownDatabaseUpgrade } from '../instance/upgradeDatabase.js';
import { createAiProfile, updateAiProfile, assignAiProfile, resolveAiFeature } from './aiProfiles.js';
import { createAiProvider, updateAiProvider, deleteAiProvider, listAiProviders, listAiProviderModels, saveAiFeatureModel } from './aiProviders.js';
import { assistantImagePolicy } from '../services/assistantImages.js';

const env = { SETUP_SECRET: 'provider-test-only-secret'.repeat(3) };
function fixture(t, legacy = false) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATION_BUNDLE.slice(0, legacy ? 10 : 11)) for (const sql of migration.statements) sqlite.exec(sql);
  const migration = KNOWN_MIGRATIONS.find(item => item.version === 2);
  sqlite.prepare("INSERT INTO ft_migrations(version,name,checksum,stage,state,started_at,completed_at) VALUES (?,?,?,?,'completed',1,1)")
    .run(migration.version, migration.name, migration.checksum, migration.stage);
  sqlite.exec(`UPDATE ft_instance SET schema_version = 2, initialized_at = 1 WHERE id = 1;
    INSERT INTO accounts(account_id,username,role,status,created_at,updated_at) VALUES ('admin','owner','admin','active',1,1),('member','reader','member','active',1,1);`);
  for (const id of ['admin', 'member']) sqlite.prepare(`INSERT INTO account_credentials(account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,updated_at)
    VALUES (?,'pbkdf2-sha256-chain',2,'{"iterations":100000,"rounds":6}',?,?,1)`)
    .run(id, Buffer.alloc(16, 1).toString('base64url'), Buffer.alloc(32, 2).toString('base64url'));
  const db = { prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; }, async first() { return sqlite.prepare(sql).get(...args) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
  }; }, async batch(statements) { sqlite.exec('BEGIN IMMEDIATE'); try {
    const results = []; for (const item of statements) results.push(await item.run()); sqlite.exec('COMMIT'); return results;
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  return { sqlite, db };
}
const assign = (provider, feature = 'assistant', model = 'vision-test', supportsImages = true, expectedRevision = 0) => ({
  feature, providerId: provider.id, providerRevision: provider.revision, model, supportsImages, expectedRevision });

test('0011 backfills independent feature models without changing keys, IDs, assignments or options; upgrade is idempotent', async t => {
  const { db, sqlite } = fixture(t, true);
  const old = await createAiProfile(db, 'admin', { name: 'Old', source: 'openai', protocol: 'chat_completions', model: 'old-model', apiKey: 'private-old', supportsImages: true, generationOptions: { temperature: 0.3 } }, env);
  await assignAiProfile(db, 'admin', 'assistant', old.id, 0); await assignAiProfile(db, 'admin', 'lyrics', old.id, 0);
  const before = sqlite.prepare('SELECT * FROM ai_model_profiles').get();
  const assignments = sqlite.prepare('SELECT * FROM ai_feature_assignments ORDER BY feature').all();
  assert.equal((await listAiProviders(db, 'admin', env)).ready, false);
  await assert.rejects(createAiProvider(db, 'admin', { source: 'deepseek', apiKey: 'fake' }, env), { code: 'ai_provider_migration_required' });
  await runKnownDatabaseUpgrade(db);
  assert.deepEqual(sqlite.prepare('SELECT * FROM ai_model_profiles').get(), before);
  assert.deepEqual(sqlite.prepare('SELECT * FROM ai_feature_assignments ORDER BY feature').all(), assignments);
  const features = (await listAiProviders(db, 'admin', env)).features;
  assert.equal(features.assistant.model, 'old-model'); assert.equal(features.lyrics.supportsImages, true);
  assert.deepEqual(features.lyrics.generationOptions, { temperature: 0.3 });
  const resolved = await resolveAiFeature(db, 'assistant', env, {});
  assert.equal(resolved.config.protocol, 'chat_completions'); assert.equal(resolved.env.AI_PROFILE_API_KEY, 'private-old');
  await runKnownDatabaseUpgrade(db); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM ai_feature_models').get().n, 2);
});
test('official connections need only Key with optional display name, pin destination and omit model/protocol fields in provider DTO', async t => {
  const { db } = fixture(t);
  for (const source of ['deepseek', 'openai', 'anthropic', 'gemini']) {
    const provider = await createAiProvider(db, 'admin', { source, apiKey: `fake-${source}` }, env);
    assert.equal(provider.source, source); assert.equal(provider.hasKey, true);
    assert.equal(provider.model, undefined); assert.equal(provider.protocol, undefined); assert.equal(provider.baseUrl, undefined);
    await assert.rejects(createAiProvider(db, 'admin', { source, apiKey: 'fake', baseUrl: 'https://attacker.example' }, env), { code: 'invalid_ai_provider' });
    await assert.rejects(updateAiProvider(db, 'admin', provider.id, { source, protocol: 'chat_completions' }, 1, env), { code: 'invalid_ai_provider' });
  }
  assert.doesNotMatch(JSON.stringify(await listAiProviders(db, 'admin', env)), /fake-|encrypted_key|key_iv/);
});
test('same provider serves independent models and vision states; provider Key retention and CAS remain intact', async t => {
  const { db, sqlite } = fixture(t);
  const provider = await createAiProvider(db, 'admin', { source: 'openai', apiKey: 'saved-key' }, env);
  await saveAiFeatureModel(db, 'admin', assign(provider), env);
  await saveAiFeatureModel(db, 'admin', assign(provider, 'lyrics', 'text-test', false), env);
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).config.model, 'vision-test');
  assert.equal((await resolveAiFeature(db, 'lyrics', env, {})).config.supportsImages, false);
  await assert.rejects(assignAiProfile(db, 'admin', 'assistant', provider.id, 1), { code: 'ai_feature_model_required' });
  await assert.rejects(deleteAiProvider(db, 'admin', provider.id, 1), { status: 409 });
  const encrypted = sqlite.prepare('SELECT encrypted_key FROM ai_model_profiles').get().encrypted_key;
  const updated = await updateAiProvider(db, 'admin', provider.id, { source: 'openai', apiKey: '' }, 1, env);
  assert.equal(sqlite.prepare('SELECT encrypted_key FROM ai_model_profiles').get().encrypted_key, encrypted);
  await assert.rejects(saveAiFeatureModel(db, 'admin', assign(provider, 'assistant', 'wrong', false, 1), env), { code: 'revision_conflict' });
  await assert.rejects(saveAiFeatureModel(db, 'admin', assign(updated, 'assistant', 'wrong', false, 0), env), { code: 'revision_conflict' });
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).config.model, 'vision-test');
  await saveAiFeatureModel(db, 'admin', assign(updated, 'assistant', 'new', false, 1), env);
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).config.featureRevision, 2);
  await saveAiFeatureModel(db, 'admin', { feature: 'assistant', providerId: null, expectedRevision: 2 }, env);
  assert.equal(await resolveAiFeature(db, 'assistant', env, {}), null);
  await saveAiFeatureModel(db, 'admin', { feature: 'lyrics', providerId: null, expectedRevision: 1 }, env);
  await deleteAiProvider(db, 'admin', provider.id, 2);
});
test('two named official providers coexist with separate keys; renaming preserves binding and feature assignments', async t => {
  const { db, sqlite } = fixture(t);
  const first = await createAiProvider(db, 'admin', { source: 'deepseek', name: 'Primary DeepSeek', apiKey: 'first-test-key' }, env);
  const second = await createAiProvider(db, 'admin', { source: 'deepseek', name: 'Backup DeepSeek', apiKey: 'second-test-key' }, env);
  assert.notEqual(first.id, second.id);
  await saveAiFeatureModel(db, 'admin', assign(first, 'assistant', 'first-model', false), env);
  await saveAiFeatureModel(db, 'admin', assign(second, 'lyrics', 'second-model', false), env);
  const before = sqlite.prepare('SELECT * FROM ai_model_profiles WHERE id = ?').get(first.id);
  const features = sqlite.prepare('SELECT * FROM ai_feature_models ORDER BY feature').all();
  await updateAiProvider(db, 'admin', first.id, { source: 'deepseek', name: 'Renamed Primary', apiKey: '' }, first.revision, env);
  const after = sqlite.prepare('SELECT * FROM ai_model_profiles WHERE id = ?').get(first.id);
  assert.equal(after.name, 'Renamed Primary');
  for (const field of ['encrypted_key', 'key_iv', 'base_url', 'model', 'provider']) assert.equal(after[field], before[field]);
  assert.deepEqual(sqlite.prepare('SELECT * FROM ai_feature_models ORDER BY feature').all(), features);
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).env.AI_PROFILE_API_KEY, 'first-test-key');
  assert.equal((await resolveAiFeature(db, 'lyrics', env, {})).env.AI_PROFILE_API_KEY, 'second-test-key');
  assert.deepEqual((await listAiProviders(db, 'admin', env)).providers.map(item => item.name).sort(), ['Backup DeepSeek', 'Renamed Primary']);
  await assert.rejects(updateAiProvider(db, 'admin', first.id, { source: 'deepseek', name: {} }, 2, env), { code: 'invalid_ai_profile' });
  await assert.rejects(updateAiProvider(db, 'admin', first.id, { source: 'deepseek', name: 'x', baseUrl: 'https://evil.example' }, 2, env), { code: 'invalid_ai_provider' });
});
test('historical proxy is shown as custom and retains bound key; changing destination requires Key and atomically clears vision/options', async t => {
  const { db, sqlite } = fixture(t);
  const old = await createAiProfile(db, 'admin', { source: 'deepseek', name: 'Proxy', model: 'old', baseUrl: 'https://proxy.example/v1', apiKey: 'bound-key', supportsImages: true }, env);
  await assignAiProfile(db, 'admin', 'assistant', old.id, 0);
  const provider = (await listAiProviders(db, 'admin', env)).providers[0]; assert.equal(provider.source, 'custom');
  const draft = { source: 'custom', name: 'Renamed proxy', baseUrl: provider.baseUrl, protocol: provider.protocol, apiKey: '' };
  await updateAiProvider(db, 'admin', old.id, draft, 1, env);
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).env.AI_PROFILE_API_KEY, 'bound-key');
  await assert.rejects(updateAiProvider(db, 'admin', old.id, { ...draft, baseUrl: 'https://other.example/v1' }, 2, env), { code: 'ai_profile_key_required' });
  await updateAiProvider(db, 'admin', old.id, { ...draft, baseUrl: 'https://other.example/v1', apiKey: 'new-bound-key' }, 2, env);
  const resolved = await resolveAiFeature(db, 'assistant', env, {});
  assert.equal(resolved.config.supportsImages, false); assert.equal(resolved.config.featureRevision, 2);
  assert.equal(resolved.env.AI_PROFILE_BASE_URL, 'https://other.example/v1');
  assert.equal(sqlite.prepare('SELECT supports_images FROM ai_feature_models').get().supports_images, 0);
  await assert.rejects(updateAiProvider(db, 'admin', old.id, { ...draft, apiKey: 'stale-key' }, 2, env), { code: 'revision_conflict' });
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).config.featureRevision, 2);
});
test('provider model lookup uses saved binding only, revision checks and protocol-native headers/list parsing', async t => {
  const { db } = fixture(t);
  for (const source of ['deepseek', 'openai', 'anthropic', 'gemini']) {
    const provider = await createAiProvider(db, 'admin', { source, apiKey: `key-${source}` }, env);
    const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
      const urls = { deepseek: 'https://api.deepseek.com/models', openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models', gemini: 'https://generativelanguage.googleapis.com/v1beta/models' };
      assert.equal(url, urls[source]); assert.equal(init.redirect, 'manual');
      assert.equal(init.headers[source === 'gemini' ? 'x-goog-api-key' : source === 'anthropic' ? 'x-api-key' : 'Authorization'], source === 'gemini' || source === 'anthropic' ? `key-${source}` : `Bearer key-${source}`);
      return Response.json(source === 'gemini' ? { models: [{ name: 'models/gemini-fixture' }], nextPageToken: 'more' } : { data: [{ id: 'model-a' }, { id: 'model-a' }] });
    });
    const result = await listAiProviderModels(db, 'admin', { providerId: provider.id, expectedRevision: 1 }, env);
    assert.deepEqual(result.models, [source === 'gemini' ? 'gemini-fixture' : 'model-a']); assert.equal(result.verifiedCapabilities, false);
    await assert.rejects(listAiProviderModels(db, 'admin', { providerId: provider.id, expectedRevision: 1, baseUrl: 'https://evil.example' }, env), { code: 'invalid_ai_provider' });
    await assert.rejects(listAiProviderModels(db, 'admin', { providerId: provider.id, expectedRevision: 2 }, env), { code: 'revision_conflict' });
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});
for (const [status, code] of [[401, 'ai_model_list_auth_failed'], [403, 'ai_model_list_auth_failed'], [429, 'ai_model_list_rate_limited'], [404, 'ai_model_list_unsupported'], [500, 'ai_model_list_http_500']]) test(`model list safely classifies upstream ${status}`, async t => {
  const { db } = fixture(t); const provider = await createAiProvider(db, 'admin', { source: 'deepseek', apiKey: 'secret-never-log' }, env);
  t.mock.method(globalThis, 'fetch', async () => new Response('secret-never-log private provider body', { status }));
  await assert.rejects(listAiProviderModels(db, 'admin', { providerId: provider.id, expectedRevision: 1 }, env), error => error.code === code && !JSON.stringify(error).includes('secret-never-log'));
});
test('model discovery distinguishes network failure from malformed responses without exposing details', async t => {
  const { db } = fixture(t); const provider = await createAiProvider(db, 'admin', { source: 'deepseek', apiKey: 'fake' }, env);
  const input = { providerId: provider.id, expectedRevision: 1 };
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-network-detail'); });
  await assert.rejects(listAiProviderModels(db, 'admin', input, env), { code: 'ai_model_list_network_failed' });
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response('private-invalid-body'));
  await assert.rejects(listAiProviderModels(db, 'admin', input, env), { code: 'ai_model_list_invalid_response' });
});
test('member cannot read or mutate provider/feature settings or fetch models', async t => {
  const { db } = fixture(t); const provider = await createAiProvider(db, 'admin', { source: 'deepseek', apiKey: 'fake' }, env);
  for (const run of [() => listAiProviders(db, 'member', env), () => createAiProvider(db, 'member', { source: 'openai', apiKey: 'fake' }, env),
    () => updateAiProvider(db, 'member', provider.id, { source: 'deepseek' }, 1, env), () => deleteAiProvider(db, 'member', provider.id, 1),
    () => saveAiFeatureModel(db, 'member', assign(provider), env), () => listAiProviderModels(db, 'member', { providerId: provider.id, expectedRevision: 1 }, env)]) await assert.rejects(run(), { code: 'forbidden' });
});
test('model list deadline is bounded and safely classified', async t => {
  const { db } = fixture(t); const provider = await createAiProvider(db, 'admin', { source: 'deepseek', apiKey: 'fake' }, env);
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => original(fn, delay === 10000 ? 0 : delay, ...args));
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  await assert.rejects(listAiProviderModels(db, 'admin', { providerId: provider.id, expectedRevision: 1 }, env), { code: 'ai_model_list_timeout' });
});
test('feature storage failure rolls back assignment, model and audit together', async t => {
  const { db, sqlite } = fixture(t); const provider = await createAiProvider(db, 'admin', { source: 'openai', apiKey: 'fake' }, env);
  await saveAiFeatureModel(db, 'admin', assign(provider), env);
  const previous = sqlite.prepare('SELECT * FROM ai_feature_models').get();
  const audits = sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
  const original = db.batch.bind(db);
  t.mock.method(db, 'batch', statements => original([...statements, db.prepare('INSERT INTO nonexistent_table VALUES (1)')]));
  await assert.rejects(saveAiFeatureModel(db, 'admin', assign(provider, 'assistant', 'bad', false, 1), env));
  assert.equal(sqlite.prepare('SELECT revision FROM ai_feature_assignments').get().revision, 1);
  assert.deepEqual(sqlite.prepare('SELECT * FROM ai_feature_models').get(), previous);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, audits);
});
test('legacy profile edit cannot falsely report model/vision/options changes after separation', async t => {
  const { db, sqlite } = fixture(t);
  const old = await createAiProfile(db, 'admin', { name: 'Old', source: 'deepseek', model: 'old-model', apiKey: 'fake', supportsImages: true }, env);
  await assignAiProfile(db, 'admin', 'assistant', old.id, 0);
  await saveAiFeatureModel(db, 'admin', { feature: 'lyrics', providerId: old.id, providerRevision: 1,
    expectedRevision: 0, model: 'independent-model', supportsImages: false }, env);
  sqlite.exec("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('assistant.images_enabled','true',1,1,'admin')");
  const draft = { name: 'Old', source: 'deepseek', model: 'old-model', supportsImages: true, apiKey: '' };
  for (const patch of [{ model: 'new-model', supportsImages: false }, { supportsImages: false }, { generationOptions: { temperature: 0.8 } }]) {
    await assert.rejects(updateAiProfile(db, 'admin', old.id, { ...draft, ...patch }, 1, env), { code: 'ai_feature_configuration_required' });
  }
  assert.equal(sqlite.prepare('SELECT revision FROM ai_model_profiles').get().revision, 1);
  assert.equal((await assistantImagePolicy(db)).enabled, true);
  assert.equal((await resolveAiFeature(db, 'lyrics', env, {})).config.model, 'independent-model');
  await updateAiProfile(db, 'admin', old.id, { ...draft, name: 'Renamed', apiKey: 'replacement-fake' }, 1, env);
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).env.AI_PROFILE_API_KEY, 'replacement-fake');
  await saveAiFeatureModel(db, 'admin', { feature: 'assistant', providerId: old.id, providerRevision: 2,
    expectedRevision: 1, model: 'new-model', supportsImages: false }, env);
  assert.equal((await assistantImagePolicy(db)).enabled, false);
});
test('legacy edit CAS rejects a feature overlay created after its precheck', async t => {
  const { db, sqlite } = fixture(t);
  const old = await createAiProfile(db, 'admin', { name: 'Race', source: 'deepseek', model: 'old', apiKey: 'fake', supportsImages: true }, env);
  const original = db.batch.bind(db);
  t.mock.method(db, 'batch', statements => {
    sqlite.prepare("INSERT INTO ai_feature_assignments(feature,profile_id,revision,updated_at,updated_by) VALUES ('assistant',?,1,1,'admin')").run(old.id);
    sqlite.prepare("INSERT INTO ai_feature_models(feature,provider_id,model,supports_images) VALUES ('assistant',?,'old',1)").run(old.id);
    return original(statements);
  });
  await assert.rejects(updateAiProfile(db, 'admin', old.id, { name: 'Race', source: 'deepseek', model: 'new', supportsImages: false, apiKey: '' }, 1, env), { code: 'revision_conflict' });
  const row = sqlite.prepare('SELECT model,revision FROM ai_model_profiles').get(); assert.equal(row.model, 'old'); assert.equal(row.revision, 1);
});
test('pre-0011 legacy edits fail explicitly while assigned legacy text config remains readable', async t => {
  const { db, sqlite } = fixture(t, true);
  const old = await createAiProfile(db, 'admin', { name: 'Legacy', source: 'deepseek', model: 'old', apiKey: 'fake', supportsImages: true }, env);
  await assignAiProfile(db, 'admin', 'assistant', old.id, 0);
  const mock = t.mock.method(db, 'batch', async () => { throw new Error('An edit must not start before migration'); });
  await assert.rejects(updateAiProfile(db, 'admin', old.id, { name: 'Legacy', source: 'deepseek', model: 'new', supportsImages: false, apiKey: '' }, 1, env), { code: 'ai_provider_migration_required' });
  assert.equal(mock.mock.callCount(), 0); mock.mock.restore();
  assert.equal((await resolveAiFeature(db, 'assistant', env, {})).config.model, 'old');
  await runKnownDatabaseUpgrade(db);
  assert.equal(sqlite.prepare('SELECT model FROM ai_feature_models').get().model, 'old');
});
test('vision is feature-specific and remains bounded by the global gate', async t => {
  const { db, sqlite } = fixture(t); const provider = await createAiProvider(db, 'admin', { source: 'deepseek', apiKey: 'fake' }, env);
  await saveAiFeatureModel(db, 'admin', assign(provider), env); assert.equal((await assistantImagePolicy(db)).enabled, false);
  sqlite.exec("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('assistant.images_enabled','true',1,1,'admin')");
  assert.equal((await assistantImagePolicy(db)).enabled, true);
  await saveAiFeatureModel(db, 'admin', assign(provider, 'assistant', 'text', false, 1), env);
  assert.equal((await assistantImagePolicy(db)).enabled, false); assert.equal((await assistantImagePolicy(db)).featureRevision, 2);
});
