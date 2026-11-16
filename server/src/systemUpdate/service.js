import { resolveInstanceState } from '../instance/state.js';
import { getSupplementalMigrationStatus } from '../instance/migrationStatus.js';
import { runKnownDatabaseUpgrade } from '../instance/upgradeDatabase.js';
import { canonical, compareVersions, digest, fail, keys, matchesToken, open, plain, requireAdmin,
  revision, seal, sessionBindings, sessionPredicate, sha256, uuid, validVersion } from './common.js';
import { boundedJson, discoverRelease, validateRelease } from './releases.js';

export const SYSTEM_UPDATE_KEY = 'system.update.v1';
const MAX_RETIRED_RUNNERS = 64;
const terminal = new Set(['deployed', 'rolled_back', 'failed']);
const states = new Set(['queued', 'building', 'uploaded', 'deploying', 'migrating', 'activation_pending', 'rolling_back', ...terminal]);
const transition = {
  queued: ['building', 'failed'], building: ['building', 'uploaded', 'failed', 'activation_pending'], uploaded: ['uploaded', 'deploying', 'failed'],
  deploying: ['deploying', 'migrating', 'activation_pending', 'rolling_back'],
  migrating: ['migrating', 'deployed', 'activation_pending'],
  activation_pending: ['activation_pending', 'building', 'uploaded', 'deploying', 'migrating', 'rolling_back'],
  rolling_back: ['rolling_back', 'rolled_back', 'activation_pending'], deployed: ['deployed'], rolled_back: ['rolled_back'], failed: ['failed'],
};
const initial = () => ({ schemaVersion: 1, secrets: null, latest: null, checkedAt: null, job: null });
const clone = value => structuredClone(value);
const validHost = value => keys(value, ['version', 'sourceDigest']) && validVersion(value.version) && digest(value.sourceDigest);
const hostOf = value => ({ version: value.version, sourceDigest: value.sourceDigest });
const active = job => job && (!terminal.has(job.status) || (job.receipt?.migrationStarted && job.status !== 'deployed'));
const tokenFrom = request => /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('Authorization') || '')?.[1];
const safeError = value => /^SYSTEM_UPDATE_[A-Z_]{1,70}$/.test(value || '') ? value : 'SYSTEM_UPDATE_FAILED';

function hookUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/api\.cloudflare\.com\/client\/v4\/workers\/builds\/deploy_hooks\/[A-Za-z0-9_-]{16,160}$/.test(value)) {
    fail('SYSTEM_UPDATE_INVALID_INPUT', 400);
  }
  return value;
}

function receiptValue(input, previous = null) {
  if (!keys(input, ['schemaVersion', 'accountId', 'workerName', 'targetTag', 'previous', 'nextVersionId', 'bindingDigest', 'uploadStarted', 'migrationStarted', 'migrationCompleted'])
    || input.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(input.accountId || '')
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.workerName || '')
    || (input.targetTag !== undefined && !/^[a-f0-9]{32}$/.test(input.targetTag))
    || (input.bindingDigest !== undefined && !digest(input.bindingDigest))
    || !keys(input.previous, ['id', 'strategy', 'versions']) || !uuid(input.previous.id) || input.previous.strategy !== 'percentage'
    || !Array.isArray(input.previous.versions) || input.previous.versions.length < 1 || input.previous.versions.length > 8
    || !input.previous.versions.every(item => keys(item, ['version_id', 'percentage']) && uuid(item.version_id)
      && typeof item.percentage === 'number' && item.percentage > 0 && item.percentage <= 100)
    || new Set(input.previous.versions.map(item => item.version_id)).size !== input.previous.versions.length
    || Math.abs(input.previous.versions.reduce((sum, item) => sum + item.percentage, 0) - 100) > 0.000001
    || !(input.nextVersionId === null || uuid(input.nextVersionId))
    || (input.uploadStarted !== undefined && typeof input.uploadStarted !== 'boolean')
    || (input.nextVersionId !== null && input.uploadStarted !== true)
    || typeof input.migrationStarted !== 'boolean' || typeof input.migrationCompleted !== 'boolean'
    || (input.migrationCompleted && !input.migrationStarted)) fail('SYSTEM_UPDATE_RECEIPT_INVALID', 400);
  if (previous && (['schemaVersion', 'accountId', 'workerName', 'previous', 'targetTag', 'bindingDigest'].some(key =>
    previous[key] !== undefined && canonical(previous[key]) !== canonical(input[key]))
    || (previous.nextVersionId !== null && previous.nextVersionId !== input.nextVersionId)
    || (previous.uploadStarted && !input.uploadStarted)
    || (previous.migrationStarted && !input.migrationStarted) || (previous.migrationCompleted && !input.migrationCompleted))) {
    fail('SYSTEM_UPDATE_RECEIPT_INVALID');
  }
  return { ...clone(input), uploadStarted: input.uploadStarted === true };
}

let generated;
async function defaultRuntime() {
  generated ||= import('../../../shared/systemUpdate.generated.js');
  return (await generated).systemUpdateRuntime;
}

export function createSystemUpdate({ fetchImpl = (...args) => fetch(...args), runtime = defaultRuntime, clock = Date.now,
  discover = discoverRelease, state = resolveInstanceState, supplemental = getSupplementalMigrationStatus,
  migrate = runKnownDatabaseUpgrade, requireAdminImpl = requireAdmin } = {}) {
  async function read(env) {
    const saved = await env.DB.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(SYSTEM_UPDATE_KEY).first();
    if (!saved) return { revision: 0, value: initial() };
    try {
      const value = JSON.parse(saved.value_json);
      if (value.schemaVersion !== 1 || (value.job && !states.has(value.job.status)) || !revision(saved.revision)) throw Error();
      if (value.job?.retiredRunners !== undefined && (!Array.isArray(value.job.retiredRunners)
        || value.job.retiredRunners.length > MAX_RETIRED_RUNNERS || !value.job.retiredRunners.every(validRunner)
        || new Set(value.job.retiredRunners).size !== value.job.retiredRunners.length)) throw Error();
      if (value.job?.execution && (!keys(value.job.execution, ['runnerId', 'leaseExpiresAt']) || !validRunner(value.job.execution.runnerId)
        || !Number.isSafeInteger(value.job.execution.leaseExpiresAt) || value.job.execution.leaseExpiresAt <= 0
        || value.job.retiredRunners?.includes(value.job.execution.runnerId))) throw Error();
      return { revision: saved.revision, value };
    } catch { fail('SYSTEM_UPDATE_STATE_INVALID', 503); }
  }
  async function save(env, record, value, session, controls) {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).length > 1000000) fail('SYSTEM_UPDATE_STATE_TOO_LARGE', 400);
    const sql = `INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      SELECT ?,?,1,?,? WHERE COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
      ${session ? `AND ${sessionPredicate}` : ''}
      ${controls ? `AND COALESCE((SELECT revision FROM instance_settings WHERE key='plugin.delivery.v1'),0)=?
        AND COALESCE((SELECT revision FROM instance_settings WHERE key='plugin.registry'),0)=?` : ''}
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by`;
    const result = await env.DB.prepare(sql).bind(SYSTEM_UPDATE_KEY, serialized, Date.now(), session?.account.accountId || 'system-update',
      SYSTEM_UPDATE_KEY, record.revision, ...(session ? sessionBindings(session) : []),
      ...(controls ? [controls.deliveryRevision, controls.registryRevision] : [])).run();
    if (result?.meta?.changes !== 1) fail('SYSTEM_UPDATE_REVISION_MISMATCH');
    return { revision: record.revision + 1, value };
  }
  async function current(env) {
    let info; try { info = await (typeof runtime === 'function' ? runtime(env) : runtime); } catch { fail('SYSTEM_UPDATE_RUNTIME_UNAVAILABLE', 503); }
    if (!plain(info) || !validHost(hostOf(info)) || !Number.isSafeInteger(info.hostApiVersion) || !Array.isArray(info.plugins)) {
      fail('SYSTEM_UPDATE_RUNTIME_UNAVAILABLE', 503);
    }
    const rows = (await env.DB.prepare("SELECT key,value_json,revision FROM instance_settings WHERE key LIKE 'plugin.installation.%' OR key IN ('plugin.delivery.v1','plugin.registry')").all()).results || [];
    let delivery;
    try { delivery = JSON.parse(rows.find(row => row.key === 'plugin.delivery.v1')?.value_json || 'null'); } catch { fail('SYSTEM_UPDATE_PLUGIN_INCOMPATIBLE'); }
    const installed = [];
    for (const row of rows.filter(item => item.key.startsWith('plugin.installation.'))) {
      let saved; try { saved = JSON.parse(row.value_json); } catch { fail('SYSTEM_UPDATE_PLUGIN_INCOMPATIBLE'); }
      if (saved.installed !== true) continue;
      const id = row.key.slice('plugin.installation.'.length), built = info.plugins.find(item => item.id === id);
      if (!built || !validVersion(built.version) || !plain(built.source) || built.source.type !== 'artifact' || !digest(built.source.sha256)
        || !plain(built.manifest) || built.manifest.id !== id || built.manifest.version !== built.version || !uuid(saved.epoch) || !revision(row.revision)) {
        fail('SYSTEM_UPDATE_PLUGIN_INCOMPATIBLE');
      }
      const selected = delivery?.running?.find(item => item.id === id);
      if (selected && (selected.version !== built.version || canonical(selected.source) !== canonical(built.source))) fail('SYSTEM_UPDATE_INSTALLATION_CHANGED');
      installed.push({ ...clone(built), installation: { epoch: saved.epoch, revision: row.revision } });
    }
    installed.sort((a, b) => a.id.localeCompare(b.id));
    return { ...hostOf(info), ...(info.commit ? { commit: info.commit } : {}), hostApiVersion: info.hostApiVersion, plugins: installed, delivery,
      controls: { deliveryRevision: rows.find(row => row.key === 'plugin.delivery.v1')?.revision || 0,
        registryRevision: rows.find(row => row.key === 'plugin.registry')?.revision || 0 } };
  }
  async function blocking(env, record) {
    if (active(record.value.job)) return 'SYSTEM_UPDATE_IN_PROGRESS';
    try {
      const info = await current(env), delivery = info.delivery;
      if (delivery?.build && !['deployed', 'failed', 'cancelled', 'rolled_back'].includes(delivery.build.status)) return 'SYSTEM_UPDATE_PLUGIN_BUILD_BUSY';
      if (delivery?.desired !== null && delivery?.desired !== undefined) return 'SYSTEM_UPDATE_PLUGIN_PENDING';
    } catch (error) { return safeError(error.code); }
    return null;
  }
  function expiredExecution(job) {
    if (!active(job)) return false;
    if (job.execution) return job.execution.leaseExpiresAt <= clock();
    const timestamps = [job.createdAt, job.updatedAt];
    return timestamps.every(value => Number.isSafeInteger(value) && value > 0)
      && Math.max(...timestamps) + 180000 <= clock();
  }
  function resumable(job) {
    if (!job) return false;
    if (job.status === 'activation_pending') return true;
    if (job.status === 'failed') return !job.receipt?.migrationStarted && !(job.receipt?.uploadStarted && !job.receipt?.nextVersionId);
    return expiredExecution(job);
  }
  async function view(env, record) {
    const secrets = record.value.secrets ? await open(env, record.value.secrets) : {};
    let info = null, currentError = null;
    try { info = await current(env); delete info.delivery; delete info.controls; } catch (error) { currentError = safeError(error.code); }
    return { revision: record.revision, configured: Boolean(secrets.deployHookUrl && secrets.buildToken),
      configuration: { hookConfigured: Boolean(secrets.deployHookUrl), tokenConfigured: Boolean(secrets.buildToken) },
      channel: env.FLARETUNE_UPDATE_CANDIDATE_JSON === undefined ? 'stable' : 'candidate', current: info,
      latest: record.value.latest, checkedAt: record.value.checkedAt,
      job: record.value.job ? { ...Object.fromEntries(Object.entries(clone(record.value.job)).filter(([key]) => !['execution', 'retiredRunners'].includes(key))),
        resumable: resumable(record.value.job) } : null,
      blockingReason: currentError || await blocking(env, record) };
  }
  async function adminRecord(env, session, input, allowed = []) {
    await requireAdminImpl(env, session);
    if (!keys(input, ['revision', ...allowed]) || !revision(input.revision)) fail('SYSTEM_UPDATE_INVALID_INPUT', 400);
    const record = await read(env);
    if (input.revision !== record.revision) fail('SYSTEM_UPDATE_REVISION_MISMATCH');
    return record;
  }
  async function get(env, session) { await requireAdminImpl(env, session); return view(env, await read(env)); }
  async function configure(env, session, input) {
    const record = await adminRecord(env, session, input, ['deployHookUrl', 'buildToken']);
    if (active(record.value.job)) fail('SYSTEM_UPDATE_IN_PROGRESS');
    const secrets = record.value.secrets ? await open(env, record.value.secrets) : {};
    for (const field of ['deployHookUrl', 'buildToken']) if (input[field] !== undefined) {
      if (input[field] === '') delete secrets[field];
      else if (field === 'deployHookUrl') secrets[field] = hookUrl(input[field]);
      else if (typeof input[field] === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(input[field])) secrets[field] = input[field];
      else fail('SYSTEM_UPDATE_INVALID_INPUT', 400);
    }
    return view(env, await save(env, record, { ...record.value, secrets: await seal(env, secrets) }, session));
  }
  async function check(env, session, input) {
    const record = await adminRecord(env, session, input);
    if (active(record.value.job)) fail('SYSTEM_UPDATE_IN_PROGRESS');
    const latest = await discover(env, { fetchImpl });
    const valid = validateRelease(latest, { channel: latest.channel });
    return view(env, await save(env, record, { ...record.value, latest: valid, checkedAt: Date.now() }, session));
  }
  async function trigger(env, record, session) {
    const taskId = record.value.job.taskId, secrets = record.value.secrets ? await open(env, record.value.secrets) : {};
    if (!secrets.deployHookUrl || !secrets.buildToken) fail('SYSTEM_UPDATE_NOT_CONFIGURED', 409);
    let providerBuildId = null, failed = false;
    try {
      // Workers supports only manual/follow; boundedJson rejects every 3xx
      // without forwarding the capability URL to a redirected destination.
      const response = await fetchImpl(hookUrl(secrets.deployHookUrl), { method: 'POST', redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const body = await boundedJson(response, 32768);
      if (!response.ok || body.success !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(body.result?.build_uuid || '')) throw Error();
      providerBuildId = body.result.build_uuid;
    } catch { failed = true; }
    const fresh = await read(env);
    if (fresh.value.job?.taskId !== taskId) return view(env, fresh);
    const value = clone(fresh.value), job = value.job;
    if (providerBuildId) job.providerBuildId = providerBuildId;
    if (failed && ['queued', 'failed'].includes(job.status)) { job.status = 'activation_pending'; job.error = 'SYSTEM_UPDATE_TRIGGER_FAILED'; }
    job.updatedAt = Date.now();
    return view(env, await save(env, fresh, value, session));
  }
  async function start(env, session, input) {
    const record = await adminRecord(env, session, input, ['releaseId']);
    const reason = await blocking(env, record); if (reason) fail(reason);
    const secrets = record.value.secrets ? await open(env, record.value.secrets) : {};
    if (!secrets.deployHookUrl || !secrets.buildToken) fail('SYSTEM_UPDATE_NOT_CONFIGURED');
    const target = record.value.latest;
    if (!target || input.releaseId !== target.id) fail('SYSTEM_UPDATE_TARGET_CHANGED');
    validateRelease(target, { channel: target.channel });
    if (target.channel === 'candidate') {
      let configured;
      try { configured = validateRelease(JSON.parse(env.FLARETUNE_UPDATE_CANDIDATE_JSON), { channel: 'candidate' }); }
      catch { fail('SYSTEM_UPDATE_TARGET_CHANGED'); }
      if (canonical(configured) !== canonical(target)) fail('SYSTEM_UPDATE_TARGET_CHANGED');
    }
    const info = await current(env), comparison = compareVersions(target.version, info.version);
    if (compareVersions(info.version, target.minVersion) < 0 || comparison < 0) fail('SYSTEM_UPDATE_VERSION_UNSUPPORTED');
    if ((target.channel === 'stable' && comparison <= 0) || canonical(target.host) === canonical(hostOf(info))) fail('SYSTEM_UPDATE_ALREADY_CURRENT');
    if (info.plugins.some(item => item.manifest?.hostApiVersion > target.hostApiVersion)) fail('SYSTEM_UPDATE_PLUGIN_INCOMPATIBLE');
    const from = { host: hostOf(info), ...(info.commit ? { commit: info.commit } : {}), hostApiVersion: info.hostApiVersion };
    const taskId = crypto.randomUUID(), plan = { from, target, plugins: info.plugins };
    const now = Date.now(), value = clone(record.value);
    value.job = { taskId, planDigest: await sha256(canonical(plan)), status: 'queued', ...clone(plan), receipt: null,
      createdAt: now, updatedAt: now, error: null };
    return trigger(env, await save(env, record, value, session, info.controls), session);
  }
  async function retry(env, session, input) {
    const record = await adminRecord(env, session, input, ['taskId']);
    if (record.value.job?.taskId !== input.taskId
      || (!['failed', 'activation_pending'].includes(record.value.job.status) && !expiredExecution(record.value.job))) fail('SYSTEM_UPDATE_RETRY_UNAVAILABLE');
    if (record.value.job.status === 'failed' && (record.value.job.receipt?.migrationStarted
      || (record.value.job.receipt?.uploadStarted && !record.value.job.receipt?.nextVersionId))) fail('SYSTEM_UPDATE_RESULT_UNKNOWN');
    const value = clone(record.value);
    if (value.job.status === 'failed') {
      // A known pre-promotion failure can hand off immediately. Retiring the
      // previous execution identity also fences a late heartbeat or old CI
      // process from reclaiming this same task after it returns to queued.
      const oldRunner = value.job.execution?.runnerId;
      if (oldRunner) retireRunner(value.job, oldRunner);
      value.job.execution = null;
      value.job.status = 'queued';
    }
    value.job.error = null; value.job.updatedAt = Date.now();
    return trigger(env, await save(env, record, value, session), session);
  }
  async function recover(env, session, input) {
    const record = await adminRecord(env, session, input, ['taskId']);
    if (record.value.job?.taskId !== input.taskId || !['deploying', 'activation_pending', 'uploaded'].includes(record.value.job.status)
      || !record.value.job.receipt?.nextVersionId || record.value.job.receipt?.migrationStarted) fail('SYSTEM_UPDATE_RECOVERY_UNAVAILABLE');
    const value = clone(record.value); value.job.status = 'rolling_back'; value.job.updatedAt = Date.now();
    return trigger(env, await save(env, record, value, session), session);
  }
  async function pipeline(env, request) {
    const record = await read(env), secrets = record.value.secrets ? await open(env, record.value.secrets) : {};
    if (!await matchesToken(tokenFrom(request), secrets.buildToken)) fail('forbidden', 403);
    if (!record.value.job) fail('SYSTEM_UPDATE_JOB_UNAVAILABLE', 404);
    return record;
  }
  const planView = record => ({ schemaVersion: 1, revision: record.revision,
    ...Object.fromEntries(Object.entries(clone(record.value.job)).filter(([key]) => key !== 'retiredRunners')) });
  async function plan(env, request) { return planView(await pipeline(env, request)); }
  function matchJob(record, input, extra = []) {
    if (!keys(input, ['taskId', 'planDigest', ...extra]) || input.taskId !== record.value.job?.taskId || input.planDigest !== record.value.job?.planDigest) fail('SYSTEM_UPDATE_JOB_CHANGED');
  }
  const validRunner = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  function retireRunner(job, runnerId) {
    const retired = job.retiredRunners || [];
    if (retired.includes(runnerId)) return;
    if (retired.length >= MAX_RETIRED_RUNNERS) fail('SYSTEM_UPDATE_RETRY_LIMIT');
    job.retiredRunners = [...retired, runnerId];
  }
  function requireRunner(job, runnerId) {
    if (!validRunner(runnerId) || job.execution?.runnerId !== runnerId || job.execution.leaseExpiresAt <= clock()) fail('SYSTEM_UPDATE_RUNNER_CHANGED');
  }
  async function claim(env, request, input) {
    const record = await pipeline(env, request); matchJob(record, input, ['runnerId']);
    if (!validRunner(input.runnerId)) fail('SYSTEM_UPDATE_INVALID_INPUT', 400);
    if (record.value.job.retiredRunners?.includes(input.runnerId)) fail('SYSTEM_UPDATE_RUNNER_CHANGED');
    if (['failed', 'rolled_back'].includes(record.value.job.status)) fail('SYSTEM_UPDATE_RETRY_REQUIRED');
    const execution = record.value.job.execution;
    if (execution && execution.runnerId !== input.runnerId && execution.leaseExpiresAt > clock()) fail('SYSTEM_UPDATE_RUNNER_BUSY');
    const value = clone(record.value);
    if (execution && execution.runnerId !== input.runnerId) retireRunner(value.job, execution.runnerId);
    value.job.execution = { runnerId: input.runnerId, leaseExpiresAt: clock() + 180000 };
    const saved = await save(env, record, value);
    return { taskId: value.job.taskId, planDigest: value.job.planDigest, ...value.job.execution, revision: saved.revision };
  }
  async function actualMatches(env, job, expectedHost) {
    const info = await current(env);
    if (canonical(hostOf(info)) !== canonical(expectedHost)) fail('SYSTEM_UPDATE_RUNTIME_MISMATCH');
    if (canonical(info.plugins) !== canonical(job.plugins)) fail('SYSTEM_UPDATE_INSTALLATION_CHANGED');
  }
  async function databaseReady(env) {
    return (await state(env.DB)).state === 'ready' && (await supplemental(env.DB)).supplementalPending === false;
  }
  async function report(env, request, input) {
    const record = await pipeline(env, request); matchJob(record, input, ['status', 'receipt', 'error', 'runnerId']);
    const old = record.value.job;
    requireRunner(old, input.runnerId);
    if (['rolling_back', 'rolled_back'].includes(input.status) && old.receipt?.migrationStarted) fail('SYSTEM_UPDATE_RECOVERY_UNAVAILABLE');
    if (!states.has(input.status) || !transition[old.status].includes(input.status)
      || (terminal.has(old.status) && input.status !== old.status)) fail('SYSTEM_UPDATE_TRANSITION_INVALID');
    const value = clone(record.value), job = value.job;
    if (old.status === 'activation_pending' && input.status === 'building') {
      if (old.receipt?.nextVersionId || old.receipt?.uploadStarted || old.receipt?.migrationStarted) fail('SYSTEM_UPDATE_RESULT_UNKNOWN');
      await actualMatches(env, old, old.from.host);
    }
    if (old.status === 'activation_pending' && input.status === 'uploaded') {
      if (!old.receipt?.uploadStarted || old.receipt?.migrationStarted) fail('SYSTEM_UPDATE_RESULT_UNKNOWN');
      await actualMatches(env, old, old.from.host);
    }
    if (old.status === 'activation_pending' && input.status === 'deploying') {
      if (!old.receipt?.nextVersionId || old.receipt.migrationStarted) fail('SYSTEM_UPDATE_RESULT_UNKNOWN');
      await actualMatches(env, old, old.from.host);
    }
    if (input.receipt !== undefined) {
      if ((input.receipt?.migrationStarted === true && job.receipt?.migrationStarted !== true && input.status !== 'migrating')
        || (input.receipt?.migrationCompleted === true && job.receipt?.migrationCompleted !== true)) fail('SYSTEM_UPDATE_RECEIPT_INVALID');
      job.receipt = receiptValue(input.receipt, job.receipt);
    }
    if (['uploaded', 'deploying', 'migrating', 'deployed', 'rolling_back', 'rolled_back'].includes(input.status) && !job.receipt?.nextVersionId) fail('SYSTEM_UPDATE_RECEIPT_INVALID');
    if (['migrating', 'deployed'].includes(input.status)) await actualMatches(env, job, job.target.host);
    if (input.status === 'migrating') job.receipt.migrationStarted = true;
    if (['rolling_back', 'rolled_back'].includes(input.status) && job.receipt?.migrationStarted) fail('SYSTEM_UPDATE_RECOVERY_UNAVAILABLE');
    if (input.status === 'rolled_back') await actualMatches(env, job, job.from.host);
    if (input.status === 'deployed' && (!job.receipt.migrationCompleted || !await databaseReady(env))) fail('SYSTEM_UPDATE_MIGRATION_REQUIRED');
    if (input.status === 'failed' && (job.receipt?.migrationStarted || (job.receipt?.uploadStarted && !job.receipt?.nextVersionId)
      || ['deploying', 'migrating', 'activation_pending', 'rolling_back'].includes(old.status))) fail('SYSTEM_UPDATE_RESULT_UNKNOWN');
    if (terminal.has(old.status)) return { ok: true, taskId: job.taskId, status: job.status, revision: record.revision };
    job.status = input.status; job.updatedAt = Date.now(); job.error = input.error ? safeError(input.error) : null;
    job.execution.leaseExpiresAt = clock() + 180000;
    const saved = await save(env, record, value);
    return { ok: true, taskId: job.taskId, status: job.status, revision: saved.revision };
  }
  async function migration(env, request, input) {
    const record = await pipeline(env, request); matchJob(record, input, ['runnerId']);
    const job = record.value.job;
    requireRunner(job, input.runnerId);
    if (!['migrating', 'activation_pending'].includes(job.status) || !job.receipt?.migrationStarted) fail('SYSTEM_UPDATE_MIGRATION_UNAVAILABLE');
    await actualMatches(env, job, job.target.host);
    if (job.receipt.migrationCompleted) return { taskId: job.taskId, status: 'current', migrationCompleted: true };
    const result = await migrate(env.DB, { allowDestructive: false });
    const complete = await databaseReady(env), fresh = await read(env); matchJob(fresh, input, ['runnerId']);
    requireRunner(fresh.value.job, input.runnerId);
    if (fresh.value.job.status === 'deployed') return { taskId: job.taskId, ...result, migrationCompleted: true };
    const value = clone(fresh.value); value.job.receipt.migrationCompleted ||= complete; value.job.updatedAt = Date.now();
    value.job.execution.leaseExpiresAt = clock() + 180000;
    await save(env, fresh, value);
    return { taskId: job.taskId, ...result, migrationCompleted: complete };
  }
  return Object.freeze({ get, configure, check, start, retry, recover, claim, plan, report, migration });
}

export const systemUpdate = createSystemUpdate();
export async function systemUpdateBusy(env) {
  if (!env?.DB?.prepare) return false;
  try {
    const row = await env.DB.prepare('SELECT value_json FROM instance_settings WHERE key=?').bind(SYSTEM_UPDATE_KEY).first();
    return Boolean(row && active(JSON.parse(row.value_json)?.job));
  } catch (error) { return !/no such table:\s*instance_settings\b/i.test(error?.message || ''); }
}
export async function systemUpdateMaintenance(env) {
  if (!env?.DB?.prepare) return false;
  try {
    const row = await env.DB.prepare('SELECT value_json FROM instance_settings WHERE key=?').bind(SYSTEM_UPDATE_KEY).first();
    if (!row) return false;
    const job = JSON.parse(row.value_json)?.job;
    // Close on the old version before promotion. Unknown cutover results and
    // rollback stay closed until the durable task confirms a safe endpoint.
    return Boolean(job && (job.status === 'deploying' || job.status === 'rolling_back'
      || (job.status === 'activation_pending' && job.receipt?.nextVersionId)
      || (job.receipt?.migrationStarted && job.status !== 'deployed')));
  } catch (error) { return !/no such table:\s*instance_settings\b/i.test(error?.message || ''); }
}
