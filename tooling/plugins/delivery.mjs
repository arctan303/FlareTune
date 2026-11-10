import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemblePluginDelivery, deliveryPlanDigest, publicHttpsUrl, readBoundedResponse, SNAPSHOT_MAX_BYTES,
  validateDeliveryPlan, validateDeliverySnapshot, verifyDeliveryCheckout } from './assemble.mjs';
import { canonicalPluginManifest } from '../../shared/plugins/manifest.js';
import { ACTIVE_PLUGIN_BUILDS } from '../../shared/plugins/delivery.js';
import { createPluginHostBuild } from './host-identity.mjs';
import { preparePluginSeed } from './seed.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fail = code => { const error = new Error(code); error.code = code; throw error; };

export function deliveryConnection(environment = process.env) {
  const configured = environment.FLARETUNE_PLUGIN_SITE_URL;
  const token = environment.FLARETUNE_PLUGIN_BUILD_TOKEN;
  if (typeof configured !== 'string' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) fail('PLUGIN_BUILD_CONNECTION_MISSING');
  const site = new URL(publicHttpsUrl(configured));
  if (site.pathname !== '/' || site.search) fail('PLUGIN_BUILD_SITE_ORIGIN_INVALID');
  return { origin: site.origin, token };
}

async function buildRequest(connection, path, { fetchImpl = fetch, body } = {}) {
  const response = await fetchImpl(`${connection.origin}/api/plugin-build/${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(response.status === 401 || response.status === 403 ? 'PLUGIN_BUILD_AUTH_FAILED' : 'PLUGIN_BUILD_REQUEST_FAILED');
    error.code = error.message;
    error.confirmedRejected = response.status >= 400 && response.status < 500;
    error.httpStatus = response.status;
    throw error;
  }
  const bytes = await readBoundedResponse(response, SNAPSHOT_MAX_BYTES, 'PLUGIN_BUILD_REQUEST_FAILED');
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('PLUGIN_BUILD_RESPONSE_INVALID'); }
  return result;
}

export async function fetchDeliverySnapshot(connection, { fetchImpl = fetch } = {}) {
  const snapshot = await buildRequest(connection, 'snapshot', { fetchImpl });
  return validateDeliverySnapshot(snapshot);
}

export async function readPreparedDeployment(root = repositoryRoot) {
  const generated = pathToFileURL(resolve(root, 'shared/plugins/delivery.generated.js'));
  const module = await import(`${generated.href}?receipt=${crypto.randomUUID()}`);
  const deployment = module.pluginDeployment;
  if (!deployment || typeof deployment.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(deployment.planDigest || '')) fail('PLUGIN_BUILD_NOT_PREPARED');
  return deployment;
}

export async function checkDeliveryPlan(connection, deployment, { fetchImpl = fetch, root = repositoryRoot } = {}) {
  const snapshot = await fetchDeliverySnapshot(connection, { fetchImpl });
  if (snapshot.buildId !== deployment.buildId || snapshot.planDigest !== deployment.planDigest
    || snapshot.host.version !== deployment.host?.version || snapshot.host.sourceDigest !== deployment.host?.sourceDigest) fail('PLUGIN_BUILD_SUPERSEDED');
  const lock = JSON.parse(await readFile(resolve(root, 'plugins.lock.json'), 'utf8'));
  if (lock.host?.version !== snapshot.host.version || lock.host?.sourceDigest !== snapshot.host.sourceDigest) fail('PLUGIN_HOST_BUILD_MISMATCH');
  const actualHost = await createPluginHostBuild(root);
  if (actualHost.version !== snapshot.host.version || actualHost.sourceDigest !== snapshot.host.sourceDigest) fail('PLUGIN_HOST_BUILD_MISMATCH');
  return { buildId: snapshot.buildId, planDigest: snapshot.planDigest };
}

export async function reportDelivery(connection, deployment, status, { fetchImpl = fetch } = {}) {
  if (!['building', 'deploying', 'activation_pending', 'rolling_back', 'failed', 'rolled_back', 'deployed'].includes(status) || !deployment) fail('PLUGIN_BUILD_REPORT_INVALID');
  const result = await buildRequest(connection, 'report', { fetchImpl, body: {
    buildId: deployment.buildId, planDigest: deployment.planDigest, status,
  } });
  return { buildId: deployment.buildId, status, result };
}

async function preparePlan(connection, snapshot, { root, fetchImpl, replay = false }) {
  try {
    let seed;
    try { seed = JSON.parse(await readFile(resolve(root, 'plugins.seed.lock.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (seed) await preparePluginSeed({ root, seed, fetchImpl });
    await assemblePluginDelivery({ root, snapshot, fetchImpl });
    if (!replay) await reportDelivery(connection, snapshot, 'building', { fetchImpl });
  } catch (error) {
    if (!replay) await reportDelivery(connection, snapshot, 'failed', { fetchImpl }).catch(() => {});
    throw error;
  }
  return { buildId: snapshot.buildId, planDigest: snapshot.planDigest, prepared: true, ...(replay ? { replay: true } : {}) };
}

export async function prepareHostUpgrade({ root = repositoryRoot, environment = process.env, fetchImpl = fetch, current = false } = {}) {
  const connection = deliveryConnection(environment);
  // Distribution locks include ignored immutable package files. A genuinely
  // cold CI checkout must restore those verified bytes before strict source
  // verification, without replacing the site's selected deployment metadata.
  let seed;
  try { seed = JSON.parse(await readFile(resolve(root, 'plugins.seed.lock.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (seed) await preparePluginSeed({ root, seed, fetchImpl });
  const host = await createPluginHostBuild(root);
  // Validate the reviewed checkout before asking the running site to reserve
  // anything. A seed is a distribution cache, never the inherited selection.
  await verifyDeliveryCheckout(root, { host, plugins: [] });
  let state;
  try { state = await buildRequest(connection, 'upgrade', { fetchImpl }); }
  catch (error) { if (error.httpStatus === 404) fail('PLUGIN_HOST_UPGRADE_UNAVAILABLE'); throw error; }
  validateDeliveryPlan(state);
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Number.isSafeInteger(state.registryRevision) || state.registryRevision < 0
    || typeof state.pending !== 'boolean' || deliveryPlanDigest(state) !== state.runningDigest) fail('PLUGIN_BUILD_RESPONSE_INVALID');
  const sameHost = canonicalPluginManifest(host) === canonicalPluginManifest(state.host);
  const build = state.build;
  // A retry may already own the frozen new-host plan while the old host is
  // still serving. Reuse that build ID; never reserve a competing upgrade.
  if (current && build && canonicalPluginManifest(build.host) === canonicalPluginManifest(host)
    && (ACTIVE_PLUGIN_BUILDS.has(build.status) || (sameHost && build.status === 'deployed'))) {
    const snapshot = await fetchDeliverySnapshot(connection, { fetchImpl });
    if (snapshot.buildId !== build.id || snapshot.planDigest !== build.planDigest
      || canonicalPluginManifest(snapshot.host) !== canonicalPluginManifest(host)) fail('PLUGIN_BUILD_SUPERSEDED');
    if (['deploying', 'activation_pending', 'rolling_back'].includes(snapshot.buildStatus)) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    return preparePlan(connection, snapshot, { root, fetchImpl, replay: snapshot.buildStatus === 'deployed' });
  }
  if (build?.resultUnknown) fail('PLUGIN_BUILD_RESULT_UNKNOWN');
  if (build && ACTIVE_PLUGIN_BUILDS.has(build.status)) fail('PLUGIN_BUILD_IN_PROGRESS');
  if (state.pending) fail('PLUGIN_UPGRADE_PENDING_CHANGES');
  if (sameHost) fail('PLUGIN_HOST_UNCHANGED');
  if (state.plugins.some(row => row.source.type !== 'artifact')) fail('PLUGIN_UPGRADE_ARTIFACT_REQUIRED');
  validateDeliveryPlan({ host, plugins: state.plugins });
  const snapshot = validateDeliverySnapshot(await buildRequest(connection, 'upgrade', { fetchImpl, body: {
    revision: state.revision, registryRevision: state.registryRevision, fromHost: state.host,
    runningDigest: state.runningDigest, host,
  } }));
  if (canonicalPluginManifest(snapshot.host) !== canonicalPluginManifest(host)
    || canonicalPluginManifest(snapshot.plugins) !== canonicalPluginManifest(state.plugins)) fail('PLUGIN_BUILD_RESPONSE_INVALID');
  return preparePlan(connection, snapshot, { root, fetchImpl });
}

export async function runDeliveryCommand(command, { root = repositoryRoot, environment = process.env, fetchImpl = fetch, status } = {}) {
  if (command === 'prepare-host-upgrade' || command === 'prepare-current') {
    return prepareHostUpgrade({ root, environment, fetchImpl, current: command === 'prepare-current' });
  }
  const connection = deliveryConnection(environment);
  if (command === 'prepare') {
    const snapshot = await fetchDeliverySnapshot(connection, { fetchImpl });
    if (['deploying', 'activation_pending', 'rolling_back', 'deployed'].includes(snapshot.buildStatus)) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    return preparePlan(connection, snapshot, { root, fetchImpl });
  }
  const deployment = await readPreparedDeployment(root);
  if (command === 'check-plan') return checkDeliveryPlan(connection, deployment, { root, fetchImpl });
  if (command === 'report') {
    const result = await reportDelivery(connection, deployment, status, { fetchImpl });
    return { buildId: result.buildId, status: result.status };
  }
  fail('PLUGIN_BUILD_COMMAND_INVALID');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runDeliveryCommand(process.argv[2], { status: process.argv[3] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Network errors may include credential-bearing URLs. Only fixed codes are
    // written to CI logs, never arbitrary response text, URLs or stack traces.
    const safe = /^PLUGIN_[A-Z_]+$/.test(error.code || '') ? error.code : 'PLUGIN_BUILD_FAILED';
    process.stderr.write(`${safe}\n`);
    process.exitCode = 1;
  }
}
