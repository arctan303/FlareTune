import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSystemUpdate, SYSTEM_UPDATE_KEY, systemUpdateBusy, systemUpdateMaintenance } from './service.js';
import { canonical, sha256 } from './common.js';
import { discoverRelease, validateRelease } from './releases.js';
import { handleSystemUpdatePipeline } from '../routes/systemUpdate.js';

const secret = 'synthetic_update_capability_12345678901234567890123';
const hook = 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-update-hook-12345';
const old = { version: '1.2.1', sourceDigest: 'a'.repeat(64), hostApiVersion: 5, plugins: [] };
const target = () => ({ schemaVersion: 1, id: `1.3.0:${'b'.repeat(40)}`, version: '1.3.0', commit: 'b'.repeat(40),
  host: { version: '1.3.0', sourceDigest: 'c'.repeat(64) }, hostApiVersion: 5, minVersion: '1.2.1', notes: { zh: '更新', en: 'Update' },
  source: { url: 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-source.tar.gz', sha256: 'd'.repeat(64) },
  migration: { compatible: true }, channel: 'stable' });
const receipt = () => ({ schemaVersion: 1, accountId: 'e'.repeat(32), workerName: 'synthetic-worker', targetTag: 'f'.repeat(32),
  previous: { id: '11111111-1111-4111-8111-111111111111', strategy: 'percentage',
    versions: [{ version_id: '22222222-2222-4222-8222-222222222222', percentage: 100 }] },
  nextVersionId: null, bindingDigest: '9'.repeat(64), uploadStarted: false, migrationStarted: false, migrationCompleted: false });
const nextVersion = '33333333-3333-4333-8333-333333333333';
const request = (token = secret) => new Request('https://instance.example/api/system-update/plan', { headers: { Authorization: `Bearer ${token}` } });

function fixture(t, { fetchImpl, discover, plugins = [], migrate, state, supplemental } = {}) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value_json TEXT,revision INTEGER NOT NULL,updated_at INTEGER,updated_by TEXT);
    CREATE TABLE accounts(account_id TEXT PRIMARY KEY,role TEXT,status TEXT);
    CREATE TABLE account_credentials(account_id TEXT PRIMARY KEY,kdf TEXT,kdf_version INTEGER,kdf_params_json TEXT,salt TEXT,password_hash TEXT,must_change_password INTEGER);
    CREATE TABLE account_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT,mode TEXT,revoked_at INTEGER,expires_at INTEGER);
    INSERT INTO accounts VALUES('owner','admin','active');
    INSERT INTO accounts VALUES('member','member','active');`);
  for (const id of ['owner', 'member']) {
    sqlite.prepare('INSERT INTO account_credentials VALUES(?,?,?,?,?,?,?)').run(id, 'pbkdf2-sha256-chain', 2,
      JSON.stringify({ iterations: 100000, rounds: 6 }), 'A'.repeat(22), 'A'.repeat(43), 0);
    sqlite.prepare('INSERT INTO account_sessions VALUES(?,?,?,NULL,?)').run(`${id}-token`, id, 'normal', Date.now() + 86400000);
  }
  const db = { prepare(sql) { const values = []; return { bind(...args) { values.push(...args); return this; },
    async first() { return sqlite.prepare(sql).get(...values) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { db.beforeRun?.(sql, values); return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; } }; } };
  const env = { DB: db, SETUP_SECRET: 'synthetic_setup_secret_for_update_tests_12345' };
  let live = { ...old, plugins }, lastFetch = null, migrationCalls = 0, databaseIsReady = true, now = Date.now();
  const update = createSystemUpdate({ runtime: () => live, clock: () => now, discover: discover || (async () => target()),
    fetchImpl: fetchImpl || (async (...args) => { lastFetch = args; return Response.json({ success: true, result: { build_uuid: 'synthetic-build-12345' } }); }),
    state: state || (async () => ({ state: databaseIsReady ? 'ready' : 'maintenance' })),
    supplemental: supplemental || (async () => ({ supplementalPending: !databaseIsReady })),
    migrate: migrate || (async (_db, options) => { migrationCalls++; assert.equal(options.allowDestructive, false); databaseIsReady = true; return { status: 'current', schemaVersion: 2 }; }) });
  const owner = { mode: 'normal', tokenHash: 'owner-token', account: { accountId: 'owner', role: 'admin' } };
  const member = { mode: 'normal', tokenHash: 'member-token', account: { accountId: 'member', role: 'member' } };
  const view = () => update.get(env, owner);
  async function configured() { return update.configure(env, owner, { revision: (await view()).revision, deployHookUrl: hook, buildToken: secret }); }
  async function start() { await configured(); const checked = await update.check(env, owner, { revision: (await view()).revision });
    return update.start(env, owner, { revision: checked.revision, releaseId: checked.latest.id }); }
  const raw = () => JSON.parse(sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(SYSTEM_UPDATE_KEY).value_json);
  const report = async (status, extra = {}) => { const p = await update.plan(env, request());
    await update.claim(env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A' });
    return update.report(env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A', status, ...extra }); };
  async function uploaded() { await start(); const saved = receipt(); await report('building', { receipt: saved }); saved.uploadStarted = true; saved.nextVersionId = nextVersion;
    await report('uploaded', { receipt: saved }); return saved; }
  return { env, db, sqlite, update, owner, member, configured, start, uploaded, view, report, raw,
    setRuntime: info => { live = info; }, targetRuntime: () => ({ ...target().host, hostApiVersion: 5, plugins }),
    get lastFetch() { return lastFetch; }, get migrationCalls() { return migrationCalls; }, setReady: value => { databaseIsReady = value; },
    advance: amount => { now += amount; } };
}

test('only an active normal administrator can configure; encrypted secrets never appear in public state', async t => {
  const f = fixture(t);
  for (const session of [null, f.member, { ...f.owner, mode: 'must_change_password' }]) {
    await assert.rejects(f.update.configure(f.env, session, { revision: 0, deployHookUrl: hook, buildToken: secret }), { code: 'forbidden' });
  }
  const configured = await f.configured(); assert.equal(configured.configured, true);
  assert.equal(JSON.stringify(configured).includes(secret), false); assert.equal(JSON.stringify(configured).includes(hook), false);
  assert.equal(JSON.stringify(f.raw()).includes(secret), false);
  const unchanged = await f.update.configure(f.env, f.owner, { revision: configured.revision });
  assert.equal(unchanged.configured, true);
  f.sqlite.exec("UPDATE account_sessions SET revoked_at=1 WHERE account_id='owner'");
  await assert.rejects(f.view(), { code: 'forbidden' });
});

test('configuration validates the exact Cloudflare hook origin and revision; clearing requires idle task', async t => {
  const f = fixture(t);
  await assert.rejects(f.update.configure(f.env, f.owner, { revision: 0, deployHookUrl: hook + '?token=extra' }), { code: 'SYSTEM_UPDATE_INVALID_INPUT' });
  await f.start();
  await assert.rejects(f.update.configure(f.env, f.owner, { revision: (await f.view()).revision, buildToken: '' }), { code: 'SYSTEM_UPDATE_IN_PROGRESS' });
  await assert.rejects(f.update.check(f.env, f.owner, { revision: 0 }), { code: 'SYSTEM_UPDATE_REVISION_MISMATCH' });
});

test('a confirmed start freezes manifest and digest; no release or source can be submitted by the browser', async t => {
  const f = fixture(t); const started = await f.start(); const p = await f.update.plan(f.env, request());
  assert.equal(started.job.status, 'queued');
  assert.equal(p.planDigest, await sha256(canonical({ from: p.from, target: p.target, plugins: p.plugins })));
  assert.equal(JSON.stringify(p).includes(secret), false);
  assert.equal(f.lastFetch[0], hook); assert.equal(f.lastFetch[1].method, 'POST');
  await assert.rejects(f.update.start(f.env, f.owner, { revision: started.revision, releaseId: p.target.id, source: 'https://evil.example/x' }), { code: 'SYSTEM_UPDATE_INVALID_INPUT' });
  await assert.rejects(f.update.plan(f.env, request('wrong_token_123456789012345678901234567890')), { code: 'forbidden' });
});

test('concurrent administrators cannot start two updates', async t => {
  const f = fixture(t); await f.configured(); const v = await f.update.check(f.env, f.owner, { revision: (await f.view()).revision });
  const result = await Promise.allSettled([1, 2].map(() => f.update.start(f.env, f.owner, { revision: v.revision, releaseId: v.latest.id })));
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(result.filter(row => row.status === 'rejected').length, 1);
});

test('a lost hook response keeps the same unknown task; retry cannot pick another release', async t => {
  const f = fixture(t, { fetchImpl: async () => { throw Error('network lost'); } }); const started = await f.start();
  assert.equal(started.job.status, 'activation_pending'); const frozen = started.job;
  const retry = await f.update.retry(f.env, f.owner, { revision: started.revision, taskId: frozen.taskId });
  assert.equal(retry.job.taskId, frozen.taskId); assert.equal(retry.job.planDigest, frozen.planDigest);
  assert.equal(retry.job.status, 'activation_pending');
  await f.report('building', { receipt: receipt() });
  assert.equal((await f.update.plan(f.env, request())).status, 'building');
});

test('pre-promotion failure retries one frozen target and persists receipt across service instances', async t => {
  const f = fixture(t); const saved = await f.uploaded(); await f.report('failed');
  const v = await f.view(); const retry = await f.update.retry(f.env, f.owner, { revision: v.revision, taskId: v.job.taskId });
  assert.equal(retry.job.status, 'queued'); assert.deepEqual(retry.job.receipt, saved);
  const fresh = createSystemUpdate({ runtime: old });
  assert.deepEqual((await fresh.plan(f.env, request())).receipt, saved);
});

test('an immediate retry fences the failed execution and lets the new runner continue without waiting for its old lease', async t => {
  const f = fixture(t); const saved = await f.uploaded(); await f.report('failed');
  const before = await f.update.plan(f.env, request()); assert.equal(before.execution.runnerId, 'runner-A');
  await assert.rejects(f.update.claim(f.env, request(), { taskId: before.taskId, planDigest: before.planDigest, runnerId: 'runner-B' }), { code: 'SYSTEM_UPDATE_RETRY_REQUIRED' });
  const retry = await f.update.retry(f.env, f.owner, { revision: before.revision, taskId: before.taskId });
  const input = { taskId: before.taskId, planDigest: before.planDigest };
  assert.equal(retry.job.status, 'queued'); assert.deepEqual(retry.job.receipt, saved);
  assert.equal(retry.job.retiredRunners, undefined);
  assert.equal((await f.update.plan(f.env, request())).retiredRunners, undefined);
  await assert.rejects(f.update.claim(f.env, request(), { ...input, runnerId: 'runner-A' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  await assert.rejects(f.update.report(f.env, request(), { ...input, runnerId: 'runner-A', status: 'building' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  await assert.rejects(f.update.migration(f.env, request(), { ...input, runnerId: 'runner-A' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  await f.update.claim(f.env, request(), { ...input, runnerId: 'runner-B' });
  await f.update.report(f.env, request(), { ...input, runnerId: 'runner-B', status: 'building' });
  await f.update.report(f.env, request(), { ...input, runnerId: 'runner-B', status: 'uploaded' });
  assert.equal((await f.update.plan(f.env, request())).receipt.nextVersionId, saved.nextVersionId);
});

test('retry or recover of an uncertain live execution keeps its lease until safe expiry and preserves all receipt intent', async t => {
  const f = fixture(t); const saved = await f.uploaded(); await f.report('deploying'); await f.report('activation_pending');
  let p = await f.update.plan(f.env, request());
  await f.update.retry(f.env, f.owner, { revision: p.revision, taskId: p.taskId });
  await assert.rejects(f.update.claim(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-B' }), { code: 'SYSTEM_UPDATE_RUNNER_BUSY' });
  p = await f.update.plan(f.env, request());
  await f.update.recover(f.env, f.owner, { revision: p.revision, taskId: p.taskId });
  await assert.rejects(f.update.claim(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-B' }), { code: 'SYSTEM_UPDATE_RUNNER_BUSY' });
  f.advance(180001);
  await f.update.claim(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-B' });
  assert.deepEqual((await f.update.plan(f.env, request())).receipt, saved);
  await assert.rejects(f.update.report(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A', status: 'rolled_back' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  await f.update.report(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-B', status: 'rolled_back' });
});

test('receipts fix deployment identities, reject stage jumps and cannot fake migration completion', async t => {
  const f = fixture(t); const saved = await f.uploaded();
  await assert.rejects(f.report('uploaded', { receipt: { ...saved, nextVersionId: '44444444-4444-4444-8444-444444444444' } }), { code: 'SYSTEM_UPDATE_RECEIPT_INVALID' });
  await assert.rejects(f.report('deployed'), { code: 'SYSTEM_UPDATE_TRANSITION_INVALID' });
  await assert.rejects(f.report('deploying', { receipt: { ...saved, migrationStarted: true, migrationCompleted: true } }), { code: 'SYSTEM_UPDATE_RECEIPT_INVALID' });
  assert.equal((await f.update.plan(f.env, request())).status, 'uploaded');
});

test('deployment requires actual target host and completed known migration before success', async t => {
  const f = fixture(t); await f.uploaded(); await f.report('deploying');
  await assert.rejects(f.report('migrating'), { code: 'SYSTEM_UPDATE_RUNTIME_MISMATCH' });
  f.setRuntime(f.targetRuntime()); await f.report('migrating'); assert.equal(await systemUpdateMaintenance(f.env), true);
  const p = await f.update.plan(f.env, request());
  await assert.rejects(f.report('deployed'), { code: 'SYSTEM_UPDATE_MIGRATION_REQUIRED' });
  const result = await f.update.migration(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A' });
  assert.equal(result.migrationCompleted, true); assert.equal(f.migrationCalls, 1);
  await f.update.migration(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A' }); assert.equal(f.migrationCalls, 1);
  await f.report('deployed'); await f.report('deployed'); assert.equal(await systemUpdateMaintenance(f.env), false);
});

test('once migration intent is recorded, uncertain retries only continue and never claim a safe rollback', async t => {
  const f = fixture(t); await f.uploaded(); await f.report('deploying'); f.setRuntime(f.targetRuntime()); await f.report('migrating');
  await f.report('activation_pending'); const p = await f.update.plan(f.env, request());
  await assert.rejects(f.report('rolling_back'), { code: 'SYSTEM_UPDATE_RECOVERY_UNAVAILABLE' });
  await assert.rejects(f.update.recover(f.env, f.owner, { revision: (await f.view()).revision, taskId: p.taskId }), { code: 'SYSTEM_UPDATE_RECOVERY_UNAVAILABLE' });
  await f.report('migrating'); const ready = await f.update.plan(f.env, request());
  await f.update.migration(f.env, request(), { taskId: ready.taskId, planDigest: ready.planDigest, runnerId: 'runner-A' }); await f.report('deployed');
});

test('pre-migration rollback verifies actual original host and cannot erase installed-package changes', async t => {
  const f = fixture(t); await f.uploaded(); await f.report('deploying'); await f.report('rolling_back');
  f.setRuntime(f.targetRuntime()); await assert.rejects(f.report('rolled_back'), { code: 'SYSTEM_UPDATE_RUNTIME_MISMATCH' });
  f.setRuntime(old); await f.report('rolled_back');
});

test('only a trusted candidate can update the same version with a different digest', async t => {
  const value = target(); const f = fixture(t, { discover: async () => value }); f.setRuntime({ ...old, version: value.version });
  await f.configured(); let v = await f.update.check(f.env, f.owner, { revision: (await f.view()).revision });
  await assert.rejects(f.update.start(f.env, f.owner, { revision: v.revision, releaseId: v.latest.id }), { code: 'SYSTEM_UPDATE_ALREADY_CURRENT' });
  value.channel = 'candidate'; value.source.url = `https://codeload.github.com/arctan303/FlareTune/tar.gz/${value.commit}`;
  f.env.FLARETUNE_UPDATE_CANDIDATE_JSON = JSON.stringify(value);
  v = await f.update.check(f.env, f.owner, { revision: v.revision });
  assert.equal((await f.update.start(f.env, f.owner, { revision: v.revision, releaseId: v.latest.id })).job.target.channel, 'candidate');
});

test('removing the instance-only candidate after checking revokes its start authorization', async t => {
  const value = { ...target(), channel: 'candidate', source: { ...target().source,
    url: `https://codeload.github.com/arctan303/FlareTune/tar.gz/${'b'.repeat(40)}` } }, f = fixture(t, { discover: async () => value });
  f.env.FLARETUNE_UPDATE_CANDIDATE_JSON = JSON.stringify(value); await f.configured();
  const v = await f.update.check(f.env, f.owner, { revision: (await f.view()).revision });
  delete f.env.FLARETUNE_UPDATE_CANDIDATE_JSON;
  await assert.rejects(f.update.start(f.env, f.owner, { revision: v.revision, releaseId: v.latest.id }), { code: 'SYSTEM_UPDATE_TARGET_CHANGED' });
});

test('an installed non-seed package and private configuration survive an update, with epoch changes rejected', async t => {
  const artifact = { id: 'third-party', version: '2.1.0', manifest: { id: 'third-party', version: '2.1.0', hostApiVersion: 1, apiVersion: 1 },
    source: { type: 'artifact', id: 'custom-source', url: 'https://packages.example.org/immutable.json', sha256: '8'.repeat(64) } };
  const f = fixture(t, { plugins: [artifact] });
  const epoch = '77777777-7777-4777-8777-777777777777';
  f.sqlite.prepare('INSERT INTO instance_settings VALUES(?,?,3,1,?)').run('plugin.installation.third-party', JSON.stringify({ installed: true, epoch }), 'owner');
  f.sqlite.prepare('INSERT INTO instance_settings VALUES(?,?,2,1,?)').run('plugin.data.private-config', JSON.stringify({ model: 'saved-model', ciphertext: 'private-ciphertext' }), 'owner');
  const before = f.sqlite.prepare("SELECT * FROM instance_settings WHERE key!='system.update.v1' ORDER BY key").all();
  await f.uploaded(); await f.report('deploying'); f.setRuntime(f.targetRuntime()); await f.report('migrating');
  const p = await f.update.plan(f.env, request());
  assert.equal(p.plugins[0].installation.epoch, epoch);
  f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify({ installed: true, epoch: '88888888-8888-4888-8888-888888888888' }), 'plugin.installation.third-party');
  await assert.rejects(f.update.migration(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A' }), { code: 'SYSTEM_UPDATE_INSTALLATION_CHANGED' });
  f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify({ installed: true, epoch }), 'plugin.installation.third-party');
  await f.update.migration(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A' }); await f.report('deployed');
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM instance_settings WHERE key!='system.update.v1' ORDER BY key").all(), before);
});

test('a migration failure keeps the maintenance intent durable and refuses rollback without deleting configuration', async t => {
  const f = fixture(t, { migrate: async () => { throw Object.assign(Error('backup required'), { name: 'DatabaseUpgradeError', code: 'backup_required', status: 409 }); } });
  await f.uploaded(); await f.report('deploying'); f.setRuntime(f.targetRuntime()); await f.report('migrating');
  const p = await f.update.plan(f.env, request());
  await assert.rejects(f.update.migration(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-A' }), { code: 'backup_required' });
  assert.equal((await f.update.plan(f.env, request())).receipt.migrationStarted, true);
  assert.equal(await systemUpdateMaintenance(f.env), true);
  await assert.rejects(f.report('rolling_back'), { code: 'SYSTEM_UPDATE_RECOVERY_UNAVAILABLE' });
});

test('unknown outcome with an uploaded version can retry deployment but cannot replace that version', async t => {
  const f = fixture(t); await f.uploaded(); await f.report('deploying'); await f.report('activation_pending');
  await assert.rejects(f.report('building', { receipt: receipt() }), { code: 'SYSTEM_UPDATE_RESULT_UNKNOWN' });
  await f.report('deploying');
  assert.equal((await f.update.plan(f.env, request())).receipt.nextVersionId, nextVersion);
});

test('a brand new empty database has no update maintenance gate; corrupt update data closes the gate', async t => {
  const f = fixture(t);
  assert.equal(await systemUpdateBusy(f.env), false);
  f.sqlite.exec('DROP TABLE instance_settings');
  assert.equal(await systemUpdateMaintenance(f.env), false); assert.equal(await systemUpdateBusy(f.env), false);
  f.sqlite.exec('CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value_json TEXT)');
  f.sqlite.prepare('INSERT INTO instance_settings VALUES(?,?)').run(SYSTEM_UPDATE_KEY, '{invalid-json');
  assert.equal(await systemUpdateMaintenance(f.env), true); assert.equal(await systemUpdateBusy(f.env), true);
});

test('two real runners atomically claim one task; expired takeover rejects the former runner', async t => {
  const f = fixture(t); await f.start(); const p = await f.update.plan(f.env, request());
  const claim = runnerId => f.update.claim(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId });
  const claims = await Promise.allSettled(['runner-A', 'runner-B'].map(claim));
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
  const winner = (await f.update.plan(f.env, request())).execution.runnerId, loser = winner === 'runner-A' ? 'runner-B' : 'runner-A';
  await assert.rejects(claim(loser), { code: 'SYSTEM_UPDATE_RUNNER_BUSY' });
  await assert.rejects(f.update.report(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: loser, status: 'building' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  f.advance(180001); await claim(loser);
  await assert.rejects(f.update.report(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: winner, status: 'building' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  await f.update.report(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: loser, status: 'building', receipt: receipt() });
  await assert.rejects(claim(winner), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  assert.equal((await f.update.plan(f.env, request())).planDigest, p.planDigest);
  assert.equal((await f.view()).job.execution, undefined);
});

test('runner takeover after migration intent continues the same migration without permitting rollback', async t => {
  const f = fixture(t); await f.uploaded(); await f.report('deploying'); f.setRuntime(f.targetRuntime()); await f.report('migrating');
  const p = await f.update.plan(f.env, request()); f.advance(180001);
  await f.update.claim(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-B' });
  const input = { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'runner-B' };
  await assert.rejects(f.update.report(f.env, request(), { ...input, status: 'rolling_back' }), { code: 'SYSTEM_UPDATE_RECOVERY_UNAVAILABLE' });
  await assert.rejects(f.update.migration(f.env, request(), { ...input, runnerId: 'runner-A' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
  await f.update.migration(f.env, request(), input); await f.update.report(f.env, request(), { ...input, status: 'deployed' });
  assert.equal(await systemUpdateMaintenance(f.env), false);
});

test('execution fencing has a bounded validated history and never drops old fences to make room', async t => {
  const f = fixture(t); await f.uploaded(); await f.report('failed');
  const raw = f.raw(); raw.job.retiredRunners = Array.from({ length: 64 }, (_, index) => `retired-${index}`);
  f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify(raw), SYSTEM_UPDATE_KEY);
  const v = await f.view();
  await assert.rejects(f.update.retry(f.env, f.owner, { revision: v.revision, taskId: v.job.taskId }), { code: 'SYSTEM_UPDATE_RETRY_LIMIT' });
  assert.equal(f.raw().job.status, 'failed'); assert.equal(f.raw().job.retiredRunners.length, 64);
  raw.job.retiredRunners = ['invalid runner id'];
  f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify(raw), SYSTEM_UPDATE_KEY);
  await assert.rejects(f.view(), { code: 'SYSTEM_UPDATE_STATE_INVALID' });
});

test('persisted upload intent cannot be reset or reported as a known failure when version identity is unknown', async t => {
  const f = fixture(t); await f.start(); const saved = receipt(); await f.report('building', { receipt: saved });
  saved.uploadStarted = true; await f.report('building', { receipt: saved });
  await assert.rejects(f.report('failed'), { code: 'SYSTEM_UPDATE_RESULT_UNKNOWN' });
  await f.report('activation_pending');
  await assert.rejects(f.report('building', { receipt: { ...saved, uploadStarted: false } }), { code: 'SYSTEM_UPDATE_RESULT_UNKNOWN' });
  saved.nextVersionId = nextVersion; await f.report('uploaded', { receipt: saved });
  assert.equal((await f.update.plan(f.env, request())).receipt.nextVersionId, nextVersion);
});

test('a plugin write between update preflight and reservation fails the SQL CAS rather than freezing a stale combination', async t => {
  const f = fixture(t); await f.configured(); const v = await f.update.check(f.env, f.owner, { revision: (await f.view()).revision });
  f.db.beforeRun = (sql, values) => {
    if (sql.startsWith('INSERT INTO instance_settings') && JSON.parse(values[1])?.job?.status === 'queued') {
      f.db.beforeRun = null;
      f.sqlite.prepare('INSERT INTO instance_settings VALUES(?,?,1,1,?)').run('plugin.registry', '{}', 'other-admin');
    }
  };
  await assert.rejects(f.update.start(f.env, f.owner, { revision: v.revision, releaseId: v.latest.id }), { code: 'SYSTEM_UPDATE_REVISION_MISMATCH' });
  assert.equal(f.raw().job, null);
});

test('hard-stopped CI stages become resumable only after expiry and preserve the frozen status and receipt', async t => {
  for (const status of ['building', 'uploaded', 'deploying', 'migrating', 'rolling_back']) {
    await t.test(status, async child => {
      const f = fixture(child);
      if (status === 'building') { await f.start(); await f.report('building', { receipt: receipt() }); }
      else {
        await f.uploaded();
        if (['deploying', 'migrating', 'rolling_back'].includes(status)) await f.report('deploying');
        if (status === 'migrating') { f.setRuntime(f.targetRuntime()); await f.report('migrating'); }
        if (status === 'rolling_back') await f.report('rolling_back');
      }
      const original = await f.update.plan(f.env, request());
      assert.equal((await f.view()).job.resumable, false);
      await assert.rejects(f.update.retry(f.env, f.owner, { revision: original.revision, taskId: original.taskId }), { code: 'SYSTEM_UPDATE_RETRY_UNAVAILABLE' });
      f.advance(180001);
      const expired = await f.view(); assert.equal(expired.job.resumable, true);
      assert.equal(expired.job.execution, undefined); assert.equal(expired.job.retiredRunners, undefined);
      const retried = await f.update.retry(f.env, f.owner, { revision: expired.revision, taskId: original.taskId });
      assert.equal(retried.job.status, status);
      assert.equal(retried.job.taskId, original.taskId); assert.equal(retried.job.planDigest, original.planDigest);
      assert.deepEqual(retried.job.receipt, original.receipt); assert.deepEqual(retried.job.target, original.target);
      await f.update.claim(f.env, request(), { taskId: original.taskId, planDigest: original.planDigest, runnerId: 'recovery-runner' });
      await assert.rejects(f.update.report(f.env, request(), { taskId: original.taskId, planDigest: original.planDigest,
        runnerId: 'runner-A', status }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
      await assert.rejects(f.update.claim(f.env, request(), { taskId: original.taskId, planDigest: original.planDigest,
        runnerId: 'runner-A' }), { code: 'SYSTEM_UPDATE_RUNNER_CHANGED' });
      if (status === 'migrating') {
        await assert.rejects(f.update.report(f.env, request(), { taskId: original.taskId, planDigest: original.planDigest,
          runnerId: 'recovery-runner', status: 'rolling_back' }), { code: 'SYSTEM_UPDATE_RECOVERY_UNAVAILABLE' });
        await f.update.migration(f.env, request(), { taskId: original.taskId, planDigest: original.planDigest, runnerId: 'recovery-runner' });
        await f.update.report(f.env, request(), { taskId: original.taskId, planDigest: original.planDigest, runnerId: 'recovery-runner', status: 'deployed' });
        assert.equal((await f.view()).job.resumable, false);
      }
    });
  }
});

test('a queued job that never obtained a runner is resumable after three minutes without manufacturing a receipt', async t => {
  const f = fixture(t); const started = await f.start();
  assert.equal(started.job.resumable, false);
  await assert.rejects(f.update.retry(f.env, f.owner, { revision: started.revision, taskId: started.job.taskId }), { code: 'SYSTEM_UPDATE_RETRY_UNAVAILABLE' });
  f.advance(180200);
  const expired = await f.view(); assert.equal(expired.job.resumable, true);
  const retry = await f.update.retry(f.env, f.owner, { revision: expired.revision, taskId: expired.job.taskId });
  assert.equal(retry.job.status, 'queued'); assert.equal(retry.job.receipt, null);
  assert.equal(retry.job.planDigest, started.job.planDigest); assert.equal(retry.job.taskId, started.job.taskId);
  const p = await f.update.plan(f.env, request());
  await f.update.claim(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'first-recovered-runner' });
  await f.update.report(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, runnerId: 'first-recovered-runner', status: 'building', receipt: receipt() });
  assert.equal((await f.view()).job.resumable, false);
});

test('pipeline maintenance handling still requires capability and cannot run arbitrary migration options', async t => {
  const f = fixture(t); await f.start();
  const json = (body, status = 200) => Response.json(body, { status });
  assert.equal((await handleSystemUpdatePipeline(request('wrong_token_123456789012345678901234567890'), '/api/system-update/plan', f.env,
    { state: 'maintenance' }, json, { update: f.update })).status, 403);
  assert.equal((await handleSystemUpdatePipeline(request(), '/api/system-update/plan', f.env,
    { state: 'recovery_required' }, json, { update: f.update })).status, 503);
  const p = await f.update.plan(f.env, request());
  await assert.rejects(f.update.migration(f.env, request(), { taskId: p.taskId, planDigest: p.planDigest, sql: 'DROP TABLE accounts' }), { code: 'SYSTEM_UPDATE_JOB_CHANGED' });
});

test('official release discovery rejects arbitrary source, prereleases and missing manifest assets', async () => {
  assert.throws(() => validateRelease({ ...target(), source: { url: 'https://evil.example/archive', sha256: 'a'.repeat(64) } }), { code: 'SYSTEM_UPDATE_RELEASE_INVALID' });
  const wanted = 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-update.json';
  const calls = []; const value = await discoverRelease({}, { fetchImpl: async url => { calls.push(url); return Response.json(calls.length === 1
    ? { tag_name: '1.3.0', draft: false, prerelease: false, assets: [{ name: 'flaretune-update.json', browser_download_url: wanted },
      { name: 'flaretune-source.tar.gz', browser_download_url: target().source.url }] } : target()); } });
  assert.equal(value.version, '1.3.0'); assert.equal(calls[1], wanted);
  await assert.rejects(discoverRelease({}, { fetchImpl: async () => Response.json({ tag_name: '1.3.0', draft: false, prerelease: true, assets: [] }) }), { code: 'SYSTEM_UPDATE_RELEASE_INVALID' });
  await assert.rejects(discoverRelease({}, { fetchImpl: async () => Response.json({ tag_name: '1.3.0', draft: false, prerelease: false, assets: [] }) }), { code: 'SYSTEM_UPDATE_RELEASE_UNAVAILABLE' });
  await assert.rejects(discoverRelease({}, { fetchImpl: async () => Response.json({ tag_name: '1.3.0', draft: false, prerelease: false,
    assets: [{ name: 'flaretune-update.json', browser_download_url: wanted }] }) }), { code: 'SYSTEM_UPDATE_RELEASE_UNAVAILABLE' });
  await assert.rejects(discoverRelease({ FLARETUNE_UPDATE_CANDIDATE_JSON: JSON.stringify({ ...target(), channel: 'stable' }) }), { code: 'SYSTEM_UPDATE_CANDIDATE_INVALID' });
  await assert.rejects(discoverRelease({}, { fetchImpl: async () => new Response('x'.repeat(65537)) }), { code: 'SYSTEM_UPDATE_RELEASE_INVALID' });
});
