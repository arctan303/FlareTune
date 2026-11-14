import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { canonical, sha256 } from '../../server/src/systemUpdate/common.js';
import { workerVersionBindingsDigest } from '../plugins/delivery-deploy.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createSystemUpdate, SYSTEM_UPDATE_KEY } from '../../server/src/systemUpdate/service.js';
import { handleSystemUpdatePipeline } from '../../server/src/routes/systemUpdate.js';
import { runKnownDatabaseUpgrade } from '../../server/src/instance/upgradeDatabase.js';
import { runPlaylistCountMigration } from '../../server/src/instance/playlistCountMigration.js';
import { deploySystemUpdate, systemBuildConfig, updateTarget } from './deploy.mjs';
import { fetchUpdatePlan, updateConnection, validateUpdatePlan, migrateUpdate } from './protocol.mjs';

const TASK = '895c1cb8-cea8-4f32-abf7-b324191005c8', OLD = '4032d7c5-570f-4415-b53a-26bcb45bd160';
const NEXT = 'cc8fc558-6860-4e2c-9a2b-422b8bbc392b', OTHER = 'ae0c58f8-b7db-4373-81ee-4f2b81147092';
const BEFORE = '041c09e0-2432-4428-b266-120f055873d6', AFTER = '97fd7ef2-5645-4d8b-b0ba-6a065292336b';
export const environment = { FLARETUNE_SYSTEM_UPDATE_SITE_URL: 'https://music.example.net',
  FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN: 'synthetic-build-token-not-a-real-secret',
  FLARETUNE_SYSTEM_UPDATE_WORKER_NAME: 'synthetic-worker', FLARETUNE_SYSTEM_UPDATE_WORKER_TAG: 'd'.repeat(32),
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-provider-token-123456', WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const deployment = (id, version) => ({ id, strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }] });
const bindings = () => [{ name: 'DB', type: 'd1', id: OLD }, { name: 'MEDIA_BUCKET', type: 'r2_bucket', bucket_name: 'synthetic-media' },
  { name: 'CACHE', type: 'kv_namespace', namespace_id: 'b'.repeat(32) },
  { name: 'YTM_RUNTIME', type: 'durable_object_namespace', namespace_id: 'c'.repeat(32), class_name: 'YouTubeRuntime', script_name: 'synthetic-worker' },
  { name: 'SETUP_SECRET', type: 'secret_text' }, { name: 'PRIVATE_VAR', type: 'plain_text', text: 'synthetic-private-setting' },
  { name: 'SETTINGS', type: 'json', json: { enabled: true } }, { name: 'ASSETS', type: 'assets' }];
const template = { compatibility_date: '2026-09-23', assets: { binding: 'ASSETS', run_worker_first: ['/api/*'] } };
export async function makePlan() {
  const target = { schemaVersion: 1, id: `1.3.0:${'e'.repeat(40)}`, version: '1.3.0', commit: 'e'.repeat(40),
    host: { version: '1.3.0', sourceDigest: 'f'.repeat(64) }, hostApiVersion: 5, minVersion: '1.3.0', notes: { zh: '更新', en: 'Update' },
    source: { url: 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-source.tar.gz', sha256: '1'.repeat(64) },
    migration: { compatible: true }, channel: 'stable' };
  const plan = { schemaVersion: 1, taskId: TASK, status: 'queued', from: { host: { version: '1.3.0', sourceDigest: '2'.repeat(64) }, hostApiVersion: 5 },
    target, plugins: [], receipt: null, revision: 1 };
  plan.planDigest = await sha256(canonical({ from: plan.from, target: plan.target, plugins: plan.plugins }));
  return plan;
}
export async function fixture(t, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-system-deploy-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const state = { plan: await makePlan(), current: deployment(BEFORE, OLD), reports: [], uploads: 0, promotions: [], versions: new Map(), migrations: 0 };
  state.versions.set(OLD, { id: OLD, resources: { bindings: bindings() } });
  const fetchImpl = async (url, init) => {
    if (url.startsWith(environment.FLARETUNE_SYSTEM_UPDATE_SITE_URL)) {
      assert.equal(init.headers.Authorization, `Bearer ${environment.FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN}`);
      if (url.endsWith('/plan')) return response(state.plan);
      const body = JSON.parse(init.body);
      if (body.taskId !== state.plan.taskId || body.planDigest !== state.plan.planDigest) return response({ error: 'SYSTEM_UPDATE_JOB_CHANGED' }, 409);
      if (url.endsWith('/claim')) {
        if (state.plan.execution && state.plan.execution.runnerId !== body.runnerId && state.plan.execution.leaseExpiresAt > Date.now()) return response({ error: 'SYSTEM_UPDATE_RUNNER_BUSY' }, 409);
        state.plan.execution = { runnerId: body.runnerId, leaseExpiresAt: Date.now() + 180000 };
        return response({ taskId: TASK, planDigest: state.plan.planDigest, ...state.plan.execution, revision: state.plan.revision });
      }
      if (body.runnerId !== state.plan.execution?.runnerId) return response({ error: 'SYSTEM_UPDATE_RUNNER_CHANGED' }, 409);
      if (url.endsWith('/migration')) {
        state.migrations++; if (options.migrationUnknown) throw Error('synthetic lost migration response');
        state.plan.receipt.migrationCompleted = true;
        return response({ taskId: TASK, ...(options.migrationDto || { status: 'current' }), migrationCompleted: true });
      }
      state.reports.push(body);
      if (body.status === 'migrating' && options.rejectMigration) return response({ error: 'SYSTEM_UPDATE_RUNTIME_MISMATCH' }, 409);
      if (body.receipt) state.plan.receipt = structuredClone(body.receipt);
      state.plan.status = body.status; state.plan.revision++;
      if (body.status === 'migrating') state.plan.receipt.migrationStarted = true;
      await options.onReport?.(body.status, state);
      if (body.status === 'migrating' && options.loseMigratingReport) throw Error('synthetic lost response after durable write');
      if (body.status === 'deployed' && options.loseDeployedReport) throw Error('synthetic lost deployed response');
      return response({ ok: true, taskId: TASK, status: body.status });
    }
    assert.equal(init.headers.Authorization, `Bearer ${environment.CLOUDFLARE_API_TOKEN}`);
    if (url.includes('/services/')) return response({ success: true, result: { default_environment: { script: { tag: options.wrongTarget ? '0'.repeat(32) : environment.FLARETUNE_SYSTEM_UPDATE_WORKER_TAG } } } });
    if (url.endsWith('/deployments') && init.method === 'GET') return response({ success: true, result: { deployments: [state.current] } });
    if (url.endsWith('/deployments')) {
      const body = JSON.parse(init.body); state.promotions.push(body);
      state.current = { id: AFTER, strategy: 'percentage', versions: body.versions };
      return response({ success: true, result: state.current });
    }
    if (url.endsWith('/versions?per_page=100')) return response({ success: true, result: { items: [...state.versions.values()] } });
    const id = url.split('/').at(-1);
    if (state.versions.has(id)) return response({ success: true, result: state.versions.get(id) });
    throw Error('Unexpected synthetic request');
  };
  const uploadImpl = async (target, plan, { configPath }) => {
    state.uploads++;
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.name, 'synthetic-worker'); assert.equal(config.keep_vars, true);
    assert.equal(JSON.stringify(config).includes(environment.CLOUDFLARE_API_TOKEN), false);
    const version = { id: NEXT, annotations: { 'workers/tag': `system-${TASK}` }, resources: { bindings: bindings() } };
    options.mutateBindings?.(version.resources.bindings); state.versions.set(NEXT, version);
    if (options.loseUploadResponse && state.uploads === 1) throw Object.assign(new Error('synthetic upload response lost'), { code: 'SYSTEM_UPDATE_UPLOAD_UNCONFIRMED' });
    return NEXT;
  };
  const run = extra => deploySystemUpdate({ root, environment, fetchImpl, uploadImpl, readTemplateImpl: async () => template,
    sleepImpl: async () => {}, leaseOptions: { initialWaitMs: 0 }, ...extra });
  return { root, state, run, fetchImpl };
}
test('system update persists an inactive version before promotion and migrates before completion', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.status, 'deployed'); assert.equal(f.state.uploads, 1); assert.equal(f.state.migrations, 1);
  assert.deepEqual(f.state.reports.map(row => row.status), ['building', 'building', 'uploaded', 'deploying', 'migrating', 'deployed']);
  assert.equal(f.state.reports[2].receipt.nextVersionId, NEXT);
  assert.deepEqual(f.state.reports[2].receipt.previous, deployment(BEFORE, OLD));
  assert.equal(f.state.plan.receipt.migrationCompleted, true);
  assert.equal(JSON.stringify(f.state.plan.receipt).includes('synthetic-private-setting'), false);
  assert.equal(JSON.stringify(f.state.plan.receipt).includes(environment.CLOUDFLARE_API_TOKEN), false);
});
test('an uploaded durable receipt resumes on a different build without another upload', async t => {
  const f = await fixture(t, { migrationUnknown: true });
  await assert.rejects(f.run(), { code: 'SYSTEM_UPDATE_REQUEST_UNCONFIRMED' });
  assert.equal(f.state.plan.status, 'activation_pending'); assert.equal(f.state.plan.receipt.migrationStarted, true);
  const retry = await fixture(t); retry.state.plan = structuredClone(f.state.plan); retry.state.versions = new Map(f.state.versions); retry.state.current = structuredClone(f.state.current);
  retry.state.plan.execution.leaseExpiresAt = Date.now() - 1;
  assert.equal((await retry.run()).status, 'deployed'); assert.equal(retry.state.uploads, 0); assert.equal(retry.state.promotions.length, 0);
});
test('a crash after upload but before receipt delivery recovers the task-tagged inactive version', async t => {
  const f = await fixture(t, { loseUploadResponse: true });
  await assert.rejects(f.run(), { code: 'SYSTEM_UPDATE_UPLOAD_UNCONFIRMED' });
  assert.equal(f.state.uploads, 1); assert.equal(f.state.promotions.length, 0);
  f.state.plan.status = 'queued';
  f.state.plan.execution.leaseExpiresAt = Date.now() - 1;
  assert.equal((await f.run()).status, 'deployed'); assert.equal(f.state.uploads, 1);
});
test('full instance bindings must remain identical before any promotion', async t => {
  for (const mutateBindings of [rows => rows.find(row => row.name === 'DB').id = OTHER,
    rows => rows.find(row => row.name === 'PRIVATE_VAR').text = 'changed', rows => rows.splice(4, 1)]) {
    const f = await fixture(t, { mutateBindings });
    await assert.rejects(f.run(), { code: 'SYSTEM_UPDATE_BINDINGS_MISMATCH' }); assert.equal(f.state.promotions.length, 0);
  }
});
test('foreign platform identity and provider override guards cannot be disabled by task input', async t => {
  const f = await fixture(t, { wrongTarget: true });
  await assert.rejects(f.run(), { code: 'SYSTEM_UPDATE_TARGET_MISMATCH' }); assert.equal(f.state.uploads, 0);
  for (const extra of [{ WRANGLER_CI_OVERRIDE_NAME: 'another-worker' }, { WRANGLER_CI_MATCH_TAG: '0'.repeat(32) },
    { CLOUDFLARE_API_BASE_URL: 'https://attacker.example.net' }, { WORKERS_CI_BRANCH: 'dev' }]) assert.throws(() => updateTarget({ ...environment, ...extra }));
});
test('another deployment after the durable deploying report is not promoted or rolled back', async t => {
  const f = await fixture(t, { onReport: async (status, state) => { if (status === 'deploying') state.current = deployment(OTHER, OTHER); } });
  await assert.rejects(f.run(), { code: 'SYSTEM_UPDATE_TARGET_CHANGED' }); assert.equal(f.state.promotions.length, 0);
  assert.equal(f.state.current.id, OTHER); assert.equal(f.state.plan.status, 'activation_pending');
});
test('a confirmed failure before migration can restore precisely the previous traffic split', async t => {
  const f = await fixture(t, { rejectMigration: true });
  assert.equal((await f.run()).status, 'rolled_back'); assert.equal(f.state.promotions.length, 2);
  assert.deepEqual(f.state.current.versions, deployment(BEFORE, OLD).versions);
  assert.equal(f.state.plan.receipt.migrationStarted, false);
});
test('a lost migrating acknowledgement never rolls code back over a possibly committed migration', async t => {
  const f = await fixture(t, { loseMigratingReport: true });
  await assert.rejects(f.run(), { code: 'SYSTEM_UPDATE_REQUEST_UNCONFIRMED' });
  assert.equal(f.state.plan.receipt.migrationStarted, true); assert.equal(f.state.plan.status, 'activation_pending');
  assert.equal(f.state.promotions.length, 1); assert.equal(f.state.current.versions[0].version_id, NEXT);
});
test('a committed deployed acknowledgement is recovered without writing a second version', async t => {
  const f = await fixture(t, { loseDeployedReport: true });
  assert.equal((await f.run()).status, 'deployed'); assert.equal(f.state.uploads, 1); assert.equal(f.state.promotions.length, 1);
});
test('activation pending without an uploaded receipt can start the initial build', async t => {
  const f = await fixture(t); f.state.plan.status = 'activation_pending';
  assert.equal((await f.run()).status, 'deployed'); assert.equal(f.state.uploads, 1);
});
test('two concurrent builders cannot upload or promote the same frozen task twice', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([
    f.run({ environment: { ...environment, WORKERS_CI_BUILD_UUID: 'synthetic-runner-one' } }),
    f.run({ environment: { ...environment, WORKERS_CI_BUILD_UUID: 'synthetic-runner-two' } }),
  ]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(row => row.status === 'rejected').length, 1);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.promotions.length, 1);
});
test('an expired upload owner does not prove an unacknowledged upload never happened', async t => {
  const f = await fixture(t);
  f.state.plan.status = 'activation_pending';
  f.state.plan.execution = { runnerId: 'expired-runner', leaseExpiresAt: Date.now() - 1 };
  f.state.plan.receipt = { schemaVersion: 1, accountId: environment.CLOUDFLARE_ACCOUNT_ID, workerName: environment.FLARETUNE_SYSTEM_UPDATE_WORKER_NAME,
    targetTag: environment.FLARETUNE_SYSTEM_UPDATE_WORKER_TAG, previous: deployment(BEFORE, OLD), nextVersionId: null,
    bindingDigest: workerVersionBindingsDigest(f.state.versions.get(OLD)), uploadStarted: true, migrationStarted: false, migrationCompleted: false };
  await assert.rejects(f.run(), { code: 'SYSTEM_UPDATE_UPLOAD_UNCONFIRMED' });
  assert.equal(f.state.uploads, 0); assert.equal(f.state.promotions.length, 0); assert.equal(f.state.plan.status, 'activation_pending');
});
test('recovery waits for the active builder lease then a new runner claims the same receipt and restores it', async t => {
  const f = await fixture(t); let elapsed = 0, prematureProviderCalls = 0; const waits = [];
  f.state.plan.status = 'rolling_back'; f.state.current = deployment(AFTER, NEXT);
  f.state.plan.execution = { runnerId: 'old-active-builder', leaseExpiresAt: Date.now() + 6000 };
  f.state.plan.receipt = { schemaVersion: 1, accountId: environment.CLOUDFLARE_ACCOUNT_ID, workerName: environment.FLARETUNE_SYSTEM_UPDATE_WORKER_NAME,
    targetTag: environment.FLARETUNE_SYSTEM_UPDATE_WORKER_TAG, previous: deployment(BEFORE, OLD), nextVersionId: NEXT,
    bindingDigest: workerVersionBindingsDigest(f.state.versions.get(OLD)), uploadStarted: true, migrationStarted: false, migrationCompleted: false };
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://api.cloudflare.com/') && f.state.plan.execution.runnerId === 'old-active-builder') prematureProviderCalls++;
    return f.fetchImpl(url, init);
  };
  const result = await f.run({ environment: { ...environment, WORKERS_CI_BUILD_UUID: 'new-recovery-builder' }, fetchImpl,
    leaseOptions: { initialWaitMs: 185000, nowImpl: () => elapsed, sleepImpl: async delay => {
      waits.push(delay); elapsed += delay;
      if (elapsed >= 6000) f.state.plan.execution.leaseExpiresAt = Date.now() - 1;
    } } });
  assert.equal(result.status, 'rolled_back'); assert.deepEqual(waits, [3000, 3000]);
  assert.equal(f.state.plan.execution.runnerId, 'new-recovery-builder'); assert.equal(prematureProviderCalls, 0);
  assert.equal(f.state.uploads, 0); assert.deepEqual(f.state.current.versions, deployment(BEFORE, OLD).versions);
});
test('private config retains all supported resource identities while keeping secret values out', () => {
  const config = systemBuildConfig({ resources: { bindings: bindings() } }, { root: '/synthetic', target: updateTarget(environment), template });
  assert.equal(config.d1_databases[0].database_id, OLD); assert.equal(config.kv_namespaces[0].id, 'b'.repeat(32));
  assert.equal(config.r2_buckets[0].bucket_name, 'synthetic-media'); assert.equal(config.vars.PRIVATE_VAR, 'synthetic-private-setting');
  assert.equal(Object.hasOwn(config.vars, 'SETUP_SECRET'), false); assert.equal(config.durable_objects.bindings[0].class_name, 'YouTubeRuntime');
  assert.equal(config.assets.directory.endsWith('dist'), true);
});
test('plan changes cannot preserve an old digest or inject deployment receipts with extra commands', async () => {
  const plan = await makePlan(); await validateUpdatePlan(plan);
  plan.target.notes.zh = 'changed'; await assert.rejects(validateUpdatePlan(plan), { code: 'SYSTEM_UPDATE_PLAN_DIGEST_MISMATCH' });
  const other = await makePlan(); other.receipt = { command: 'curl attacker' };
  await assert.rejects(validateUpdatePlan(other), { code: 'SYSTEM_UPDATE_RECEIPT_INVALID' });
});
test('only the specific no-job response is idle; an authorization failure is never ignored', async () => {
  const connection = updateConnection(environment);
  assert.equal(await fetchUpdatePlan(connection, { fetchImpl: async () => response({ error: 'SYSTEM_UPDATE_JOB_UNAVAILABLE' }, 404) }), null);
  await assert.rejects(fetchUpdatePlan(connection, { fetchImpl: async () => response({ error: 'forbidden' }, 403) }), { code: 'SYSTEM_UPDATE_REQUEST_REJECTED' });
});
test('real completed and already-completed database migration DTOs let the updater finish instead of remaining in maintenance', async t => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(await readFile(new URL('../../server/db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; } }; },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
  let completed;
  for (let step = 0; step < 8; step++) {
    completed = await runKnownDatabaseUpgrade(db, { allowDestructive: false });
    if (completed.status === 'completed') break;
  }
  assert.equal(completed.status, 'completed'); assert.equal(completed.schemaVersion, 2);
  assert.equal(sqlite.prepare('SELECT schema_version FROM ft_instance WHERE id=1').get().schema_version, 2);
  const alreadyCompleted = await runPlaylistCountMigration(db, { ownerToken: '7'.repeat(32) });
  assert.equal(alreadyCompleted.status, 'already_completed');
  for (const migrationDto of [completed, { ...alreadyCompleted, schemaVersion: 2 }]) {
    const f = await fixture(t, { migrationDto });
    assert.equal((await f.run()).status, 'deployed');
    assert.equal(f.state.plan.receipt.migrationCompleted, true); assert.equal(f.state.promotions.length, 1);
    assert.equal(f.state.reports.some(report => report.status === 'activation_pending'), false);
  }
  const plan = await makePlan(), connection = updateConnection(environment);
  for (const invalid of [{ taskId: OTHER, migrationCompleted: true }, { taskId: TASK }, { taskId: TASK, migrationCompleted: 'true' }]) {
    await assert.rejects(migrateUpdate(connection, plan, { fetchImpl: async () => response({ ...completed, ...invalid }) }), { code: 'SYSTEM_UPDATE_RESPONSE_INVALID' });
  }
});
test('runner and real SQLite-backed service complete the durable claim, upload, migration and activation protocol together', async t => {
  const f = await fixture(t), sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value_json TEXT,revision INTEGER NOT NULL,updated_at INTEGER,updated_by TEXT)');
  const db = { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; } }; } };
  let live = { ...f.state.plan.from.host, hostApiVersion: 5, plugins: [] }, ready = true, migrations = 0;
  const env = { DB: db, SETUP_SECRET: 'synthetic_setup_secret_only_for_sqlite_integration' };
  const update = createSystemUpdate({ runtime: () => live, requireAdminImpl: async () => {},
    state: async () => ({ state: ready ? 'ready' : 'maintenance' }), supplemental: async () => ({ supplementalPending: !ready }),
    migrate: async (_db, options) => { assert.equal(options.allowDestructive, false); migrations++; ready = true; return { status: 'current', schemaVersion: 2 }; } });
  await update.configure(env, null, { revision: 0,
    deployHookUrl: 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-update-hook-12345', buildToken: environment.FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN });
  const saved = JSON.parse(sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(SYSTEM_UPDATE_KEY).value_json);
  saved.job = structuredClone(f.state.plan); delete saved.job.revision; delete saved.job.schemaVersion;
  sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify(saved), SYSTEM_UPDATE_KEY);
  const fetchImpl = async (url, init) => {
    if (url.startsWith(environment.FLARETUNE_SYSTEM_UPDATE_SITE_URL)) {
      const request = new Request(url, init);
      return handleSystemUpdatePipeline(request, new URL(url).pathname, env, { state: ready ? 'ready' : 'maintenance' },
        (value, status = 200) => response(value, status), { update });
    }
    const result = await f.fetchImpl(url, init);
    if (url.endsWith('/deployments') && init.method === 'POST') {
      const next = f.state.current.versions[0].version_id === NEXT;
      live = { ...(next ? f.state.plan.target.host : f.state.plan.from.host), hostApiVersion: 5, plugins: [] }; ready = !next;
    }
    return result;
  };
  assert.equal((await f.run({ fetchImpl })).status, 'deployed');
  const final = await update.plan(env, new Request(`${environment.FLARETUNE_SYSTEM_UPDATE_SITE_URL}/api/system-update/plan`,
    { headers: { Authorization: `Bearer ${environment.FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN}` } }));
  assert.equal(final.status, 'deployed'); assert.equal(final.receipt.uploadStarted, true); assert.equal(final.receipt.migrationCompleted, true);
  assert.equal(f.state.uploads, 1); assert.equal(migrations, 1); assert.equal(ready, true);
});
