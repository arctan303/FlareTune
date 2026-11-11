import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeliveryPlan, deliveryConnection, fetchDeliverySnapshot, readPreparedDeployment, reportDelivery } from './delivery.mjs';
import { readBoundedResponse } from './assemble.mjs';
import { assertNoDevSourceOverride } from './dev-source.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const sameVersions = (a, b) => JSON.stringify([...a].sort((x, y) => x.version_id.localeCompare(y.version_id)))
  === JSON.stringify([...b].sort((x, y) => x.version_id.localeCompare(y.version_id)));
const pause = delay => new Promise(resolve => setTimeout(resolve, delay));

async function wranglerConfig(args) {
  const { unstable_readConfig } = await import('wrangler');
  return unstable_readConfig(args, { hideWarnings: true });
}

export async function deploymentTarget({ root = repositoryRoot, environment = process.env, readConfigImpl = wranglerConfig } = {}) {
  await assertNoDevSourceOverride(root);
  const workerName = environment.FLARETUNE_PLUGIN_WORKER_NAME;
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  const env = environment.FLARETUNE_PLUGIN_WRANGLER_ENV || '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName || '') || !/^[a-f0-9]{32}$/.test(accountId || '')
    || typeof token !== 'string' || token.length < 20 || /\s/.test(token) || !/^[a-zA-Z0-9_-]{0,80}$/.test(env)) fail('PLUGIN_DEPLOY_TARGET_MISSING');
  if ((environment.WRANGLER_CI_OVERRIDE_NAME && environment.WRANGLER_CI_OVERRIDE_NAME !== workerName)
    || [environment.CLOUDFLARE_API_BASE_URL, environment.CF_API_BASE_URL].some(url => url && url !== 'https://api.cloudflare.com/client/v4')
    || (environment.CLOUDFLARE_COMPLIANCE_REGION && environment.CLOUDFLARE_COMPLIANCE_REGION !== 'public')) fail('PLUGIN_DEPLOY_TARGET_MISMATCH');
  root = await realpath(root);
  const configPath = resolve(root, environment.FLARETUNE_PLUGIN_WRANGLER_CONFIG || 'wrangler.toml');
  const config = await readConfigImpl({ config: configPath, env });
  if (config.name !== workerName || (config.account_id && config.account_id !== accountId)
    || resolve(config.main || '') !== resolve(root, 'server/src/flaretune.js')) fail('PLUGIN_DEPLOY_TARGET_MISMATCH');
  if (!Array.isArray(config.d1_databases) || !config.d1_databases.some(binding => binding.binding === 'DB')
    || config.d1_databases.some(binding => !uuid(binding.database_id))
    || (config.kv_namespaces || []).some(binding => !/^[a-f0-9]{32}$/.test(binding.id || ''))) fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
  return { workerName, accountId, token, configPath, env, root };
}

async function cloudflareRequest(target, path, { fetchImpl = fetch, body } = {}) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/${encodeURIComponent(target.workerName)}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('PLUGIN_DEPLOY_PROVIDER_FAILED'); }
  let data;
  try { data = JSON.parse((await readBoundedResponse(response, 1024 * 1024)).toString('utf8')); }
  catch { fail('PLUGIN_DEPLOY_PROVIDER_FAILED'); }
  if (data.success !== true || !data.result) fail('PLUGIN_DEPLOY_PROVIDER_FAILED');
  return data.result;
}

function deploymentRecord(value) {
  if (!value || !uuid(value.id) || value.strategy !== 'percentage' || !Array.isArray(value.versions)
    || value.versions.length < 1 || value.versions.length > 2
    || new Set(value.versions.map(row => row.version_id)).size !== value.versions.length
    || value.versions.some(row => !uuid(row.version_id) || typeof row.percentage !== 'number' || row.percentage <= 0 || row.percentage > 100)
    || Math.abs(value.versions.reduce((total, row) => total + row.percentage, 0) - 100) > 0.0001) fail('PLUGIN_DEPLOY_BASELINE_INVALID');
  return { id: value.id, strategy: 'percentage', versions: value.versions.map(({ version_id, percentage }) => ({ version_id, percentage })) };
}

export async function currentWorkerDeployment(target, { fetchImpl = fetch } = {}) {
  const result = await cloudflareRequest(target, '/deployments', { fetchImpl });
  // The endpoint returns latest first; Wrangler's own version API uses at(0).
  return deploymentRecord(result.deployments?.[0]);
}

export function workerVersionBindingsDigest(version) {
  // GET /versions/:id returns the resolved metadata bindings used by Wrangler's
  // own versions API. Compare provider resources, not only local config syntax.
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings) || bindings.length > 512) fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
  const names = new Set();
  const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || !nonempty(binding.name) || !nonempty(binding.type)
      || names.has(binding.name) || binding.type === 'inherit') fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
    names.add(binding.name);
    if ((binding.type === 'd1' && !uuid(binding.id))
      || (binding.type === 'kv_namespace' && !/^[a-f0-9]{32}$/.test(binding.namespace_id || ''))
      || (binding.type === 'r2_bucket' && !nonempty(binding.bucket_name))
      || (binding.type === 'service' && !nonempty(binding.service))
      || (binding.type === 'durable_object_namespace' && !nonempty(binding.namespace_id))
      || (binding.type === 'plain_text' && typeof binding.text !== 'string')
      || (binding.type === 'json' && !Object.hasOwn(binding, 'json'))) fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
  }
  if (!bindings.some(binding => binding.name === 'DB' && binding.type === 'd1')) fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
  const canonical = (value, depth = 0) => {
    if (depth > 32) fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
    if (!value || typeof value !== 'object') fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  };
  const data = [...bindings].sort((a, b) => a.name.localeCompare(b.name)).map(binding => canonical(binding));
  // Secret values are not returned by the provider. Their names/types and any
  // actual metadata fields still participate. No binding data or digest is
  // written to a recovery receipt or log.
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

async function currentBindingsDigest(target, previous, options) {
  let digest;
  for (const row of previous.versions) {
    const version = await cloudflareRequest(target, `/versions/${row.version_id}`, options);
    if (version.id !== row.version_id) fail('PLUGIN_DEPLOY_BINDINGS_INVALID');
    const actual = workerVersionBindingsDigest(version);
    if (digest && actual !== digest) fail('PLUGIN_DEPLOY_BINDINGS_MISMATCH');
    digest = actual;
  }
  return digest;
}

export function uploadedVersion(output, target) {
  if (typeof output !== 'string' || output.length > 1024 * 1024) fail('PLUGIN_DEPLOY_UPLOAD_INVALID');
  let records;
  try { records = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { fail('PLUGIN_DEPLOY_UPLOAD_INVALID'); }
  const uploaded = records.filter(row => row.type === 'version-upload');
  if (uploaded.length !== 1 || !uuid(uploaded[0].version_id) || uploaded[0].worker_name !== target.workerName
    || (uploaded[0].account_id && uploaded[0].account_id !== target.accountId)
    || (uploaded[0].wrangler_environment || '') !== target.env) fail('PLUGIN_DEPLOY_UPLOAD_INVALID');
  return uploaded[0].version_id;
}

export async function uploadWorkerVersion(target, deployment, { environment = process.env } = {}) {
  const scratch = await mkdtemp(resolve(tmpdir(), 'flaretune-plugin-upload-'));
  const outputFile = resolve(scratch, 'output.ndjson');
  const args = [resolve(target.root, 'node_modules/wrangler/bin/wrangler.js'), 'versions', 'upload', '--config', target.configPath,
    '--name', target.workerName, '--env', target.env, '--tag', `plugin-${deployment.buildId}`, '--message', `FlareTune plugin build ${deployment.buildId}`];
  const childEnvironment = { ...environment, CLOUDFLARE_ACCOUNT_ID: target.accountId, CLOUDFLARE_API_TOKEN: target.token,
    WRANGLER_OUTPUT_FILE_PATH: outputFile, WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false', CI: 'true' };
  delete childEnvironment.FLARETUNE_PLUGIN_BUILD_TOKEN;
  delete childEnvironment.CLOUDFLARE_API_KEY;
  delete childEnvironment.CF_API_KEY;
  try {
    await new Promise((accept, reject) => {
      // No shell interpolation and no arbitrary third-party stderr in CI logs.
      const child = spawn(process.execPath, args, { cwd: target.root, env: childEnvironment, windowsHide: true, shell: false, stdio: 'ignore' });
      const timeout = setTimeout(() => { child.kill(); reject(Object.assign(new Error('PLUGIN_DEPLOY_UPLOAD_TIMEOUT'), { code: 'PLUGIN_DEPLOY_UPLOAD_TIMEOUT' })); }, 10 * 60 * 1000);
      child.on('error', () => { clearTimeout(timeout); reject(Object.assign(new Error('PLUGIN_DEPLOY_UPLOAD_FAILED'), { code: 'PLUGIN_DEPLOY_UPLOAD_FAILED' })); });
      child.on('exit', code => { clearTimeout(timeout); if (code === 0) accept(); else reject(Object.assign(new Error('PLUGIN_DEPLOY_UPLOAD_FAILED'), { code: 'PLUGIN_DEPLOY_UPLOAD_FAILED' })); });
    });
    return uploadedVersion(await readFile(outputFile, 'utf8'), target);
  } finally {
    const resolved = await realpath(scratch);
    if (dirname(resolved) === await realpath(tmpdir()) && resolved.includes('flaretune-plugin-upload-')) await rm(resolved, { recursive: true, force: true });
  }
}

async function recoveryPath(target, buildId) {
  if (!uuid(buildId)) fail('PLUGIN_BUILD_REPORT_INVALID');
  const directory = resolve(target.root, 'tooling/plugins/.delivery-recovery');
  const path = resolve(directory, `${buildId}.json`);
  const rel = relative(target.root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('PLUGIN_OUTPUT_PATH_INVALID');
  let current = path;
  while (current !== target.root) {
    try { if ((await lstat(current)).isSymbolicLink()) fail('PLUGIN_OUTPUT_PATH_INVALID'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
  await mkdir(directory, { recursive: true });
  return path;
}

async function saveRecovery(target, deployment, receipt) {
  const path = await recoveryPath(target, deployment.buildId);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
async function readRecovery(target, deployment) {
  let receipt;
  try { receipt = JSON.parse(await readFile(await recoveryPath(target, deployment.buildId), 'utf8')); }
  catch { fail('PLUGIN_DEPLOY_RECOVERY_MISSING'); }
  if (receipt.schemaVersion !== 1 || receipt.buildId !== deployment.buildId || receipt.planDigest !== deployment.planDigest
    || receipt.accountId !== target.accountId || receipt.workerName !== target.workerName || !uuid(receipt.nextVersionId)) fail('PLUGIN_DEPLOY_RECOVERY_INVALID');
  receipt.previous = deploymentRecord(receipt.previous);
  return receipt;
}

async function changeDeployment(target, versions, buildId, { fetchImpl }) {
  return cloudflareRequest(target, '/deployments', { fetchImpl, body: { strategy: 'percentage', versions,
    annotations: { 'workers/message': `FlareTune plugin build ${buildId}` } } });
}

async function confirmReport(connection, deployment, status, { fetchImpl, sleepImpl }) {
  let error; let uncertain = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const reported = await reportDelivery(connection, deployment, status, { fetchImpl });
      if (reported.result?.ok !== true || reported.result?.status !== status) fail('PLUGIN_BUILD_RESPONSE_INVALID');
      return;
    } catch (failure) { error = failure; uncertain ||= failure.confirmedRejected !== true; if (attempt < 5) await sleepImpl(Math.min(10000, 2 ** attempt * 1000)); }
  }
  error.uncertain = uncertain;
  throw error;
}

async function restorePrevious(target, connection, deployment, receipt, options) {
  // The server atomically claims rollback intent before any provider mutation.
  // A concurrent activation that won the transaction makes this request fail.
  await confirmReport(connection, deployment, 'rolling_back', options);
  const current = await currentWorkerDeployment(target, options);
  const next = [{ version_id: receipt.nextVersionId, percentage: 100 }];
  if (!sameVersions(current.versions, receipt.previous.versions)) {
    if (!sameVersions(current.versions, next)) fail('PLUGIN_DEPLOY_TARGET_CHANGED');
    await changeDeployment(target, receipt.previous.versions, deployment.buildId, options);
    const verified = await currentWorkerDeployment(target, options);
    if (!sameVersions(verified.versions, receipt.previous.versions)) fail('PLUGIN_DEPLOY_ROLLBACK_UNCONFIRMED');
  }
  await confirmReport(connection, deployment, 'rolled_back', options);
  receipt.status = 'rolled_back'; await saveRecovery(target, deployment, receipt).catch(() => {});
  return { buildId: deployment.buildId, status: 'rolled_back', previousVersions: receipt.previous.versions };
}

export async function deployPluginDelivery({ root = repositoryRoot, environment = process.env, fetchImpl = fetch,
  readConfigImpl = wranglerConfig, uploadImpl = uploadWorkerVersion, sleepImpl = pause, recover = false, buildWorkerName } = {}) {
  const connection = deliveryConnection(environment);
  const target = await deploymentTarget({ root, environment, readConfigImpl });
  const deployment = await readPreparedDeployment(root);
  const options = { fetchImpl, sleepImpl };
  let snapshot = await fetchDeliverySnapshot(connection, options);
  await checkDeliveryPlan(connection, deployment, { root, fetchImpl });
  const expectedBuildWorker = buildWorkerName ?? target.workerName;
  if (typeof expectedBuildWorker !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(expectedBuildWorker)
    || (snapshot.target?.workerName && snapshot.target.workerName !== expectedBuildWorker)) fail('PLUGIN_DEPLOY_TARGET_MISMATCH');
  if (snapshot.buildId !== deployment.buildId || snapshot.planDigest !== deployment.planDigest) fail('PLUGIN_BUILD_SUPERSEDED');
  if (snapshot.buildStatus === 'deployed') {
    // A completed database transaction may outlive a lost HTTP response or CI
    // process. The idempotent report verifies the actual live metadata again.
    await confirmReport(connection, deployment, 'deployed', options);
    return { buildId: deployment.buildId, status: 'deployed' };
  }
  if (recover || ['deploying', 'activation_pending', 'rolling_back'].includes(snapshot.buildStatus)) {
    const receipt = await readRecovery(target, deployment);
    if (!recover) {
      // An acknowledgement may have been lost after activation. Retrying it is
      // idempotent; this path never uploads or promotes a second version.
      try { await confirmReport(connection, deployment, 'deployed', options); return { buildId: deployment.buildId, status: 'deployed' }; }
      catch { await reportDelivery(connection, deployment, 'activation_pending', options).catch(() => {}); fail('PLUGIN_DEPLOYMENT_UNCONFIRMED'); }
    }
    try { return await restorePrevious(target, connection, deployment, receipt, options); }
    catch { await reportDelivery(connection, deployment, 'activation_pending', options).catch(() => {}); fail('PLUGIN_DEPLOYMENT_UNCONFIRMED'); }
  }
  if (snapshot.buildStatus && !['triggering', 'queued', 'building'].includes(snapshot.buildStatus)) fail('PLUGIN_BUILD_SUPERSEDED');
  let receipt; let promotionStarted = false; let promotionAttempted = false; let activationAttempted = false;
  try {
    const previous = await currentWorkerDeployment(target, options);
    // A plugin operation must preserve the instance's database, storage,
    // services, Durable Objects, variables and secrets. Mixed baselines are
    // outside the first delivery protocol, rather than silently choosing one.
    const baselineBindings = await currentBindingsDigest(target, previous, options);
    receipt = { schemaVersion: 1, buildId: deployment.buildId, planDigest: deployment.planDigest,
      accountId: target.accountId, workerName: target.workerName, previous, nextVersionId: null, status: 'before_upload' };
    await saveRecovery(target, deployment, receipt);
    receipt.nextVersionId = await uploadImpl(target, deployment, { environment });
    if (!uuid(receipt.nextVersionId)) fail('PLUGIN_DEPLOY_UPLOAD_INVALID');
    const version = await cloudflareRequest(target, `/versions/${receipt.nextVersionId}`, options);
    if (version.id !== receipt.nextVersionId || version.annotations?.['workers/tag'] !== `plugin-${deployment.buildId}`) fail('PLUGIN_DEPLOY_UPLOAD_INVALID');
    if (workerVersionBindingsDigest(version) !== baselineBindings) fail('PLUGIN_DEPLOY_BINDINGS_MISMATCH');
    receipt.status = 'uploaded'; await saveRecovery(target, deployment, receipt);
    await checkDeliveryPlan(connection, deployment, { root, fetchImpl });
    snapshot = await fetchDeliverySnapshot(connection, options);
    if (snapshot.buildId !== deployment.buildId || snapshot.planDigest !== deployment.planDigest) fail('PLUGIN_BUILD_SUPERSEDED');
    if ((await currentWorkerDeployment(target, options)).id !== previous.id) fail('PLUGIN_DEPLOY_TARGET_CHANGED');
    // From this boundary onward even a lost response is an uncertain deployment,
    // never a known failed build. Keep enough evidence for exact code recovery.
    promotionStarted = true;
    await confirmReport(connection, deployment, 'deploying', options);
    receipt.status = 'deploying'; await saveRecovery(target, deployment, receipt);
    // Reporting is a network boundary: another deployment can finish while its
    // response is in flight. Check again after that boundary, immediately before
    // attempting promotion, and never roll back a deployment we did not change.
    if ((await currentWorkerDeployment(target, options)).id !== previous.id) fail('PLUGIN_DEPLOY_TARGET_CHANGED');
    promotionAttempted = true;
    await changeDeployment(target, [{ version_id: receipt.nextVersionId, percentage: 100 }], deployment.buildId, options);
    if (!sameVersions((await currentWorkerDeployment(target, options)).versions, [{ version_id: receipt.nextVersionId, percentage: 100 }])) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    activationAttempted = true;
    await confirmReport(connection, deployment, 'deployed', options);
    receipt.status = 'deployed'; await saveRecovery(target, deployment, receipt).catch(() => {});
    return { buildId: deployment.buildId, status: 'deployed', versionId: receipt.nextVersionId };
  } catch (error) {
    if (!promotionStarted) {
      await reportDelivery(connection, deployment, 'failed', options).catch(() => {});
      throw error;
    }
    if (!promotionAttempted) {
      await reportDelivery(connection, deployment, 'activation_pending', options).catch(() => {});
      receipt.status = 'activation_pending'; await saveRecovery(target, deployment, receipt).catch(() => {});
      throw error;
    }
    if (activationAttempted) {
      let latest;
      try { latest = await fetchDeliverySnapshot(connection, options); } catch { /* Unknown is retained below. */ }
      if (latest?.buildId === deployment.buildId && latest.planDigest === deployment.planDigest && latest.buildStatus === 'deployed') {
        // Do not roll back code after a confirmed database activation.
        receipt.status = 'deployed'; await saveRecovery(target, deployment, receipt).catch(() => {});
        return { buildId: deployment.buildId, status: 'deployed', versionId: receipt.nextVersionId };
      }
      if (error.uncertain || !latest || latest.buildId !== deployment.buildId || latest.planDigest !== deployment.planDigest) {
        await reportDelivery(connection, deployment, 'activation_pending', options).catch(() => {});
        receipt.status = 'activation_pending'; await saveRecovery(target, deployment, receipt).catch(() => {});
        fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
      }
    }
    try { await restorePrevious(target, connection, deployment, receipt, options); }
    catch {
      try {
        const latest = await fetchDeliverySnapshot(connection, options);
        if (latest.buildId === deployment.buildId && latest.planDigest === deployment.planDigest && latest.buildStatus === 'deployed') {
          receipt.status = 'deployed'; await saveRecovery(target, deployment, receipt).catch(() => {});
          return { buildId: deployment.buildId, status: 'deployed', versionId: receipt.nextVersionId };
        }
      } catch { /* Keep an unconfirmed outcome; never force a code rollback. */ }
      await reportDelivery(connection, deployment, 'activation_pending', options).catch(() => {});
      if (receipt) { receipt.status = 'activation_pending'; await saveRecovery(target, deployment, receipt).catch(() => {}); }
      fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    }
    fail('PLUGIN_DEPLOY_ROLLED_BACK');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] && process.argv[2] !== 'recover') fail('PLUGIN_BUILD_COMMAND_INVALID');
    process.stdout.write(`${JSON.stringify(await deployPluginDelivery({ recover: process.argv[2] === 'recover' }))}\n`);
  } catch (error) {
    process.stderr.write(`${/^PLUGIN_[A-Z_]+$/.test(error.code || '') ? error.code : 'PLUGIN_DEPLOY_FAILED'}\n`);
    process.exitCode = 1;
  }
}
