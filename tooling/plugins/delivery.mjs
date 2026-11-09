import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemblePluginDelivery, publicHttpsUrl, readBoundedResponse, SNAPSHOT_MAX_BYTES, validateDeliverySnapshot } from './assemble.mjs';
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

export async function runDeliveryCommand(command, { root = repositoryRoot, environment = process.env, fetchImpl = fetch, status } = {}) {
  const connection = deliveryConnection(environment);
  if (command === 'prepare') {
    const snapshot = await fetchDeliverySnapshot(connection, { fetchImpl });
    if (['deploying', 'activation_pending', 'rolling_back', 'deployed'].includes(snapshot.buildStatus)) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    try {
      // A clean reviewed checkout contains baseline descriptors and bridges;
      // restore its hash-verified ignored package cache before checking sources.
      // This never replaces a site's selected deployment metadata.
      let seed;
      try { seed = JSON.parse(await readFile(resolve(root, 'plugins.seed.lock.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (seed) await preparePluginSeed({ root, seed, fetchImpl });
      await assemblePluginDelivery({ root, snapshot, fetchImpl });
      // Mark building only after the immutable plan and all package bytes passed
      // validation. Reporting is not a deployment or activation acknowledgement.
      await reportDelivery(connection, snapshot, 'building', { fetchImpl });
    } catch (error) {
      await reportDelivery(connection, snapshot, 'failed', { fetchImpl }).catch(() => {});
      throw error;
    }
    return { buildId: snapshot.buildId, planDigest: snapshot.planDigest, prepared: true };
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
