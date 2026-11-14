import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentWorkerDeployment, workerVersionBindingsDigest, uploadedVersion } from '../plugins/delivery-deploy.mjs';
import { readBoundedResponse } from '../plugins/assemble.mjs';
import { updateConnection, fetchUpdatePlan, currentUpdatePlan, reportUpdate, migrateUpdate, validateReceipt, withUpdateLease, fail } from './protocol.mjs';

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sameVersions = (left, right) => JSON.stringify([...left].sort((a, b) => a.version_id.localeCompare(b.version_id)))
  === JSON.stringify([...right].sort((a, b) => a.version_id.localeCompare(b.version_id)));
const pause = delay => new Promise(accept => setTimeout(accept, delay));

export function updateTarget(environment = process.env) {
  const workerName = environment.FLARETUNE_SYSTEM_UPDATE_WORKER_NAME, accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN, targetTag = environment.FLARETUNE_SYSTEM_UPDATE_WORKER_TAG;
  const branch = environment.FLARETUNE_SYSTEM_UPDATE_BUILD_BRANCH || 'main';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName || '') || !/^[a-f0-9]{32}$/.test(accountId || '')
    || !/^[a-f0-9]{32}$/.test(targetTag || '') || typeof token !== 'string' || token.length < 20 || /\s/.test(token)
    || environment.WORKERS_CI !== '1' || environment.WORKERS_CI_BRANCH !== branch
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(branch) || branch.includes('..') || branch.includes('//')) fail('SYSTEM_UPDATE_TARGET_MISSING');
  // Provider identity guards are never rewritten to turn one Worker into another.
  if (environment.WRANGLER_CI_OVERRIDE_NAME && environment.WRANGLER_CI_OVERRIDE_NAME !== workerName
    || environment.WRANGLER_CI_MATCH_TAG && environment.WRANGLER_CI_MATCH_TAG !== targetTag
    || [environment.CLOUDFLARE_API_BASE_URL, environment.CF_API_BASE_URL].some(url => url && url !== 'https://api.cloudflare.com/client/v4')
    || environment.CLOUDFLARE_COMPLIANCE_REGION && environment.CLOUDFLARE_COMPLIANCE_REGION !== 'public') fail('SYSTEM_UPDATE_TARGET_MISMATCH');
  return { workerName, accountId, token, targetTag, env: '' };
}
async function provider(target, path, { fetchImpl = fetch, body, service = false } = {}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/${service ? 'services' : 'scripts'}/${target.workerName}`;
  let response;
  try { response = await fetchImpl(`${base}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
    signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { fail('SYSTEM_UPDATE_PROVIDER_UNCONFIRMED'); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('SYSTEM_UPDATE_PROVIDER_REJECTED'); }
  let data;
  try { data = JSON.parse((await readBoundedResponse(response, 2 * 1024 * 1024)).toString('utf8')); }
  catch { fail('SYSTEM_UPDATE_PROVIDER_RESPONSE_INVALID'); }
  if (data.success !== true || !data.result) fail('SYSTEM_UPDATE_PROVIDER_RESPONSE_INVALID');
  return data.result;
}
export async function verifyUpdateTarget(target, options = {}) {
  const service = await provider(target, '', { ...options, service: true });
  if (service.default_environment?.script?.tag !== target.targetTag) fail('SYSTEM_UPDATE_TARGET_MISMATCH');
}
async function baselineVersion(target, deployment, options) {
  let first, digest;
  for (const row of deployment.versions) {
    const version = await provider(target, `/versions/${row.version_id}`, options);
    if (version.id !== row.version_id) fail('SYSTEM_UPDATE_BINDINGS_INVALID');
    const actual = workerVersionBindingsDigest(version);
    if (digest && digest !== actual) fail('SYSTEM_UPDATE_BINDINGS_MISMATCH');
    digest = actual; first ||= version;
  }
  return { version: first, digest };
}

export function systemBuildConfig(version, { root, target, template }) {
  workerVersionBindingsDigest(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(template?.compatibility_date || '') || template.assets?.binding !== 'ASSETS') fail('SYSTEM_UPDATE_CONFIG_INVALID');
  const config = { name: target.workerName, account_id: target.accountId, main: resolve(root, 'server/src/flaretune.js'),
    compatibility_date: template.compatibility_date, keep_vars: true, assets: { ...structuredClone(template.assets), directory: resolve(root, 'dist') }, vars: Object.create(null) };
  for (const key of ['compatibility_flags', 'rules', 'observability', 'placement', 'limits']) if (template[key] !== undefined) config[key] = structuredClone(template[key]);
  const add = (key, row) => (config[key] ||= []).push(row);
  for (const binding of version.resources.bindings) {
    switch (binding.type) {
      case 'd1': add('d1_databases', { binding: binding.name, database_id: binding.id, database_name: binding.name,
        migrations_dir: resolve(root, 'server/db/migrations-flaretune') }); break;
      case 'kv_namespace': add('kv_namespaces', { binding: binding.name, id: binding.namespace_id }); break;
      case 'r2_bucket': add('r2_buckets', { binding: binding.name, bucket_name: binding.bucket_name,
        ...(binding.jurisdiction ? { jurisdiction: binding.jurisdiction } : {}) }); break;
      case 'service': add('services', { binding: binding.name, service: binding.service,
        ...(binding.environment ? { environment: binding.environment } : {}), ...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}) }); break;
      case 'durable_object_namespace': {
        if (typeof binding.class_name !== 'string' || !binding.class_name) fail('SYSTEM_UPDATE_BINDING_UNSUPPORTED');
        const local = !binding.script_name || binding.script_name === target.workerName;
        config.durable_objects ||= { bindings: [] };
        config.durable_objects.bindings.push({ name: binding.name, class_name: binding.class_name,
          ...(!local ? { script_name: binding.script_name, ...(binding.environment ? { environment: binding.environment } : {}) } : {}) }); break;
      }
      case 'plain_text': config.vars[binding.name] = binding.text; break;
      case 'json': config.vars[binding.name] = structuredClone(binding.json); break;
      case 'secret_text': case 'secret_key': break;
      case 'assets': if (binding.name !== 'ASSETS') fail('SYSTEM_UPDATE_BINDING_UNSUPPORTED'); break;
      default: fail('SYSTEM_UPDATE_BINDING_UNSUPPORTED');
    }
  }
  return config;
}
async function readTemplate(root) {
  const { unstable_readConfig } = await import('wrangler');
  return unstable_readConfig({ config: resolve(root, 'wrangler.toml') }, { hideWarnings: true });
}
export async function uploadSystemVersion(target, plan, { root, configPath, environment = process.env, signal } = {}) {
  const scratch = await mkdtemp(resolve(tmpdir(), 'flaretune-system-upload-')), outputFile = resolve(scratch, 'upload.ndjson');
  try {
    const args = [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'versions', 'upload', '--config', configPath,
      '--name', target.workerName, '--env', '', '--tag', `system-${plan.taskId}`, '--message', `FlareTune system update ${plan.taskId}`];
    const childEnvironment = { PATH: environment.PATH, SystemRoot: environment.SystemRoot, TEMP: environment.TEMP, TMP: environment.TMP,
      HOME: environment.HOME, USERPROFILE: environment.USERPROFILE, CI: 'true', CLOUDFLARE_ACCOUNT_ID: target.accountId,
      CLOUDFLARE_API_TOKEN: target.token, WRANGLER_OUTPUT_FILE_PATH: outputFile, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true',
      ...(environment.WRANGLER_CI_OVERRIDE_NAME ? { WRANGLER_CI_OVERRIDE_NAME: environment.WRANGLER_CI_OVERRIDE_NAME } : {}),
      ...(environment.WRANGLER_CI_MATCH_TAG ? { WRANGLER_CI_MATCH_TAG: environment.WRANGLER_CI_MATCH_TAG } : {}) };
    await new Promise((accept, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error('SYSTEM_UPDATE_LEASE_LOST'), { code: 'SYSTEM_UPDATE_LEASE_LOST' })); return; }
      const child = spawn(process.execPath, args, { cwd: root, env: childEnvironment, shell: false, windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
      const stop = () => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } };
      const cancel = () => { stop(); reject(Object.assign(new Error('SYSTEM_UPDATE_LEASE_LOST'), { code: 'SYSTEM_UPDATE_LEASE_LOST' })); };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { stop(); reject(Object.assign(new Error('SYSTEM_UPDATE_UPLOAD_UNCONFIRMED'), { code: 'SYSTEM_UPDATE_UPLOAD_UNCONFIRMED' })); }, 10 * 60 * 1000);
      const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      child.once('error', () => { clear(); reject(Object.assign(new Error('SYSTEM_UPDATE_UPLOAD_UNCONFIRMED'), { code: 'SYSTEM_UPDATE_UPLOAD_UNCONFIRMED' })); });
      child.once('exit', code => { clear(); code === 0 ? accept() : reject(Object.assign(new Error('SYSTEM_UPDATE_UPLOAD_UNCONFIRMED'), { code: 'SYSTEM_UPDATE_UPLOAD_UNCONFIRMED' })); });
    });
    return uploadedVersion(await readFile(outputFile, 'utf8'), target);
  } finally {
    if (dirname(await realpath(scratch)) === await realpath(tmpdir())) await rm(scratch, { recursive: true, force: true });
  }
}
async function uploadedForTask(target, plan, options) {
  const result = await provider(target, '/versions?per_page=100', options), items = result.items;
  if (!Array.isArray(items)) fail('SYSTEM_UPDATE_PROVIDER_RESPONSE_INVALID');
  const matching = items.filter(row => row.annotations?.['workers/tag'] === `system-${plan.taskId}`);
  if (matching.length > 1 || matching.some(row => !uuid(row.id))) fail('SYSTEM_UPDATE_UPLOAD_AMBIGUOUS');
  return matching[0]?.id || null;
}
function assertReceiptTarget(receipt, target) {
  validateReceipt(receipt);
  if (receipt.accountId !== target.accountId || receipt.workerName !== target.workerName || receipt.targetTag !== target.targetTag
    || !/^[a-f0-9]{64}$/.test(receipt.bindingDigest || '')) fail('SYSTEM_UPDATE_TARGET_MISMATCH');
}
async function changedDeployment(target, versions, taskId, options) {
  return provider(target, '/deployments', { ...options, body: { strategy: 'percentage', versions,
    annotations: { 'workers/message': `FlareTune system update ${taskId}` } } });
}

// All recovery decisions use the site's durable receipt. Temporary CI files are
// only build inputs; they are never the authority for a second promotion.
export async function deploySystemUpdate({ root = rootDirectory, environment = process.env, fetchImpl = fetch,
  readTemplateImpl = readTemplate, uploadImpl = uploadSystemVersion, sleepImpl = pause, migrationAttempts = 30, lease, connection: providedConnection, leaseOptions } = {}) {
  const connection = providedConnection || updateConnection(environment), target = updateTarget(environment), options = { fetchImpl };
  let plan = await fetchUpdatePlan(connection, options);
  if (!plan) return { status: 'idle' };
  if (['failed', 'rolled_back'].includes(plan.status)) fail('SYSTEM_UPDATE_RETRY_REQUIRED');
  if (!lease) return withUpdateLease(connection, plan, owned => deploySystemUpdate({ root,
    environment: { ...environment, FLARETUNE_SYSTEM_UPDATE_RUNNER_ID: connection.runnerId }, fetchImpl, readTemplateImpl,
    uploadImpl, sleepImpl, migrationAttempts, lease: owned, connection, leaseOptions }), { ...options, ...leaseOptions });
  lease.check();
  await verifyUpdateTarget(target, options);
  const expected = { taskId: plan.taskId, planDigest: plan.planDigest };
  let receipt = plan.receipt, promotionAttempted = false, migratingAttempted = false;
  const refresh = async () => { plan = await currentUpdatePlan(connection, expected, options); receipt = plan.receipt; return plan; };
  const report = async (status, updatedReceipt) => {
    await reportUpdate(connection, expected, status, { ...options, ...(updatedReceipt ? { receipt: updatedReceipt } : {}) });
    await refresh();
    if (plan.status !== status) fail('SYSTEM_UPDATE_REPORT_UNCONFIRMED');
  };
  try {
    if (plan.status === 'deployed') {
      assertReceiptTarget(receipt, target);
      if (!sameVersions((await currentWorkerDeployment(target, options)).versions, [{ version_id: receipt.nextVersionId, percentage: 100 }])) fail('SYSTEM_UPDATE_TARGET_CHANGED');
      await report('deployed'); return { taskId: plan.taskId, status: 'deployed', versionId: receipt.nextVersionId };
    }
    if (receipt) {
      assertReceiptTarget(receipt, target);
      if (plan.status === 'queued' || plan.status === 'activation_pending' && !receipt.nextVersionId && !receipt.uploadStarted) {
        await report('building');
        if (receipt.nextVersionId) await report('uploaded');
      }
    }
    else {
      if (!['queued', 'building', 'activation_pending'].includes(plan.status)) fail('SYSTEM_UPDATE_RECEIPT_MISSING');
      const previous = await currentWorkerDeployment(target, options), baseline = await baselineVersion(target, previous, options);
      receipt = { schemaVersion: 1, accountId: target.accountId, workerName: target.workerName, targetTag: target.targetTag,
        previous, nextVersionId: null, bindingDigest: baseline.digest, uploadStarted: false, migrationStarted: false, migrationCompleted: false };
      await report('building', receipt);
    }
    if (plan.status === 'rolling_back') return await rollback();
    if (!receipt.nextVersionId) {
      if (!['queued', 'building', 'activation_pending'].includes(plan.status)) fail('SYSTEM_UPDATE_RECEIPT_MISSING');
      const current = await currentWorkerDeployment(target, options);
      if (current.id !== receipt.previous.id) fail('SYSTEM_UPDATE_TARGET_CHANGED');
      let nextVersionId = await uploadedForTask(target, plan, options);
      if (!nextVersionId) {
        if (receipt.uploadStarted) fail('SYSTEM_UPDATE_UPLOAD_UNCONFIRMED');
        const baseline = await baselineVersion(target, receipt.previous, options);
        if (baseline.digest !== receipt.bindingDigest) fail('SYSTEM_UPDATE_BINDINGS_MISMATCH');
        const config = systemBuildConfig(baseline.version, { root, target, template: await readTemplateImpl(root) });
        const configPath = resolve(root, '.system-update-wrangler.json');
        await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
        try {
          await lease.renew();
          await report('building', { ...receipt, uploadStarted: true });
          lease.check();
          nextVersionId = await uploadImpl(target, plan, { root, configPath, environment, signal: lease.signal });
        }
        finally { await rm(configPath, { force: true }); }
      }
      if (!uuid(nextVersionId)) fail('SYSTEM_UPDATE_UPLOAD_INVALID');
      const version = await provider(target, `/versions/${nextVersionId}`, options);
      if (version.id !== nextVersionId || version.annotations?.['workers/tag'] !== `system-${plan.taskId}`) fail('SYSTEM_UPDATE_UPLOAD_INVALID');
      if (workerVersionBindingsDigest(version) !== receipt.bindingDigest) fail('SYSTEM_UPDATE_BINDINGS_MISMATCH');
      await refresh();
      await report('uploaded', { ...receipt, uploadStarted: true, nextVersionId });
    }
    const next = [{ version_id: receipt.nextVersionId, percentage: 100 }];
    const version = await provider(target, `/versions/${receipt.nextVersionId}`, options);
    if (version.id !== receipt.nextVersionId || version.annotations?.['workers/tag'] !== `system-${plan.taskId}`
      || workerVersionBindingsDigest(version) !== receipt.bindingDigest) fail('SYSTEM_UPDATE_BINDINGS_MISMATCH');
    let current = await currentWorkerDeployment(target, options);
    if (!sameVersions(current.versions, next)) {
      if (receipt.migrationStarted || !sameVersions(current.versions, receipt.previous.versions)
        || current.id !== receipt.previous.id) fail('SYSTEM_UPDATE_TARGET_CHANGED');
      if (plan.status === 'activation_pending') await report('deploying');
      else if (plan.status !== 'deploying') await report('deploying');
      await refresh();
      current = await currentWorkerDeployment(target, options);
      if (current.id !== receipt.previous.id) fail('SYSTEM_UPDATE_TARGET_CHANGED');
      await lease.renew();
      await refresh();
      if ((await currentWorkerDeployment(target, options)).id !== receipt.previous.id) fail('SYSTEM_UPDATE_TARGET_CHANGED');
      lease.check();
      promotionAttempted = true;
      await changedDeployment(target, next, plan.taskId, options);
      current = await currentWorkerDeployment(target, options);
      if (!sameVersions(current.versions, next)) fail('SYSTEM_UPDATE_DEPLOYMENT_UNCONFIRMED');
    }
    await refresh();
    if (!receipt.migrationStarted || plan.status === 'activation_pending') {
      migratingAttempted = true;
      await report('migrating');
    }
    if (!receipt.migrationStarted) fail('SYSTEM_UPDATE_MIGRATION_UNCONFIRMED');
    for (let attempt = 0; !receipt.migrationCompleted && attempt < migrationAttempts; attempt++) {
      await lease.renew();
      await migrateUpdate(connection, plan, options);
      await refresh();
      if (!receipt.migrationCompleted && attempt + 1 < migrationAttempts) await sleepImpl(2000);
    }
    if (!receipt.migrationCompleted) fail('SYSTEM_UPDATE_MIGRATION_UNCONFIRMED');
    if (!sameVersions((await currentWorkerDeployment(target, options)).versions, next)) fail('SYSTEM_UPDATE_TARGET_CHANGED');
    await report('deployed');
    return { taskId: plan.taskId, status: 'deployed', versionId: receipt.nextVersionId };
  } catch (error) {
    let latest;
    try { latest = await refresh(); } catch { /* Lost acknowledgement remains unknown. */ }
    if (latest?.status === 'deployed') {
      const current = await currentWorkerDeployment(target, options);
      if (!sameVersions(current.versions, [{ version_id: receipt.nextVersionId, percentage: 100 }])) fail('SYSTEM_UPDATE_TARGET_CHANGED');
      return { taskId: expected.taskId, status: 'deployed', versionId: receipt.nextVersionId };
    }
    if (latest && receipt?.nextVersionId && !receipt.migrationStarted && migratingAttempted && error.confirmedRejected) {
      try { return await rollback(); } catch { /* Never force restoration over an unknown or foreign deployment. */ }
    }
    if (latest) {
      const status = promotionAttempted || migratingAttempted || receipt?.migrationStarted || receipt?.uploadStarted && !receipt?.nextVersionId
        || ['deploying', 'migrating', 'activation_pending', 'rolling_back'].includes(latest.status) ? 'activation_pending' : 'failed';
      await reportUpdate(connection, expected, status, { ...options, error: error.code || 'SYSTEM_UPDATE_DEPLOYMENT_UNCONFIRMED' }).catch(() => {});
    }
    throw error;
  }
  async function rollback() {
    if (receipt.migrationStarted) fail('SYSTEM_UPDATE_ROLLBACK_UNSAFE');
    if (plan.status !== 'rolling_back') await report('rolling_back');
    await lease.renew();
    const current = await currentWorkerDeployment(target, options), next = [{ version_id: receipt.nextVersionId, percentage: 100 }];
    if (!sameVersions(current.versions, receipt.previous.versions)) {
      if (!sameVersions(current.versions, next)) fail('SYSTEM_UPDATE_TARGET_CHANGED');
      await changedDeployment(target, receipt.previous.versions, plan.taskId, options);
      if (!sameVersions((await currentWorkerDeployment(target, options)).versions, receipt.previous.versions)) fail('SYSTEM_UPDATE_ROLLBACK_UNCONFIRMED');
    }
    await report('rolled_back');
    return { taskId: plan.taskId, status: 'rolled_back' };
  }
}
