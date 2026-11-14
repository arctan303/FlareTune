import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginHostBuild } from '../plugins/host-identity.mjs';
import { downloadSource, extractSourceArchive } from './archive.mjs';
import { updateConnection, fetchUpdatePlan, currentUpdatePlan, reportUpdate, withUpdateLease, fail } from './protocol.mjs';
import { deploySystemUpdate, updateTarget, verifyUpdateTarget } from './deploy.mjs';

export function sanitizedBuildEnvironment(environment = process.env, commit) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'npm_execpath', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
  return { ...Object.fromEntries(allowed.filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]])),
    CI: 'true', FLARETUNE_UPDATE_COMMIT: commit, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' };
}
export async function runBuildCommand(root, executable, args, environment, { signal } = {}) {
  let command = executable, parameters = args;
  if (executable === 'node') command = process.execPath;
  if (executable === 'npm' && process.platform === 'win32') {
    if (!/[\\/]npm-cli\.js$/.test(environment.npm_execpath || '')) fail('SYSTEM_UPDATE_NPM_MISSING');
    command = process.execPath; parameters = [environment.npm_execpath, ...args];
  }
  await new Promise((accept, reject) => {
    // Build output is not forwarded: dependencies and plugins must not leak
    // source content or private build inputs through arbitrary CI stderr.
    if (signal?.aborted) { reject(Object.assign(new Error('SYSTEM_UPDATE_LEASE_LOST'), { code: 'SYSTEM_UPDATE_LEASE_LOST' })); return; }
    const child = spawn(command, parameters, { cwd: root, env: environment, shell: false, windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
    const stop = () => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } };
    const cancel = () => { stop(); reject(Object.assign(new Error('SYSTEM_UPDATE_LEASE_LOST'), { code: 'SYSTEM_UPDATE_LEASE_LOST' })); };
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { stop(); reject(Object.assign(new Error('SYSTEM_UPDATE_BUILD_TIMEOUT'), { code: 'SYSTEM_UPDATE_BUILD_TIMEOUT' })); }, 12 * 60 * 1000);
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    child.once('error', () => { clear(); reject(Object.assign(new Error('SYSTEM_UPDATE_BUILD_FAILED'), { code: 'SYSTEM_UPDATE_BUILD_FAILED' })); });
    child.once('exit', code => { clear(); code === 0 ? accept() : reject(Object.assign(new Error('SYSTEM_UPDATE_BUILD_FAILED'), { code: 'SYSTEM_UPDATE_BUILD_FAILED' })); });
  });
}
export async function verifySourceCheckout(root, target) {
  const actual = await createPluginHostBuild(root);
  let lock;
  try { lock = JSON.parse(await readFile(resolve(root, 'plugins.lock.json'), 'utf8')); }
  catch { fail('SYSTEM_UPDATE_CHECKOUT_INVALID'); }
  if (actual.version !== target.host.version || actual.sourceDigest !== target.host.sourceDigest
    || lock.host?.version !== actual.version || lock.host?.sourceDigest !== actual.sourceDigest
    || lock.hostApiVersion !== target.hostApiVersion) fail('SYSTEM_UPDATE_HOST_MISMATCH');
  return actual;
}
export async function buildSystemUpdate(plan, { root, environment = process.env, fetchImpl = fetch,
  downloadImpl = downloadSource, extractImpl = extractSourceArchive, runCommandImpl = runBuildCommand,
  verifySourceImpl = verifySourceCheckout, lease } = {}) {
  lease?.check();
  const bytes = await downloadImpl(plan.target, { fetchImpl });
  await extractImpl(bytes, plan.target.commit, root);
  await verifySourceImpl(root, plan.target);
  const childEnvironment = sanitizedBuildEnvironment(environment, plan.target.commit);
  const run = async (executable, args, failureCode) => {
    lease?.check();
    try { await runCommandImpl(root, executable, args, childEnvironment, { signal: lease?.signal }); }
    catch (error) { if (error.code === 'SYSTEM_UPDATE_LEASE_LOST') throw error; fail(failureCode); }
    lease?.check();
  };
  const planPath = resolve(root, '.system-update-plan.json');
  await writeFile(planPath, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
  try {
    await run('npm', ['ci'], 'SYSTEM_UPDATE_DEPENDENCIES_FAILED');
    await run('npm', ['run', 'plugins:hydrate'], 'SYSTEM_UPDATE_PACKAGE_HYDRATION_FAILED');
    // These are fixed commands from the trusted official checkout, never HTTP
    // supplied commands, paths, package managers or shell fragments.
    await run('node', ['tooling/build/system-update-runtime.mjs', 'prepare', '--plan', planPath, '--commit', plan.target.commit], 'SYSTEM_UPDATE_PACKAGE_ASSEMBLY_FAILED');
    await run('npm', ['run', 'plugins:lock'], 'SYSTEM_UPDATE_LOCK_FAILED');
    await run('node', ['tooling/build/system-update-runtime.mjs', 'generate', '--commit', plan.target.commit], 'SYSTEM_UPDATE_METADATA_FAILED');
    await run('npm', ['run', 'build'], 'SYSTEM_UPDATE_COMPILE_FAILED');
    await verifySourceImpl(root, plan.target);
  } finally { await rm(planPath, { force: true }); }
  return { root, taskId: plan.taskId, planDigest: plan.planDigest };
}

export async function runSystemUpdate({ environment = process.env, fetchImpl = fetch,
  buildImpl = buildSystemUpdate, deployImpl = deploySystemUpdate, verifyTargetImpl = verifyUpdateTarget, lease, connection: providedConnection } = {}) {
  const connection = providedConnection || updateConnection(environment), options = { fetchImpl };
  let plan = await fetchUpdatePlan(connection, options);
  if (!plan) return { status: 'idle' };
  if (['failed', 'rolled_back'].includes(plan.status)) fail('SYSTEM_UPDATE_RETRY_REQUIRED');
  if (!lease) return withUpdateLease(connection, plan, owned => runSystemUpdate({
    environment: { ...environment, FLARETUNE_SYSTEM_UPDATE_RUNNER_ID: connection.runnerId }, fetchImpl, buildImpl, deployImpl, verifyTargetImpl, lease: owned, connection }), options);
  lease.check();
  await verifyTargetImpl(updateTarget(environment), options);
  // Durable uploaded receipts allow a new CI machine to finish without a
  // checkout, package install, second upload or dependence on temporary files.
  if (plan.receipt?.nextVersionId || plan.receipt?.uploadStarted || plan.status === 'deployed') return deployImpl({ environment, fetchImpl, lease, connection });
  if (!['queued', 'building', 'activation_pending'].includes(plan.status)) fail('SYSTEM_UPDATE_RECEIPT_MISSING');
  const expected = { taskId: plan.taskId, planDigest: plan.planDigest };
  await reportUpdate(connection, plan, 'building', options);
  plan = await currentUpdatePlan(connection, expected, options);
  const scratch = await mkdtemp(resolve(tmpdir(), 'flaretune-system-source-'));
  try {
    await buildImpl(plan, { root: scratch, environment, fetchImpl, lease });
    await currentUpdatePlan(connection, expected, options);
    return await deployImpl({ root: scratch, environment, fetchImpl, lease, connection });
  } catch (error) {
    const current = await currentUpdatePlan(connection, expected, options).catch(() => null);
    if (current && ['queued', 'building', 'uploaded'].includes(current.status)) await reportUpdate(connection, expected, 'failed',
      { ...options, error: error.code || 'SYSTEM_UPDATE_BUILD_FAILED' }).catch(() => {});
    throw error;
  } finally {
    const absolute = await realpath(scratch), parent = await realpath(tmpdir());
    if (dirname(absolute) === parent && absolute.startsWith(resolve(parent, 'flaretune-system-source-'))) await rm(absolute, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'run') fail('SYSTEM_UPDATE_COMMAND_INVALID');
    const result = await runSystemUpdate();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'rolled_back') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${/^SYSTEM_UPDATE_[A-Z_]+$/.test(error?.code || '') ? error.code : 'SYSTEM_UPDATE_BUILD_FAILED'}\n`);
    process.exitCode = 1;
  }
}
