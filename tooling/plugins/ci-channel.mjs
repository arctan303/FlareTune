import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryConnection, runDeliveryCommand } from './delivery.mjs';
import { deployPluginDelivery } from './delivery-deploy.mjs';
import { prepareDevelopmentBuildConfig } from './dev-build-config.mjs';

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const defaultBranch = 'codex/plugin-host-dev-20261108';
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

export async function runPluginCiChannel(command, { root = rootDirectory, environment = process.env,
  runDeliveryImpl = runDeliveryCommand, runNpmImpl = runNpm,
  prepareConfigImpl = prepareDevelopmentBuildConfig, deployImpl = deployPluginDelivery } = {}) {
  pluginCiContext(environment);
  const buildWorkerName = environment.WRANGLER_CI_OVERRIDE_NAME === buildController ? buildController : undefined;
  // A dedicated Builds controller has no application bindings or traffic. Its
  // reviewed exact branch deploys only to the existing development instance;
  // the generic deployment/configuration guards still receive that exact target.
  if (environment.WRANGLER_CI_OVERRIDE_NAME === buildController) {
    environment = { ...environment, WRANGLER_CI_OVERRIDE_NAME: 'flaretune-dev',
      WRANGLER_CI_MATCH_TAG: environment.FLARETUNE_PLUGIN_DEPLOY_WORKER_TAG };
  }
  if (command === 'build') {
    await runDeliveryImpl('prepare', { root, environment });
    await runNpmImpl(root, ['run', 'plugins:lock'], environment);
    await runNpmImpl(root, ['run', 'build'], environment);
    return { status: 'built' };
  }
  if (command === 'deploy' || command === 'recover') {
    const { configPath } = await prepareConfigImpl({ root, environment });
    return deployImpl({ root, ...(buildWorkerName ? { buildWorkerName } : {}), environment: { ...environment,
      FLARETUNE_PLUGIN_WRANGLER_CONFIG: configPath, FLARETUNE_PLUGIN_WRANGLER_ENV: '' }, recover: command === 'recover' });
  }
  fail('PLUGIN_BUILD_COMMAND_INVALID');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runPluginCiChannel(process.argv[2]))}\n`); }
  catch (error) { process.stderr.write(`${/^PLUGIN_[A-Z_]+$/.test(error.code || '') ? error.code : 'PLUGIN_CI_FAILED'}\n`); process.exitCode = 1; }
}
