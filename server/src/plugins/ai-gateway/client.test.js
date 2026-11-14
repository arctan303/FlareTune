import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../subsonic/test-support.js';
import { createPluginRegistry } from '../registry.js';
import { createPluginContext } from '../context.js';
import { createPluginServiceLease } from '../services.js';
import { createAiGatewayClient } from './client.js';
import { createAiProvider, saveAiFeatureModel } from './aiProviders.js';
import { createAiGatewayHandler } from './handler.js';

const gateway = { id: 'ai-gateway', name: 'Gateway', description: 'Test gateway', icon: 'settings', version: '0.1.0', hostApiVersion: 1, apiVersion: 1,
  capabilityRoles: ['admin'], pages: [{ id: 'configuration', kind: 'settings', scope: 'instance', roles: ['admin'], label: 'Configuration', icon: 'settings' }], entries: [] };
const consumer = { id: 'assistant', name: 'Assistant', description: 'Test assistant', icon: 'bot', version: '0.1.0', hostApiVersion: 1, apiVersion: 1,
  capabilityRoles: ['admin', 'member'], dependencies: { 'ai-gateway': { apiVersion: 1 } }, pages: [], entries: [] };
const { dependencies: ignoredRequired, ...optionalConsumer } = consumer;
const lyrics = { ...optionalConsumer, id: 'lyrics-workbench',
  optionalDependencies: { 'ai-gateway': { apiVersion: 1, features: ['ai'] } } };
async function app(t, { install = true, manifests = [gateway, consumer, lyrics] } = {}) {
  const f = await fixture(); t.after(() => f.close());
  f.env.DEEPSEEK_API_KEY = 'gateway-legacy-private-key';
  const registry = createPluginRegistry({ manifests, deployment: null });
  const set = async (id, installed) => registry.setInstalled(f.env, f.signed.session, id,
    { installed, revision: (await registry.readInstallation(f.env, id)).revision });
  if (install) { await set('ai-gateway', true); await set('assistant', true); await set('lyrics-workbench', true); }
  const member = await f.signIn('member');
  const options = { env: f.env, session: member.session, consumerId: 'assistant', feature: 'assistant', registry,
    legacyConfig: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0.2 } };
  return { ...f, registry, member, options, set };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('Gateway is absent by default and member consumption never grants direct administration', async t => {
  const f = await app(t, { install: false });
  await assert.rejects(createAiGatewayClient(f.options), { code: 'PLUGIN_NOT_INSTALLED' });
  await f.set('ai-gateway', true); await f.set('assistant', true);
  await assert.rejects(createPluginContext({ env: f.env, session: f.member.session, pluginId: 'ai-gateway', registry: f.registry }), { code: 'forbidden' });
  const client = await createAiGatewayClient(f.options, { chat: async () => ({ text: 'yes' }) });
  assert.deepEqual(await client.chat([], []), { text: 'yes' });
  const context = await createPluginContext({ env: f.env, session: f.signed.session, pluginId: 'ai-gateway', registry: f.registry });
  const handle = createAiGatewayHandler(f.env, f.signed.session, { registry: f.registry });
  const response = await handle({ request: new Request('https://test/providers'), path: '/providers', scope: 'admin', context, json });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /gateway-legacy-private-key|encrypted_key|key_iv/);
  const saveLegacy = await handle({ request: new Request('https://test/legacy-setting', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'ai.compatible_api_url', value: 'https://gateway.example/v1', expectedRevision: 0 }) }),
    path: '/legacy-setting', scope: 'admin', context, json });
  assert.equal(saveLegacy.status, 200);
  assert.equal((await saveLegacy.json()).key, 'ai.compatible_api_url');
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT value_json FROM instance_settings WHERE key='ai.compatible_api_url'").get().value_json), 'https://gateway.example/v1');
});

test('credential resolution stays in Gateway and only safe config/model identity reach the consumer', async t => {
  const f = await app(t);
  const provider = await createAiProvider(f.env.DB, f.owner, { source: 'deepseek', name: 'Test', apiKey: 'gateway-db-private-key' }, f.env);
  await saveAiFeatureModel(f.env.DB, f.owner, { feature: 'assistant', providerId: provider.id,
    providerRevision: provider.revision, expectedRevision: 0, model: 'deepseek-chat', supportsImages: true }, f.env);
  let execution;
  const client = await createAiGatewayClient(f.options, { chat: async (messages, tools, config, env) => {
    execution = { config, key: env.AI_PROFILE_API_KEY }; return { text: 'answer' };
  } });
  assert.equal(client.config.profileId, provider.id);
  assert.equal(client.config.supportsImages, true);
  assert.equal(Object.hasOwn(client, 'env'), false);
  assert.doesNotMatch(JSON.stringify(client), /gateway-db-private-key|gateway-legacy-private-key|AI_PROFILE_API_KEY/);
  assert.doesNotMatch(client.identity, /private-key/);
  assert.ok(Object.isFrozen(client.config));
  await client.chat([{ role: 'user', content: 'hi' }], [], { enableThinking: false });
  assert.equal(execution.key, undefined, 'public executor injection cannot receive gateway credentials');
  assert.equal(execution.config.enableThinking, false);
  await assert.rejects(client.chat([], [], { provider: 'openai' }), { code: 'PLUGIN_SERVICE_OVERRIDE_FORBIDDEN' });
});

test('consumer/feature and declaration compatibility are enforced before execution', async t => {
  const f = await app(t);
  await assert.rejects(createAiGatewayClient({ ...f.options, feature: 'lyrics' }), { code: 'PLUGIN_SERVICE_FEATURE_FORBIDDEN' });
  await assert.rejects(createPluginServiceLease({ ...f.options, consumerId: 'ai-gateway', providerId: 'assistant' }), { code: 'PLUGIN_SERVICE_UNDECLARED' });
  const registry = createPluginRegistry({ manifests: [gateway, consumer, { ...lyrics,
    optionalDependencies: { 'ai-gateway': { apiVersion: 2, features: ['ai'] } } }], deployment: null });
  await assert.rejects(createAiGatewayClient({ ...f.options, registry, consumerId: 'lyrics-workbench', feature: 'lyrics' }), { code: 'PLUGIN_SERVICE_INCOMPATIBLE' });
  const valid = await createAiGatewayClient({ ...f.options, consumerId: 'lyrics-workbench', feature: 'lyrics' }, { ask: async () => 'translated' });
  assert.equal(await valid.ask([]), 'translated');
});

test('missing legacy key and invalid legacy URL fail before an upstream call or business reservation', async t => {
  const f = await app(t); delete f.env.DEEPSEEK_API_KEY;
  await assert.rejects(createAiGatewayClient(f.options), /AI_PROVIDER_UNCONFIGURED/);
  f.env.OPENAI_API_KEY = 'gateway-openai-private-key';
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?key=abc', 'https://example.com#fragment', 123]) {
    f.sqlite.prepare("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('ai.compatible_api_url',?,1,1,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
      .run(JSON.stringify(url), f.owner);
    await assert.rejects(createAiGatewayClient({ ...f.options, legacyConfig: { provider: 'openai', model: 'gpt-test' } }));
  }
});

test('retired consumer, provider generation or revoked session rejects late results and further calls', async t => {
  for (const reason of ['consumer', 'provider', 'session']) await t.test(reason, async t => {
    const f = await app(t); let resolve;
    const client = await createAiGatewayClient(f.options, { chat: () => new Promise(done => { resolve = done; }) });
    const result = client.chat([], []);
    while (!resolve) await new Promise(done => setImmediate(done));
    if (reason === 'session') f.sqlite.exec('UPDATE account_sessions SET revoked_at=1');
    else f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(
      JSON.stringify({ installed: true, epoch: crypto.randomUUID() }), `plugin.installation.${reason === 'consumer' ? 'assistant' : 'ai-gateway'}`);
    resolve({ text: 'late' });
    await assert.rejects(result);
    await assert.rejects(client.chat([], []));
  });
});

test('the active request is aborted and no delayed stream callback escapes a retired capability', async t => {
  const f = await app(t); const output = []; let started;
  const begin = new Promise(done => { started = done; });
  const client = await createAiGatewayClient(f.options, { pollIntervalMs: 5,
    chat: async (messages, tools, config, env, options) => {
      started();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        options.onContentDelta('must not appear'); reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true }));
    } });
  const request = client.chat([], [], {}, { onContentDelta: text => output.push(text) });
  await begin; await f.set('assistant', false);
  await assert.rejects(request);
  await new Promise(done => setImmediate(done));
  assert.deepEqual(output, []);
});

test('service writes reject an epoch changed between authorization and the D1 transaction', async t => {
  const f = await app(t);
  const client = await createAiGatewayClient(f.options);
  const db = client.guardedDb(f.env.DB), batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = async statements => {
    f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(
      JSON.stringify({ installed: true, epoch: crypto.randomUUID() }), 'plugin.installation.ai-gateway');
    return batch(statements);
  };
  await assert.rejects(db.prepare("INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES ('gateway.test','true',1,1,?)").bind(f.owner).run());
  assert.equal(f.sqlite.prepare("SELECT 1 FROM instance_settings WHERE key='gateway.test'").get(), undefined);
});

test('live service checks use one authorization query without caching a revoked session', async t => {
  const f = await app(t); const client = await createAiGatewayClient(f.options);
  f.db.queries.length = 0;
  await client.assertCurrent();
  assert.equal(f.db.queries.length, 1);
  const before = f.db.queries.length;
  const row = await client.guardedDb(f.db).prepare('SELECT title FROM Songs WHERE id=?').bind('s1').first();
  assert.ok(row.title);
  assert.equal(f.db.queries.length - before, 3, 'one query before/after the actual business read');
  f.sqlite.exec('UPDATE account_sessions SET revoked_at=1');
  await assert.rejects(client.assertCurrent(), { code: 'forbidden' });
});

test('uninstall during an administrator model-list request rejects the delayed list', async t => {
  const f = await app(t);
  await f.set('assistant', false);
  const provider = await createAiProvider(f.db, f.owner, { source: 'deepseek', apiKey: 'gateway-list-private-key' }, f.env);
  const context = await createPluginContext({ env: f.env, session: f.signed.session, pluginId: 'ai-gateway', registry: f.registry });
  let respond, started;
  const original = globalThis.fetch;
  const begin = new Promise(done => { started = done; });
  globalThis.fetch = () => { started(); return new Promise(done => { respond = done; }); };
  t.after(() => { globalThis.fetch = original; });
  const handle = createAiGatewayHandler(f.env, f.signed.session, { registry: f.registry });
  const pending = handle({ request: new Request('https://test/provider-models', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: provider.id, expectedRevision: provider.revision }) }), path: '/provider-models', scope: 'admin', context, json });
  await begin; await f.set('ai-gateway', false);
  respond(new Response(JSON.stringify({ data: [{ id: 'safe-model' }] }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(pending, { code: 'PLUGIN_NOT_INSTALLED' });
});

test('a trusted request service lease is reused without a second registry snapshot', async t => {
  const f = await app(t); let snapshots = 0;
  const registry = { ...f.registry, requirePluginsInstalled: async (...args) => {
    snapshots += 1; return f.registry.requirePluginsInstalled(...args);
  } };
  const options = { ...f.options, registry };
  const lease = await createPluginServiceLease({ ...options, providerId: 'ai-gateway' });
  assert.equal(snapshots, 1);
  const client = await createAiGatewayClient({ ...options, serviceLease: lease }, { chat: async () => ({ text: 'yes' }) });
  assert.equal(snapshots, 1);
  assert.deepEqual(await client.chat([], []), { text: 'yes' });
  await assert.rejects(createAiGatewayClient({ ...options, serviceLease: { ...lease } }), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
});
