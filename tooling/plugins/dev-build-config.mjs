import { createHash } from 'node:crypto';
import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentWorkerDeployment, workerVersionBindingsDigest } from './delivery-deploy.mjs';
import { readBoundedResponse } from './assemble.mjs';

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || '');
const devDatabaseHash = 'dc5903fa4191441af4be867084a6720983eb87b14d8824cc9cb24c2efaef6554';
export const DEV_BUILD_CONFIG_PATH = 'tooling/plugins/.delivery-recovery/dev-wrangler.json';

// Only the already provisioned development instance is supported by this
// maintainer helper. Generic delivery still performs its independent comparison.
export function developmentBuildConfig(version, { root = rootDirectory, accountId, template = {},
  verifyDatabaseImpl = id => createHash('sha256').update(id).digest('hex') === devDatabaseHash } = {}) {
  workerVersionBindingsDigest(version);
  if (!/^[a-f0-9]{32}$/.test(accountId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(template.compatibility_date || '')) fail('PLUGIN_DEV_CONFIG_INVALID');
  const config = { name: 'flaretune-dev', account_id: accountId, main: resolve(root, 'server/src/flaretune.js'),
    compatibility_date: template.compatibility_date, keep_vars: true, workers_dev: true, preview_urls: false };
  for (const key of ['compatibility_flags', 'rules', 'observability', 'placement', 'limits', 'migrations']) {
    if (template[key] !== undefined) config[key] = structuredClone(template[key]);
  }
  if (!template.assets || template.assets.binding !== 'ASSETS') fail('PLUGIN_DEV_CONFIG_INVALID');
  config.assets = { ...structuredClone(template.assets), directory: resolve(root, 'dist') };
  config.vars = {};
  const add = (key, value) => { (config[key] ||= []).push(value); };
  for (const binding of version.resources.bindings) {
    switch (binding.type) {
      case 'd1':
        if (binding.name !== 'DB' || !uuid(binding.id) || !verifyDatabaseImpl(binding.id)) fail('PLUGIN_DEV_DATABASE_MISMATCH');
        add('d1_databases', { binding: binding.name, database_name: 'flaretune-db-dev', database_id: binding.id,
          migrations_dir: resolve(root, 'server/db/migrations-flaretune') });
        break;
      case 'kv_namespace': add('kv_namespaces', { binding: binding.name, id: binding.namespace_id }); break;
      case 'r2_bucket': add('r2_buckets', { binding: binding.name, bucket_name: binding.bucket_name,
        ...(binding.jurisdiction ? { jurisdiction: binding.jurisdiction } : {}) }); break;
      case 'service': add('services', { binding: binding.name, service: binding.service,
        ...(binding.environment ? { environment: binding.environment } : {}), ...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}) }); break;
      case 'durable_object_namespace': {
        if (typeof binding.class_name !== 'string' || !binding.class_name) fail('PLUGIN_DEV_CONFIG_UNSUPPORTED_BINDING');
        const local = !binding.script_name || binding.script_name === config.name;
        config.durable_objects ||= { bindings: [] };
        config.durable_objects.bindings.push({ name: binding.name, class_name: binding.class_name,
          ...(!local ? { script_name: binding.script_name, ...(binding.environment ? { environment: binding.environment } : {}) } : {}) });
        break;
      }
      case 'plain_text': config.vars[binding.name] = binding.text; break;
      case 'json': config.vars[binding.name] = structuredClone(binding.json); break;
      // Version uploads keep existing secrets; never retrieve or serialize values.
      case 'secret_text': case 'secret_key': break;
      case 'assets': if (binding.name !== config.assets.binding) fail('PLUGIN_DEV_CONFIG_INVALID'); break;
      default: fail('PLUGIN_DEV_CONFIG_UNSUPPORTED_BINDING');
    }
  }
  return config;
}

async function readTemplate(root) {
  const { unstable_readConfig } = await import('wrangler');
  return unstable_readConfig({ config: resolve(root, 'wrangler.toml'), env: 'dev' }, { hideWarnings: true });
}

export async function prepareDevelopmentBuildConfig({ root = rootDirectory, environment = process.env,
  fetchImpl = fetch, readTemplateImpl = readTemplate } = {}) {
  const target = { workerName: environment.FLARETUNE_PLUGIN_WORKER_NAME,
    accountId: environment.CLOUDFLARE_ACCOUNT_ID, token: environment.CLOUDFLARE_API_TOKEN };
  if (target.workerName !== 'flaretune-dev' || !/^[a-f0-9]{32}$/.test(target.accountId || '')
    || typeof target.token !== 'string' || target.token.length < 20 || /\s/.test(target.token)
    || (environment.WRANGLER_CI_OVERRIDE_NAME && environment.WRANGLER_CI_OVERRIDE_NAME !== target.workerName)
    || [environment.CLOUDFLARE_API_BASE_URL, environment.CF_API_BASE_URL].some(url => url && url !== 'https://api.cloudflare.com/client/v4')) fail('PLUGIN_DEPLOY_TARGET_MISMATCH');
  root = await realpath(root);
  const deployment = await currentWorkerDeployment(target, { fetchImpl });
  let first; let digest;
  for (const active of deployment.versions) {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/scripts/flaretune-dev/versions/${active.version_id}`, {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json' },
    });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('PLUGIN_DEPLOY_PROVIDER_FAILED'); }
    let result;
    try { result = JSON.parse((await readBoundedResponse(response, 1024 * 1024)).toString('utf8')); }
    catch { fail('PLUGIN_DEPLOY_PROVIDER_FAILED'); }
    if (result.success !== true || result.result?.id !== active.version_id) fail('PLUGIN_DEPLOY_PROVIDER_FAILED');
    const current = workerVersionBindingsDigest(result.result);
    if (digest && digest !== current) fail('PLUGIN_DEPLOY_BINDINGS_MISMATCH');
    first ||= result.result; digest = current;
  }
  const config = developmentBuildConfig(first, { root, accountId: target.accountId, template: await readTemplateImpl(root) });
  const output = resolve(root, DEV_BUILD_CONFIG_PATH);
  const rel = relative(root, output);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('PLUGIN_OUTPUT_PATH_INVALID');
  let cursor = dirname(output);
  while (cursor !== root) {
    try { if ((await lstat(cursor)).isSymbolicLink()) fail('PLUGIN_OUTPUT_PATH_INVALID'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
  await mkdir(dirname(output), { recursive: true });
  try { if ((await lstat(output)).isSymbolicLink()) fail('PLUGIN_OUTPUT_PATH_INVALID'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { configPath: output, deploymentId: deployment.id };
}
