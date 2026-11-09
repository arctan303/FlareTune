import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginManifests, resolvePluginAvailability } from '../../shared/plugins/manifest.js';
import { ARTIFACT_MAX_BYTES, readBoundedResponse, validatePluginArtifact, publicHttpsUrl,
  hydratePluginArtifactCache, materializePluginArtifacts, readPluginOwnedFile, writePluginOwnedFile } from './assemble.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const fail = code => { throw Object.assign(new Error(code), { code }); };

// This lock is the reviewed host distribution, not a site's installation state.
// Fixed Git commit URLs and wire hashes make a clean checkout reproducible.
export function validatePluginSeed(seed) {
  if (!plain(seed) || !keys(seed, ['schemaVersion', 'plugins']) || seed.schemaVersion !== 1
    || !Array.isArray(seed.plugins) || seed.plugins.length > 32) fail('PLUGIN_SEED_INVALID');
  const manifests = validatePluginManifests(seed.plugins.map(entry => entry.manifest));
  const ids = manifests.map(manifest => manifest.id);
  for (const entry of seed.plugins) {
    if (!plain(entry) || !keys(entry, ['id', 'version', 'manifest', 'source'])
      || entry.id !== entry.manifest.id || entry.version !== entry.manifest.version
      || !plain(entry.source) || !keys(entry.source, ['type', 'id', 'url', 'sha256'])
      || entry.source.type !== 'artifact' || entry.source.id !== 'official'
      || !/^[a-f0-9]{64}$/.test(entry.source.sha256 || '')) fail('PLUGIN_SEED_INVALID');
    const url = publicHttpsUrl(entry.source.url);
    if (!/^https:\/\/raw\.githubusercontent\.com\/arctan303\/FlareTune-Plugins\/[a-f0-9]{40}\/artifacts\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[a-f0-9]{64}\.json$/.test(url)) fail('PLUGIN_SEED_INVALID');
    if (!resolvePluginAvailability(manifests, ids, entry.id).available) fail('PLUGIN_SEED_INCOMPATIBLE');
  }
  return seed;
}

export async function loadPluginSeedArtifacts({ root = repositoryRoot, fetchImpl = fetch, seed } = {}) {
  seed = validatePluginSeed(seed || JSON.parse(await readFile(resolve(root, 'plugins.seed.lock.json'), 'utf8')));
  const artifacts = []; let total = 0;
  for (const entry of seed.plugins) {
    const cache = `shared/plugins/.artifact-cache/${entry.source.sha256}.json`;
    let bytes;
    try { bytes = await readPluginOwnedFile(root, cache); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetchImpl(entry.source.url, { redirect: 'error', credentials: 'omit',
        signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
      bytes = await readBoundedResponse(response, ARTIFACT_MAX_BYTES);
    }
    total += bytes.length;
    if (total > 32 * 1024 * 1024) fail('PLUGIN_PLAN_TOO_LARGE');
    if (sha256(bytes) !== entry.source.sha256) fail('PLUGIN_ARTIFACT_DIGEST_MISMATCH');
    let artifact;
    try { artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('PLUGIN_ARTIFACT_INVALID'); }
    validatePluginArtifact(artifact, entry.manifest);
    await writePluginOwnedFile(root, cache, bytes, true);
    artifacts.push({ entry, artifact });
  }
  return artifacts;
}

export async function preparePluginSeed({ root = repositoryRoot, fetchImpl = fetch, seed, bootstrap = false } = {}) {
  const artifacts = await loadPluginSeedArtifacts({ root, fetchImpl, seed });
  // A regular build only restores missing immutable caches. It must not restore
  // removed plugins, overwrite a selected deployment or invent an activation ID.
  if (bootstrap) return materializePluginArtifacts({ root, artifacts });
  await hydratePluginArtifactCache({ root, artifacts });
  return { artifacts: artifacts.length, hydrated: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (!['hydrate', 'bootstrap'].includes(command)) fail('PLUGIN_SEED_COMMAND_INVALID');
    process.stdout.write(`${JSON.stringify(await preparePluginSeed({ bootstrap: command === 'bootstrap' }))}\n`);
  } catch (error) {
    process.stderr.write(`${/^PLUGIN_[A-Z_]+$/.test(error.code || '') ? error.code : 'PLUGIN_SEED_FAILED'}\n`);
    process.exitCode = 1;
  }
}
