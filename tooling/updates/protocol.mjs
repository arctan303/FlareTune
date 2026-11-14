import { canonical, sha256, plain, keys, uuid, digest, validVersion, revision } from '../../server/src/systemUpdate/common.js';
import { validateRelease } from '../../server/src/systemUpdate/releases.js';
import { publicHttpsUrl, readBoundedResponse, validateDeliveryPlan } from '../plugins/assemble.mjs';

export const fail = code => { throw Object.assign(new Error(code), { code }); };
export const UPDATE_STATUSES = new Set(['queued', 'building', 'uploaded', 'deploying', 'migrating', 'deployed',
  'activation_pending', 'rolling_back', 'rolled_back', 'failed']);
export function updateConnection(environment = process.env) {
  const configured = environment.FLARETUNE_SYSTEM_UPDATE_SITE_URL, token = environment.FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN;
  if (typeof configured !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) fail('SYSTEM_UPDATE_CONNECTION_MISSING');
  const site = new URL(publicHttpsUrl(configured));
  if (site.pathname !== '/' || site.search) fail('SYSTEM_UPDATE_CONNECTION_INVALID');
  const runnerId = environment.FLARETUNE_SYSTEM_UPDATE_RUNNER_ID || environment.WORKERS_CI_BUILD_UUID || crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runnerId)) fail('SYSTEM_UPDATE_RUNNER_INVALID');
  return { origin: site.origin, token, runnerId, channel: environment.FLARETUNE_SYSTEM_UPDATE_CHANNEL || 'stable' };
}
export function deploymentRecord(value) {
  if (!keys(value, ['id', 'strategy', 'versions']) || !uuid(value.id) || value.strategy !== 'percentage'
    || !Array.isArray(value.versions) || value.versions.length < 1 || value.versions.length > 2
    || new Set(value.versions.map(row => row.version_id)).size !== value.versions.length
    || value.versions.some(row => !keys(row, ['version_id', 'percentage']) || !uuid(row.version_id)
      || typeof row.percentage !== 'number' || row.percentage <= 0 || row.percentage > 100)
    || Math.abs(value.versions.reduce((sum, row) => sum + row.percentage, 0) - 100) > 0.0001) fail('SYSTEM_UPDATE_RECEIPT_INVALID');
  return structuredClone(value);
}
export function validateReceipt(value) {
  if (!keys(value, ['schemaVersion', 'accountId', 'workerName', 'targetTag', 'previous', 'nextVersionId', 'bindingDigest', 'uploadStarted', 'migrationStarted', 'migrationCompleted'])
    || value.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(value.accountId || '') || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.workerName || '')
    || value.targetTag !== undefined && !/^[a-f0-9]{32}$/.test(value.targetTag)
    || value.bindingDigest !== undefined && !digest(value.bindingDigest)
    || value.nextVersionId !== null && !uuid(value.nextVersionId)
    || value.uploadStarted !== undefined && typeof value.uploadStarted !== 'boolean'
    || value.nextVersionId !== null && value.uploadStarted !== true
    || typeof value.migrationStarted !== 'boolean' || typeof value.migrationCompleted !== 'boolean'
    || value.migrationCompleted && !value.migrationStarted) fail('SYSTEM_UPDATE_RECEIPT_INVALID');
  deploymentRecord(value.previous);
  return structuredClone(value);
}
export async function validateUpdatePlan(value, { channel = 'stable' } = {}) {
  if (!plain(value) || value.schemaVersion !== 1 || !uuid(value.taskId) || !digest(value.planDigest) || !UPDATE_STATUSES.has(value.status)
    || !revision(value.revision) || !keys(value.from, ['host', 'commit', 'hostApiVersion'])
    || !keys(value.from.host, ['version', 'sourceDigest']) || !validVersion(value.from.host.version) || !digest(value.from.host.sourceDigest)
    || value.from.commit !== undefined && !/^[a-f0-9]{40}$/.test(value.from.commit)
    || !Number.isSafeInteger(value.from.hostApiVersion) || value.from.hostApiVersion < 1) fail('SYSTEM_UPDATE_PLAN_INVALID');
  validateRelease(value.target, { channel });
  if (!Array.isArray(value.plugins) || value.plugins.some(row => !keys(row, ['id', 'version', 'manifest', 'source', 'installation'])
    || row.source?.type !== 'artifact' || !keys(row.installation, ['epoch', 'revision']) || !uuid(row.installation.epoch)
    || !revision(row.installation.revision))) fail('SYSTEM_UPDATE_PLAN_INVALID');
  validateDeliveryPlan({ host: value.target.host, plugins: value.plugins.map(({ installation, ...entry }) => entry) });
  if (await sha256(canonical({ from: value.from, target: value.target, plugins: value.plugins })) !== value.planDigest) fail('SYSTEM_UPDATE_PLAN_DIGEST_MISMATCH');
  if (value.receipt !== null) validateReceipt(value.receipt);
  return structuredClone(value);
}

async function request(connection, path, { fetchImpl = fetch, body, optional = false, timeoutMs = 60000 } = {}) {
  let response;
  try {
    response = await fetchImpl(`${connection.origin}/api/system-update/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(Math.max(1, Math.min(60000, Math.ceil(timeoutMs)))),
      headers: { Accept: 'application/json', Authorization: `Bearer ${connection.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { fail('SYSTEM_UPDATE_REQUEST_UNCONFIRMED'); }
  if (!response.ok) {
    let remoteCode;
    try {
      const bytes = await readBoundedResponse(new Response(response.body, { status: 200, headers: response.headers }), 4096);
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const candidate = data.error || data.code;
      if (typeof candidate === 'string' && /^SYSTEM_UPDATE_[A-Z_]{1,70}$/.test(candidate)) remoteCode = candidate;
    } catch { /* Untrusted or oversized error text never enters logs or retry decisions. */ }
    if (optional && response.status === 404 && remoteCode === 'SYSTEM_UPDATE_JOB_UNAVAILABLE') return null;
    await response.body?.cancel().catch(() => {});
    const error = Object.assign(new Error('SYSTEM_UPDATE_REQUEST_REJECTED'), { code: 'SYSTEM_UPDATE_REQUEST_REJECTED',
      confirmedRejected: response.status >= 400 && response.status < 500, httpStatus: response.status, ...(remoteCode ? { remoteCode } : {}) });
    throw error;
  }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedResponse(response, 2 * 1024 * 1024))); }
  catch { fail('SYSTEM_UPDATE_RESPONSE_INVALID'); }
  return data;
}
export async function fetchUpdatePlan(connection, options = {}) {
  const plan = await request(connection, 'plan', { ...options, optional: true });
  return plan === null ? null : validateUpdatePlan(plan, { channel: connection.channel });
}
export async function currentUpdatePlan(connection, expected, options = {}) {
  const current = await fetchUpdatePlan(connection, options);
  if (!current || current.taskId !== expected.taskId || current.planDigest !== expected.planDigest) fail('SYSTEM_UPDATE_PLAN_CHANGED');
  return current;
}
function mutation(connection, action) {
  const pending = (connection.pendingMutation || Promise.resolve()).catch(() => {}).then(action);
  connection.pendingMutation = pending;
  return pending;
}
export async function reportUpdate(connection, plan, status, { receipt, error, fetchImpl = fetch } = {}) {
  if (!UPDATE_STATUSES.has(status)) fail('SYSTEM_UPDATE_REPORT_INVALID');
  if (receipt) validateReceipt(receipt);
  const failure = error && /^SYSTEM_UPDATE_[A-Z_]{1,70}$/.test(error) ? error : error ? 'SYSTEM_UPDATE_BUILD_FAILED' : undefined;
  return mutation(connection, () => request(connection, 'report', { fetchImpl, body: { taskId: plan.taskId, planDigest: plan.planDigest, runnerId: connection.runnerId, status,
    ...(receipt ? { receipt } : {}), ...(failure ? { error: failure } : {}) } }));
}
export async function migrateUpdate(connection, plan, options = {}) {
  const result = await mutation(connection, () => request(connection, 'migration', { ...options, body: { taskId: plan.taskId, planDigest: plan.planDigest, runnerId: connection.runnerId } }));
  if (result?.taskId !== plan.taskId || !['current', 'completed', 'already_completed', 'in_progress', 'lease_busy'].includes(result.status)
    || typeof result.migrationCompleted !== 'boolean') fail('SYSTEM_UPDATE_RESPONSE_INVALID');
  return result;
}
export async function claimUpdate(connection, plan, options = {}) {
  const result = await mutation(connection, () => request(connection, 'claim', { ...options, body: { taskId: plan.taskId, planDigest: plan.planDigest, runnerId: connection.runnerId } }));
  if (result?.taskId !== plan.taskId || result.planDigest !== plan.planDigest || result.runnerId !== connection.runnerId
    || !Number.isSafeInteger(result.leaseExpiresAt) || result.leaseExpiresAt <= Date.now() || !revision(result.revision)) fail('SYSTEM_UPDATE_LEASE_INVALID');
  return result;
}
export async function withUpdateLease(connection, plan, run, { fetchImpl = fetch, heartbeatMs = 45000,
  initialWaitMs = 185000, initialWaitIntervalMs = 3000, sleepImpl = delay => new Promise(accept => setTimeout(accept, delay)),
  nowImpl = () => performance.now() } = {}) {
  const controller = new AbortController(); let active = null, leaseExpiresAt = 0;
  const renew = () => {
    if (controller.signal.aborted) fail('SYSTEM_UPDATE_LEASE_LOST');
    if (active) return active;
    active = claimUpdate(connection, plan, { fetchImpl }).then(result => { leaseExpiresAt = result.leaseExpiresAt; return result; })
      .catch(error => { controller.abort(); throw error; }).finally(() => { active = null; });
    return active;
  };
  // Only the initial acquisition may wait for an existing builder. A heartbeat
  // losing ownership must abort immediately, rather than wait and resume stale
  // work after another builder has taken over the same persistent receipt.
  const budget = Math.max(0, Math.min(185000, Number.isFinite(initialWaitMs) ? initialWaitMs : 185000));
  const interval = Math.max(2000, Math.min(5000, Number.isFinite(initialWaitIntervalMs) ? initialWaitIntervalMs : 3000));
  const deadline = nowImpl() + budget, attempts = Math.ceil(budget / interval) + 1;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - nowImpl();
    try {
      const result = await claimUpdate(connection, plan, { fetchImpl,
        timeoutMs: budget === 0 && attempt === 0 ? 60000 : Math.max(1, Math.min(60000, remaining)) });
      leaseExpiresAt = result.leaseExpiresAt; break;
    } catch (error) {
      const wait = deadline - nowImpl();
      if (error.httpStatus !== 409 || error.remoteCode !== 'SYSTEM_UPDATE_RUNNER_BUSY' || wait <= 0 || attempt + 1 >= attempts) throw error;
      await sleepImpl(Math.min(interval, wait));
    }
  }
  const timer = setInterval(() => {
    if (active || controller.signal.aborted) return;
    renew().catch(() => {});
  }, heartbeatMs);
  timer.unref?.();
  const lease = { signal: controller.signal, renew, check: () => {
    if (controller.signal.aborted || leaseExpiresAt <= Date.now()) { controller.abort(); fail('SYSTEM_UPDATE_LEASE_LOST'); }
  } };
  try { return await run(lease); }
  finally { clearInterval(timer); if (active) await active.catch(() => {}); }
}
