import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deliveryPlanDigest } from './assemble.mjs';
import { createPluginHostBuild } from './host-identity.mjs';
import { deploymentTarget, deployPluginDelivery, uploadedVersion, workerVersionBindingsDigest } from './delivery-deploy.mjs';

const BUILD = '895c1cb8-cea8-4f32-abf7-b324191005c8';
const OLD = '4032d7c5-570f-4415-b53a-26bcb45bd160';
const NEXT = 'cc8fc558-6860-4e2c-9a2b-422b8bbc392b';
const FOREIGN = 'ae0c58f8-b7db-4373-81ee-4f2b81147092';
const OLD_DEPLOYMENT = '041c09e0-2432-4428-b266-120f055873d6';
const NEXT_DEPLOYMENT = '97fd7ef2-5645-4d8b-b0ba-6a065292336b';
const environment = { FLARETUNE_PLUGIN_SITE_URL: 'https://music.example.net',
  FLARETUNE_PLUGIN_BUILD_TOKEN: 'synthetic-build-token-that-is-not-a-real-secret',
  FLARETUNE_PLUGIN_WORKER_NAME: 'synthetic-worker', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-provider-token-123456' };
const response = (result, status = 200) => new Response(JSON.stringify(result), { status });
const deployed = (id, version) => ({ id, strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }] });
const instanceBindings = () => [
  { name: 'DB', type: 'd1', id: OLD },
  { name: 'MEDIA_BUCKET', type: 'r2_bucket', bucket_name: 'synthetic-media' },
  { name: 'CACHE', type: 'kv_namespace', namespace_id: 'c'.repeat(32) },
  { name: 'GATEWAY', type: 'service', service: 'synthetic-gateway', environment: 'production' },
  { name: 'YTM_RUNTIME', type: 'durable_object_namespace', namespace_id: 'd'.repeat(32), class_name: 'YouTubeRuntime', script_name: 'synthetic-worker' },
  { name: 'SETUP_SECRET', type: 'secret_text' },
  { name: 'MEDIA_PREFIX', type: 'plain_text', text: 'synthetic-sensitive-var-value' },
  { name: 'OPTIONS', type: 'json', json: { enabled: true, languages: ['en'] } },
  { name: 'ASSETS', type: 'assets' },
];

async function fixture(t, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-deploy-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'shared/plugins'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), '{"type":"module","version":"1.2.1"}');
  await writeFile(resolve(root, 'package-lock.json'), '{}');
  const host = await createPluginHostBuild(root);
  const snapshot = { schemaVersion: 1, buildId: BUILD, host, plugins: [], buildStatus: 'building', target: { workerName: environment.FLARETUNE_PLUGIN_WORKER_NAME } };
  snapshot.planDigest = deliveryPlanDigest(snapshot);
  const metadata = { buildId: BUILD, planDigest: snapshot.planDigest, host, plugins: [] };
  await writeFile(resolve(root, 'shared/plugins/delivery.generated.js'), `export const pluginDeployment = ${JSON.stringify(metadata)};`);
  await writeFile(resolve(root, 'plugins.lock.json'), JSON.stringify({ host }));
  const config = { name: environment.FLARETUNE_PLUGIN_WORKER_NAME, account_id: environment.CLOUDFLARE_ACCOUNT_ID,
    main: resolve(root, 'server/src/flaretune.js'), d1_databases: [{ binding: 'DB', database_id: OLD }],
    r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'synthetic-media' }], services: [{ binding: 'GATEWAY', service: 'synthetic-gateway', environment: 'production' }] };
  const state = { snapshot, current: deployed(OLD_DEPLOYMENT, OLD), bindings: instanceBindings(),
    calls: [], reports: [], uploads: 0, promotions: [], acknowledgements: 0 };
  const fetchImpl = async (url, init) => {
    state.calls.push({ url, init });
    if (url.startsWith(environment.FLARETUNE_PLUGIN_SITE_URL)) {
      assert.equal(init.headers.Authorization, `Bearer ${environment.FLARETUNE_PLUGIN_BUILD_TOKEN}`);
      if (url.endsWith('/snapshot')) {
        if (options.snapshotUnavailableAfterActivation && state.acknowledgements > 0) throw new TypeError('synthetic network response lost');
        return response(state.snapshot);
      }
      const body = JSON.parse(init.body); state.reports.push(body);
      if (body.buildId !== state.snapshot.buildId) return response({ error: 'PLUGIN_BUILD_CHANGED' }, 409);
      if (body.status === 'deployed') {
        state.acknowledgements++;
        if (options.rejectActivation) return response({ error: 'PLUGIN_DEPLOYMENT_NOT_READY' }, 409);
        if (options.activationUnknown) throw new TypeError('synthetic callback response lost');
        state.snapshot.buildStatus = 'deployed';
        if (options.loseFirstAcknowledgement && state.acknowledgements === 1) throw new TypeError('synthetic response lost after database commit');
      } else if (body.status === 'rolling_back') {
        if (options.concurrentActivationBeforeRollback) {
          state.snapshot.buildStatus = 'deployed';
          return response({ error: 'PLUGIN_BUILD_CHANGED' }, 409);
        }
        state.snapshot.buildStatus = 'rolling_back';
      } else if (body.status === 'rolled_back') state.snapshot.buildStatus = 'failed';
      else state.snapshot.buildStatus = body.status;
      if (body.status === 'deploying') await options.afterDeployingReport?.(state);
      return response({ ok: true, status: body.status });
    }
    assert.equal(init.headers.Authorization, `Bearer ${environment.CLOUDFLARE_API_TOKEN}`);
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${environment.FLARETUNE_PLUGIN_WORKER_NAME}`));
    if (url.endsWith(`/versions/${NEXT}`)) {
      const bindings = structuredClone(state.bindings);
      bindings.find(binding => binding.name === 'DB').id = config.d1_databases[0].database_id;
      bindings.find(binding => binding.name === 'MEDIA_BUCKET').bucket_name = config.r2_buckets[0].bucket_name;
      bindings.find(binding => binding.name === 'GATEWAY').service = config.services[0].service;
      options.mutateUploadedBindings?.(bindings);
      return response({ success: true, result: { id: NEXT, resources: { bindings },
        metadata: { annotations: { 'workers/tag': `plugin-${BUILD}` } } } });
    }
    if (url.endsWith(`/versions/${OLD}`)) return response({ success: true, result: { id: OLD, resources: { bindings: state.bindings } } });
    if (url.endsWith(`/versions/${FOREIGN}`)) return response({ success: true, result: { id: FOREIGN,
      resources: { bindings: options.alternateBaselineBindings || state.bindings } } });
    if (url.endsWith('/deployments') && init.method === 'GET') return response({ success: true, result: { deployments: [state.current] } });
    if (url.endsWith('/deployments') && init.method === 'POST') {
      const body = JSON.parse(init.body); state.promotions.push(body);
      state.current = { id: NEXT_DEPLOYMENT, strategy: 'percentage', versions: body.versions };
      return response({ success: true, result: state.current });
    }
    throw new Error('Unexpected fake request');
  };
  const uploadImpl = async () => { state.uploads++; await options.afterUpload?.(state); return NEXT; };
  const execute = extra => deployPluginDelivery({ root, environment, fetchImpl, uploadImpl, readConfigImpl: async () => config, sleepImpl: async () => {}, ...extra });
  return { root, state, config, execute, fetchImpl };
}

test('controlled deployment records the actual baseline, uploads without promotion and confirms the same task', async t => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.equal(result.status, 'deployed'); assert.equal(result.versionId, NEXT);
  assert.equal(f.state.uploads, 1);
  assert.deepEqual(f.state.promotions.map(row => row.versions), [[{ version_id: NEXT, percentage: 100 }]]);
  assert.deepEqual(f.state.reports.map(row => row.status), ['deploying', 'deployed']);
  const receipt = JSON.parse(await readFile(resolve(f.root, `tooling/plugins/.delivery-recovery/${BUILD}.json`), 'utf8'));
  assert.deepEqual(receipt.previous, deployed(OLD_DEPLOYMENT, OLD));
  assert.equal(receipt.nextVersionId, NEXT); assert.equal(receipt.status, 'deployed');
  assert.equal(JSON.stringify(receipt).includes(environment.CLOUDFLARE_API_TOKEN), false);
  assert.equal(JSON.stringify(receipt).includes(environment.FLARETUNE_PLUGIN_BUILD_TOKEN), false);
  assert.equal(JSON.stringify(receipt).includes('synthetic-sensitive-var-value'), false);
  assert.equal(Object.hasOwn(receipt, 'bindings'), false);
});

test('a lost callback response is retried idempotently without rolling back a committed activation', async t => {
  const f = await fixture(t, { loseFirstAcknowledgement: true });
  assert.equal((await f.execute()).status, 'deployed');
  assert.equal(f.state.acknowledgements, 2);
  assert.equal(f.state.promotions.length, 1);
  assert.equal(f.state.current.versions[0].version_id, NEXT);
  assert.equal(f.state.reports.some(row => row.status === 'rolled_back'), false);
  assert.equal((await f.execute()).status, 'deployed', 'a later retry only confirms a terminal task');
  assert.equal(f.state.uploads, 1);
});

test('an intervening deployment during the progress report is never promoted over or rolled back', async t => {
  const f = await fixture(t, { afterDeployingReport: state => {
    state.current = deployed(NEXT_DEPLOYMENT, FOREIGN);
  } });
  await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOY_TARGET_CHANGED' });
  assert.equal(f.state.uploads, 1);
  assert.equal(f.state.current.versions[0].version_id, FOREIGN);
  assert.equal(f.state.promotions.length, 0);
  assert.deepEqual(f.state.reports.map(row => row.status), ['deploying', 'activation_pending']);
  const receipt = JSON.parse(await readFile(resolve(f.root, `tooling/plugins/.delivery-recovery/${BUILD}.json`), 'utf8'));
  assert.equal(receipt.status, 'activation_pending');
});

test('explicitly rejected activation restores only the recorded baseline and verifies it before unlocking', async t => {
  const f = await fixture(t, { rejectActivation: true });
  await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOY_ROLLED_BACK' });
  assert.equal(f.state.current.versions[0].version_id, OLD);
  assert.deepEqual(f.state.promotions.map(row => row.versions), [[{ version_id: NEXT, percentage: 100 }], [{ version_id: OLD, percentage: 100 }]]);
  assert.equal(f.state.reports.at(-1).status, 'rolled_back');
});

test('an uncertain activation never rolls back code that may already have migrated the database', async t => {
  const f = await fixture(t, { activationUnknown: true, snapshotUnavailableAfterActivation: true });
  await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOYMENT_UNCONFIRMED' });
  assert.equal(f.state.current.versions[0].version_id, NEXT);
  assert.equal(f.state.promotions.length, 1, 'no automatic code rollback after unknown database commit');
  assert.equal(f.state.reports.at(-1).status, 'activation_pending');
});

test('another deployment or a superseded task cannot be overwritten or recovered as this build', async t => {
  const external = await fixture(t, { afterUpload: state => { state.current = deployed(NEXT_DEPLOYMENT, FOREIGN); } });
  await assert.rejects(external.execute(), { code: 'PLUGIN_DEPLOY_TARGET_CHANGED' });
  assert.equal(external.state.current.versions[0].version_id, FOREIGN);
  assert.equal(external.state.promotions.length, 0);
  const stale = await fixture(t, { afterUpload: state => { state.snapshot.buildId = FOREIGN; } });
  await assert.rejects(stale.execute(), { code: 'PLUGIN_BUILD_SUPERSEDED' });
  assert.equal(stale.state.promotions.length, 0);
  assert.equal(stale.state.snapshot.buildStatus, 'building', 'the old failure report cannot change the new task');
});

test('pending deployment recovery requires its exact receipt and does not guess a previous Worker version', async t => {
  const f = await fixture(t); f.state.snapshot.buildStatus = 'activation_pending';
  await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOY_RECOVERY_MISSING' });
  assert.equal(f.state.uploads, 0); assert.equal(f.state.promotions.length, 0);
});

test('wrong worker, account, entry point or unresolved bindings fail before any upload', async t => {
  const f = await fixture(t);
  for (const patch of [{ name: 'other-worker' }, { account_id: 'b'.repeat(32) }, { main: resolve(f.root, 'other.js') },
    { d1_databases: [{ binding: 'DB', database_id: '__PLACEHOLDER__' }] }]) {
    await assert.rejects(deploymentTarget({ root: f.root, environment, readConfigImpl: async () => ({ ...f.config, ...patch }) }));
  }
  const target = await deploymentTarget({ root: f.root, environment, readConfigImpl: async () => f.config });
  const record = { type: 'version-upload', worker_name: target.workerName, version_id: NEXT };
  assert.equal(uploadedVersion(JSON.stringify(record), target), NEXT);
  for (const patch of [{ worker_name: 'other-worker' }, { account_id: 'b'.repeat(32) }, { wrangler_environment: 'other' }, { version_id: 'invalid' }]) {
    assert.throws(() => uploadedVersion(JSON.stringify({ ...record, ...patch }), target), { code: 'PLUGIN_DEPLOY_UPLOAD_INVALID' });
  }
  await assert.rejects(deploymentTarget({ root: f.root, environment: { ...environment, WRANGLER_CI_OVERRIDE_NAME: 'other-worker' }, readConfigImpl: async () => f.config }), { code: 'PLUGIN_DEPLOY_TARGET_MISMATCH' });
});

test('manual code recovery refuses to replace an unrelated active deployment', async t => {
  const f = await fixture(t, { activationUnknown: true, snapshotUnavailableAfterActivation: false });
  await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOYMENT_UNCONFIRMED' });
  f.state.current = deployed(OLD_DEPLOYMENT, FOREIGN);
  await assert.rejects(f.execute({ recover: true }), { code: 'PLUGIN_DEPLOYMENT_UNCONFIRMED' });
  assert.equal(f.state.current.versions[0].version_id, FOREIGN);
  assert.equal(f.state.promotions.length, 1);
});

test('a concurrent activation that wins the rollback intent prevents any provider code rollback', async t => {
  const f = await fixture(t, { rejectActivation: true, concurrentActivationBeforeRollback: true });
  const result = await f.execute();
  assert.equal(result.status, 'deployed');
  assert.equal(f.state.current.versions[0].version_id, NEXT);
  assert.equal(f.state.promotions.length, 1);
  assert.ok(f.state.reports.some(row => row.status === 'rolling_back'));
  assert.equal(f.state.reports.some(row => row.status === 'rolled_back'), false);
});

test('a valid but wrong D1, R2 or service binding is rejected after upload and before promotion', async t => {
  for (const resource of ['D1', 'R2', 'service']) await t.test(resource, async t => {
    const f = await fixture(t);
    if (resource === 'D1') f.config.d1_databases[0].database_id = FOREIGN;
    if (resource === 'R2') f.config.r2_buckets[0].bucket_name = 'other-valid-bucket';
    if (resource === 'service') f.config.services[0].service = 'other-valid-worker';
    await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOY_BINDINGS_MISMATCH' });
    assert.equal(f.state.uploads, 1, 'provider metadata of the uploaded version is inspected');
    assert.equal(f.state.promotions.length, 0);
    assert.equal(f.state.current.versions[0].version_id, OLD);
    assert.equal(f.state.reports.some(row => row.status === 'deploying'), false);
    assert.equal(f.state.reports.at(-1).status, 'failed');
  });
});

test('KV, Durable Object, variable, secret type or omitted resource changes cannot pass the metadata comparison', async t => {
  const cases = [
    ['KV', bindings => { bindings.find(binding => binding.type === 'kv_namespace').namespace_id = 'e'.repeat(32); }],
    ['Durable Object', bindings => { bindings.find(binding => binding.type === 'durable_object_namespace').namespace_id = 'e'.repeat(32); }],
    ['variable', bindings => { bindings.find(binding => binding.type === 'plain_text').text = 'other-sensitive-var'; }],
    ['secret type', bindings => { const secret = bindings.find(binding => binding.type === 'secret_text'); secret.type = 'plain_text'; secret.text = 'incorrect-secret-source'; }],
    ['missing resource', bindings => { bindings.splice(bindings.findIndex(binding => binding.type === 'r2_bucket'), 1); }],
  ];
  for (const [label, mutateUploadedBindings] of cases) await t.test(label, async t => {
    const f = await fixture(t, { mutateUploadedBindings });
    await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOY_BINDINGS_MISMATCH' });
    assert.equal(f.state.promotions.length, 0);
  });
});

test('multiple active versions must expose the same resolved bindings before a plugin upload can start', async t => {
  const different = instanceBindings(); different.find(binding => binding.type === 'd1').id = FOREIGN;
  const f = await fixture(t, { alternateBaselineBindings: different });
  f.state.current.versions = [{ version_id: OLD, percentage: 50 }, { version_id: FOREIGN, percentage: 50 }];
  await assert.rejects(f.execute(), { code: 'PLUGIN_DEPLOY_BINDINGS_MISMATCH' });
  assert.equal(f.state.uploads, 0); assert.equal(f.state.promotions.length, 0);
});

test('binding comparison canonicalizes names and object keys but rejects incomplete provider metadata', () => {
  const original = instanceBindings();
  const reordered = [...original].reverse().map(binding => Object.fromEntries(Object.entries(binding).reverse()));
  assert.equal(workerVersionBindingsDigest({ resources: { bindings: original } }), workerVersionBindingsDigest({ resources: { bindings: reordered } }));
  for (const value of [{}, { resources: { bindings: {} } }, { resources: { bindings: [] } },
    { resources: { bindings: [{ name: 'DB', type: 'd1' }] } }, { resources: { bindings: [...original, original[0]] } }]) {
    assert.throws(() => workerVersionBindingsDigest(value), { code: 'PLUGIN_DEPLOY_BINDINGS_INVALID' });
  }
});
