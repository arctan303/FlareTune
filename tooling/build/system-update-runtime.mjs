import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPluginHostBuild } from '../plugins/host-identity.mjs';
import { materializePluginArtifacts, readBoundedResponse, validatePluginArtifact, publicHttpsUrl, ARTIFACT_MAX_BYTES } from '../plugins/assemble.mjs';
import { HOST_PLUGIN_API_VERSION, validatePluginManifests, resolvePluginAvailability } from '../../shared/plugins/manifest.js';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

export async function generateSystemUpdateRuntime({ root = defaultRoot, commit = process.env.FLARETUNE_UPDATE_COMMIT } = {}) {
  const host = await createPluginHostBuild(root);
  const deliveryPath = resolve(root, 'shared/plugins/delivery.generated.js');
  let hasDelivery = true;
  try { await readFile(deliveryPath); } catch (error) { if (error.code === 'ENOENT') hasDelivery = false; else throw error; }
  const delivery = hasDelivery ? await import(`${pathToFileURL(deliveryPath).href}?runtime=${crypto.randomUUID()}`)
    : { deliveryPluginManifests: [], compiledPluginSources: {} };
  const plugins = delivery.deliveryPluginManifests.map(manifest => ({ id: manifest.id, version: manifest.version,
    manifest, source: delivery.compiledPluginSources[manifest.id] }));
  if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit)) fail('SYSTEM_UPDATE_COMMIT_INVALID');
  const identity = { ...host, ...(commit ? { commit } : {}), hostApiVersion: hasDelivery ? HOST_PLUGIN_API_VERSION : 1 };
  const source = hasDelivery
    ? `import { deliveryPluginManifests, compiledPluginSources } from './plugins/delivery.generated.js';\n`
      + `const plugins = Object.freeze(deliveryPluginManifests.map(manifest => Object.freeze({ id: manifest.id, version: manifest.version, manifest, source: compiledPluginSources[manifest.id] })));\n`
    : 'const plugins = Object.freeze([]);\n';
  await writeFile(resolve(root, 'shared/systemUpdate.generated.js'),
    `// Generated from the actual host and compiled package selection. No instance credentials.\n${source}`
      + `export const systemUpdateRuntime = Object.freeze({ ...${JSON.stringify(identity, null, 2)}, plugins });\n`);
  return { host, plugins: plugins.map(({ id, version }) => ({ id, version })) };
}

export async function prepareSystemUpdateRuntime({ root = defaultRoot, plan, fetchImpl = fetch } = {}) {
  root = await realpath(root);
  if (!plan || !plan.target?.host || !Array.isArray(plan.plugins) || plan.plugins.length > 32) fail('SYSTEM_UPDATE_PLAN_INVALID');
  const host = await createPluginHostBuild(root);
  if (host.version !== plan.target.host.version || host.sourceDigest !== plan.target.host.sourceDigest) fail('SYSTEM_UPDATE_HOST_MISMATCH');
  const manifests = validatePluginManifests(plan.plugins.map(plugin => plugin.manifest));
  const ids = manifests.map(manifest => manifest.id);
  const artifacts = []; let total = 0;
  for (const entry of plan.plugins) {
    if (entry.id !== entry.manifest.id || entry.version !== entry.manifest.version || entry.source?.type !== 'artifact'
      || !/^[a-f0-9]{64}$/.test(entry.source.sha256 || '')) fail('SYSTEM_UPDATE_PLUGIN_INVALID');
    if (!resolvePluginAvailability(manifests, ids, entry.id).available) fail('SYSTEM_UPDATE_PLUGIN_INCOMPATIBLE');
    const response = await fetchImpl(publicHttpsUrl(entry.source.url), { redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
    if (!response.ok) fail('SYSTEM_UPDATE_PLUGIN_DOWNLOAD_FAILED');
    const bytes = await readBoundedResponse(response, ARTIFACT_MAX_BYTES, 'SYSTEM_UPDATE_PLUGIN_DOWNLOAD_FAILED');
    total += bytes.length;
    if (total > 32 * 1024 * 1024) fail('SYSTEM_UPDATE_PLUGIN_TOO_LARGE');
    if (sha256(bytes) !== entry.source.sha256) fail('SYSTEM_UPDATE_PLUGIN_DIGEST_MISMATCH');
    let artifact;
    try { artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('SYSTEM_UPDATE_PLUGIN_INVALID'); }
    validatePluginArtifact(artifact, entry.manifest);
    artifacts.push({ entry, artifact });
  }
  // System updates have their own authenticated activation protocol. Do not
  // invent a plugin-delivery activation or alter installation records/epochs.
  await materializePluginArtifacts({ root, artifacts, pluginDeployment: null });
  return generateSystemUpdateRuntime({ root, commit: plan.target.commit });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || 'generate';
    const parameter = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
    const commit = parameter('--commit') || process.env.FLARETUNE_UPDATE_COMMIT;
    let result;
    if (command === 'prepare') {
      const path = parameter('--plan'); if (!path) fail('SYSTEM_UPDATE_PLAN_MISSING');
      result = await prepareSystemUpdateRuntime({ plan: JSON.parse(await readFile(resolve(path), 'utf8')) });
    } else if (command === 'generate') result = await generateSystemUpdateRuntime({ commit });
    else fail('SYSTEM_UPDATE_COMMAND_INVALID');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(/^SYSTEM_UPDATE_[A-Z_]+$/.test(error.code || '') ? error.code : 'SYSTEM_UPDATE_RUNTIME_FAILED'); process.exitCode = 1; }
}
