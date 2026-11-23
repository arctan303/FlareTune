import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryConnection, fetchDeliveryWireSnapshot, reportDelivery, runDeliveryCommand } from './delivery.mjs';
import { deployPluginDelivery } from './delivery-deploy.mjs';
import { prepareDevelopmentBuildConfig } from './dev-build-config.mjs';
import { createPluginHostBuild } from './host-identity.mjs';
import { runBuildCommand, sanitizedBuildEnvironment, verifySourceCheckout } from '../updates/bootstrap.mjs';
import { classifyPluginCiSnapshot, exactHostRelease, loadExactPluginTool, pinPluginBuildFetch, readExactPluginSource,
  saveExactPluginSource, saveIdlePluginBuild, stageExactPluginSource } from './ci-exact-source.mjs';

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const defaultBranch = 'dev';
const buildController = 'flaretune-plugin-build';

export function pluginCiContext(environment = process.env) {
  const branch = environment.FLARETUNE_PLUGIN_BUILD_BRANCH || defaultBranch;
  // A literal branch name, never a pattern or a ref selected by an HTTP body.
  if (typeof branch !== 'string' || branch.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.')
    || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))
    || environment.WORKERS_CI !== '1' || environment.WORKERS_CI_BRANCH !== branch) fail('PLUGIN_CI_BRANCH_MISMATCH');
  deliveryConnection(environment);
  if (environment.FLARETUNE_PLUGIN_WORKER_NAME !== 'flaretune-dev'
    || environment.FLARETUNE_PLUGIN_SITE_URL !== 'https://tune-dev.arcinks.com') fail('PLUGIN_DEPLOY_TARGET_MISMATCH');
  const providerWorker = environment.WRANGLER_CI_OVERRIDE_NAME;
  if (providerWorker && providerWorker !== 'flaretune-dev'
    && !(providerWorker === buildController && branch === defaultBranch)) fail('PLUGIN_DEPLOY_TARGET_MISMATCH');
  if (providerWorker === buildController && !/^[a-f0-9]{32}$/.test(environment.FLARETUNE_PLUGIN_DEPLOY_WORKER_TAG || '')) {
    fail('PLUGIN_DEPLOY_TARGET_MISMATCH');
  }
  return { branch };
}

async function runNpm(root, args, environment) {
  // Cloudflare's Linux build image provides npm. Windows local verification uses
  // npm's known CLI entry, without interpolating a command through a shell.
  const npmCli = process.platform === 'win32' ? environment.npm_execpath : undefined;
  if (process.platform === 'win32' && (!npmCli || !/[\\/]npm-cli\.js$/.test(npmCli))) fail('PLUGIN_CI_NPM_MISSING');
  return new Promise((accept, reject) => {
    const child = spawn(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args,
      { cwd: root, env: environment, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', () => reject(Object.assign(new Error('PLUGIN_CI_COMMAND_FAILED'), { code: 'PLUGIN_CI_COMMAND_FAILED' })));
    child.once('exit', code => code === 0 ? accept() : reject(Object.assign(new Error('PLUGIN_CI_COMMAND_FAILED'), { code: 'PLUGIN_CI_COMMAND_FAILED' })));
  });
}

const runPinnedNpm = (root, args, environment) => runBuildCommand(root, 'npm', args, environment);

export async function runPluginCiChannel(command, { root = rootDirectory, environment = process.env,
  runDeliveryImpl, runNpmImpl, prepareConfigImpl, deployImpl, reportImpl = reportDelivery, fetchImpl = fetch,
  fetchSnapshot = fetchDeliveryWireSnapshot, stageSource = stageExactPluginSource, loadTool = loadExactPluginTool,
  hostIdentity = createPluginHostBuild } = {}) {
  pluginCiContext(environment);
  const buildWorkerName = environment.WRANGLER_CI_OVERRIDE_NAME === buildController ? buildController : undefined;
  // A dedicated Builds controller has no application bindings or traffic. Its
  // reviewed exact branch deploys only to the existing development instance;
  // the generic deployment/configuration guards still receive that exact target.
  if (environment.WRANGLER_CI_OVERRIDE_NAME === buildController) {
    environment = { ...environment, WRANGLER_CI_OVERRIDE_NAME: 'flaretune-dev',
      WRANGLER_CI_MATCH_TAG: environment.FLARETUNE_PLUGIN_DEPLOY_WORKER_TAG };
  }
  const connection = deliveryConnection(environment);
  if (command === 'build') {
    let prepared;
    try {
      const snapshot = await fetchSnapshot(connection, { fetchImpl });
      const selected = classifyPluginCiSnapshot(snapshot);
      if (selected === 'idle') {
        await saveIdlePluginBuild(root, snapshot);
        return { status: 'idle' };
      }
      const frozenFetch = pinPluginBuildFetch(connection, snapshot, fetchImpl, fetchSnapshot);
      if (selected === 'legacy') {
        const local = await hostIdentity(root);
        if (local.version !== snapshot.host.version || local.sourceDigest !== snapshot.host.sourceDigest) fail('PLUGIN_HOST_BUILD_MISMATCH');
        // Continue an explicitly reserved, matching host upgrade. The standalone
        // maintainer CLI still handles a deliberate new reservation.
        prepared = await (runDeliveryImpl ?? runDeliveryCommand)('prepare-current', { root, environment, fetchImpl: frozenFetch });
        await (runNpmImpl ?? runNpm)(root, ['run', 'plugins:lock'], environment);
        await (runNpmImpl ?? runNpm)(root, ['run', 'build'], environment);
      } else {
        const release = exactHostRelease(snapshot);
        const checkout = release ? await stageSource(root, release, { fetchImpl }) : root;
        const compile = runNpmImpl ?? runPinnedNpm;
        const compileEnv = sanitizedBuildEnvironment(environment, release?.commit);
        if (release) {
          await compile(checkout, ['ci'], compileEnv);
          await verifySourceCheckout(checkout, release);
        } else {
          const local = await hostIdentity(root);
          if (local.version !== snapshot.host.version || local.sourceDigest !== snapshot.host.sourceDigest) fail('PLUGIN_CI_SOURCE_REQUIRED');
        }
        const prepare = runDeliveryImpl ?? (release ? (await loadTool(checkout, 'tooling/plugins/delivery.mjs')).runDeliveryCommand : runDeliveryCommand);
        prepared = await prepare('prepare', { root: checkout,
          environment: { FLARETUNE_PLUGIN_SITE_URL: connection.origin, FLARETUNE_PLUGIN_BUILD_TOKEN: connection.token },
          fetchImpl: frozenFetch });
        if (prepared?.buildId !== snapshot.buildId || prepared?.planDigest !== snapshot.planDigest) {
          prepared = undefined;
          fail('PLUGIN_BUILD_SUPERSEDED');
        }
        await compile(checkout, ['run', 'plugins:lock'], compileEnv);
        await compile(checkout, ['run', 'build'], compileEnv);
        if (release) {
          await verifySourceCheckout(checkout, release);
          await saveExactPluginSource(root, checkout, snapshot, release);
        }
      }
    } catch (error) {
      // Preparation failures cannot fail somebody else's old task. Compilation
      // failures after a reservation belong only to that frozen build ID.
      if (prepared && !prepared.replay && /^[a-f0-9-]{36}$/.test(prepared.buildId || '')
        && /^[a-f0-9]{64}$/.test(prepared.planDigest || '')) {
        await reportImpl(connection, prepared, 'failed', { fetchImpl }).catch(() => {});
      }
      throw error;
    }
    return { status: 'built' };
  }
  if (command === 'deploy' || command === 'recover') {
    const exact = await readExactPluginSource(root, connection, { fetchImpl, fetchSnapshot });
    if (exact?.idle) return { status: 'idle' };
    const checkout = exact?.checkout ?? root;
    const prepareConfig = prepareConfigImpl ?? (exact ? (await loadTool(checkout, 'tooling/plugins/dev-build-config.mjs')).prepareDevelopmentBuildConfig : prepareDevelopmentBuildConfig);
    const deploy = deployImpl ?? (exact ? (await loadTool(checkout, 'tooling/plugins/delivery-deploy.mjs')).deployPluginDelivery : deployPluginDelivery);
    const pinnedFetch = exact ? pinPluginBuildFetch(connection, exact.snapshot, fetchImpl, fetchSnapshot) : fetchImpl;
    const { configPath } = await prepareConfig({ root: checkout, environment, fetchImpl: pinnedFetch });
    return deploy({ root: checkout, fetchImpl: pinnedFetch, ...(buildWorkerName ? { buildWorkerName } : {}), environment: { ...environment,
      FLARETUNE_PLUGIN_WRANGLER_CONFIG: configPath, FLARETUNE_PLUGIN_WRANGLER_ENV: '' }, recover: command === 'recover' });
  }
  fail('PLUGIN_BUILD_COMMAND_INVALID');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runPluginCiChannel(process.argv[2]))}\n`); }
  catch (error) { process.stderr.write(`${/^PLUGIN_[A-Z_]+$/.test(error.code || '') ? error.code : 'PLUGIN_CI_FAILED'}\n`); process.exitCode = 1; }
}
