import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentBuildConfig, prepareDevelopmentBuildConfig } from './dev-build-config.mjs';

const database = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const version = () => ({ resources: { bindings: [
  { name: 'DB', type: 'd1', id: database },
  { name: 'MEDIA_BUCKET', type: 'r2_bucket', bucket_name: 'synthetic-development-media' },
  { name: 'YTM_KV', type: 'kv_namespace', namespace_id: 'a'.repeat(32) },
  { name: 'YTM_RUNTIME', type: 'durable_object_namespace', namespace_id: 'b'.repeat(32), class_name: 'YouTubeRuntime', script_name: 'flaretune-dev' },
  { name: 'API', type: 'service', service: 'synthetic-api', environment: 'production', entrypoint: 'ReadOnlyApi' },
  { name: 'SETUP_SECRET', type: 'secret_text' }, { name: 'ASSETS', type: 'assets' },
  { name: 'OPTIONS', type: 'json', json: { enabled: true } },
  { name: 'MEDIA_PREFIX', type: 'plain_text', text: 'synthetic-existing-value' },
] } });
const options = { root: '/synthetic', accountId: 'a'.repeat(32),
  template: { compatibility_date: '2026-09-23', compatibility_flags: [], assets: { binding: 'ASSETS', not_found_handling: 'single-page-application' },
    observability: { enabled: true }, migrations: [{ tag: 'yt-runtime-v1', new_sqlite_classes: ['YouTubeRuntime'] }] },
  verifyDatabaseImpl: id => id === database };

test('private dev config preserves actual resource identities and variables while leaving secrets inherited', () => {
  const config = developmentBuildConfig(version(), options);
  assert.equal(config.name, 'flaretune-dev');
  assert.equal(config.keep_vars, true);
  assert.equal(config.d1_databases[0].database_id, database);
  assert.equal(config.kv_namespaces[0].id, 'a'.repeat(32));
  assert.equal(config.r2_buckets[0].bucket_name, 'synthetic-development-media');
  assert.deepEqual(config.vars, { OPTIONS: { enabled: true }, MEDIA_PREFIX: 'synthetic-existing-value' });
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'YTM_RUNTIME', class_name: 'YouTubeRuntime' }]);
  assert.equal(config.services[0].entrypoint, 'ReadOnlyApi');
  assert.deepEqual(config.migrations, options.template.migrations);
  assert.ok(!JSON.stringify(config).includes('SETUP_SECRET'));
  assert.equal(options.template.assets.directory, undefined);
});

test('default development pin rejects a foreign database and unsupported bindings fail closed', () => {
  assert.throws(() => developmentBuildConfig(version(), { ...options, verifyDatabaseImpl: undefined }), { code: 'PLUGIN_DEV_DATABASE_MISMATCH' });
  for (const type of ['queue', 'hyperdrive', 'inherit']) {
    const next = version(); next.resources.bindings.push({ name: 'NEW_BINDING', type });
    assert.throws(() => developmentBuildConfig(next, options), /^Error: PLUGIN_/);
  }
  const next = version(); next.resources.bindings.find(binding => binding.name === 'ASSETS').name = 'OTHER_ASSETS';
  assert.throws(() => developmentBuildConfig(next, options), { code: 'PLUGIN_DEV_CONFIG_INVALID' });
});

test('wrong target is rejected before any provider call', async () => {
  let calls = 0;
  await assert.rejects(prepareDevelopmentBuildConfig({ environment: { FLARETUNE_PLUGIN_WORKER_NAME: 'flaretune',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-cloud-token-not-a-secret' },
    fetchImpl: async () => { calls++; } }), { code: 'PLUGIN_DEPLOY_TARGET_MISMATCH' });
  assert.equal(calls, 0);
});

test('mixed live binding baselines are rejected using read-only provider requests', async () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const methods = [];
  await assert.rejects(prepareDevelopmentBuildConfig({ environment: { FLARETUNE_PLUGIN_WORKER_NAME: 'flaretune-dev',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-cloud-token-not-a-secret' },
    fetchImpl: async (url, init) => {
      methods.push(init.method);
      if (url.endsWith('/deployments')) return Response.json({ success: true, result: { deployments: [{
        id: '33333333-3333-4333-8333-333333333333', strategy: 'percentage',
        versions: [{ version_id: first, percentage: 50 }, { version_id: second, percentage: 50 }],
      }] } });
      const current = version();
      current.id = url.endsWith(first) ? first : second;
      if (current.id === second) current.resources.bindings.find(binding => binding.name === 'YTM_KV').namespace_id = 'c'.repeat(32);
      return Response.json({ success: true, result: current });
    }, readTemplateImpl: async () => { throw new Error('Must stop before preparing a config.'); },
  }), { code: 'PLUGIN_DEPLOY_BINDINGS_MISMATCH' });
  assert.deepEqual(methods, ['GET', 'GET', 'GET']);
});
