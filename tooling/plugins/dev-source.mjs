import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readdir, realpath, lstat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from '@babel/parser';
import { validatePluginManifests, resolvePluginAvailability } from '../../shared/plugins/manifest.js';
import { materializePluginArtifacts, hydratePluginArtifactCache, readPluginOwnedFile, writePluginOwnedFile,
  validatePluginArtifact, publicHttpsUrl, readBoundedResponse, ARTIFACT_MAX_BYTES } from './assemble.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const DEV_SOURCE_MARKER = '.tmp/plugins-dev-source.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const fixedOutputs = new Set(['client/src/plugins/delivery.generated.js', 'server/src/plugins/delivery.generated.js',
  'shared/plugins/delivery.generated.js', 'tooling/plugins/delivery-source.generated.json',
  'plugins.lock.json', 'shared/plugins/build.generated.js']);
const fail = (code, details) => { throw Object.assign(new Error(code), { code, ...details }); };
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function outputPath(value) {
  if (typeof value !== 'string' || value.length > 400 || value.includes('\\')
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || !/^[a-zA-Z0-9_.\/-]+$/.test(value)
    || !(fixedOutputs.has(value) || /^shared\/plugins\/\.(?:bridges|api)\/[a-z][a-z0-9-]*\/(?:client|server|shared)\/.+\.(?:js|mjs|jsx|json|css)$/.test(value))) {
    fail('PLUGIN_DEV_OUTPUT_INVALID');
  }
  return value;
}

export async function assertNoDevSourceOverride(root = repositoryRoot) {
  try { await lstat(resolve(root, DEV_SOURCE_MARKER)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('PLUGIN_DEV_SOURCE_ACTIVE');
}

function assertDevelopment(environment) {
  if (environment.NODE_ENV === 'production' || /^(?:1|true)$/i.test(environment.CI || '')) fail('PLUGIN_DEV_SOURCE_NOT_ALLOWED');
}

function generatedValue(code, name) {
  const program = parse(code, { sourceType: 'module' }).program;
  const expression = program.body.flatMap(node => node.type === 'ExportNamedDeclaration'
    ? node.declaration?.declarations || [] : []).find(node => node.id?.name === name)?.init;
  const frozen = expression?.type === 'CallExpression' && expression.callee?.object?.name === 'Object'
    && expression.callee?.property?.name === 'freeze' ? expression.arguments[0] : null;
  if (frozen?.type !== 'CallExpression' || frozen.callee?.object?.name !== 'JSON'
    || frozen.callee?.property?.name !== 'parse' || frozen.arguments.length !== 1
    || frozen.arguments[0]?.type !== 'StringLiteral') fail('PLUGIN_DEV_SELECTION_INVALID');
  return JSON.parse(frozen.arguments[0].value);
}

async function currentArtifacts(root, fetchImpl) {
  // Read the exact compiled selection, never restore every seed package. The
  // generated module is parsed as data, without executing package JavaScript.
  const code = await readPluginOwnedFile(root, 'shared/plugins/delivery.generated.js');
  const manifests = generatedValue(code.toString(), 'deliveryPluginManifests');
  const sources = generatedValue(code.toString(), 'compiledPluginSources');
  if (!Array.isArray(manifests) || manifests.length > 32 || !sources || typeof sources !== 'object') fail('PLUGIN_DEV_SELECTION_INVALID');
  const selected = [];
  for (const manifest of manifests) {
    const source = sources[manifest.id];
    if (!idPattern.test(manifest.id) || source?.type !== 'artifact' || !isDigest(source.sha256)) fail('PLUGIN_DEV_SELECTION_INVALID');
    const cache = `shared/plugins/.artifact-cache/${source.sha256}.json`;
    let wire;
    try { wire = await readPluginOwnedFile(root, cache); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetchImpl(publicHttpsUrl(source.url), { redirect: 'error', credentials: 'omit',
        signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json' } });
      wire = await readBoundedResponse(response, ARTIFACT_MAX_BYTES);
    }
    if (hash(wire) !== source.sha256) fail('PLUGIN_ARTIFACT_DIGEST_MISMATCH');
    const artifact = JSON.parse(wire.toString());
    validatePluginArtifact(artifact, manifest);
    selected.push({ entry: { id: manifest.id, version: manifest.version, manifest, source }, artifact });
  }
  return selected;
}

async function optionalBytes(root, path) {
  try { return await readPluginOwnedFile(root, path, 16 * 1024 * 1024); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function mutableStageFiles(root) {
  const result = new Map();
  for (const path of fixedOutputs) {
    const content = await optionalBytes(root, path);
    if (content !== null) result.set(path, content);
  }
  async function visit(path) {
    let entries;
    try { entries = await readdir(resolve(root, path), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) fail('PLUGIN_DEV_OUTPUT_INVALID');
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) result.set(outputPath(child), await readPluginOwnedFile(root, child));
    }
  }
  await visit('shared/plugins/.bridges'); await visit('shared/plugins/.api');
  return result;
}

async function computeDebugLock(root) {
  // createPluginLock imports the generated catalog at module initialization.
  // A fresh process reads the just-selected manifests instead of a stale cache.
  const code = "const {createPluginLock}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await createPluginLock()));";
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code,
    pathToFileURL(resolve(root, 'tooling/plugins/verify.mjs')).href], {
    cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function lockOutputs(lock) {
  const metadata = lock.plugins.map(({ sources, source, ...entry }) => entry);
  return new Map([
    ['plugins.lock.json', bytes(lock)],
    ['shared/plugins/build.generated.js', Buffer.from('// Generated by npm run plugins:lock; verify before every combined build.\n'
      + `export const pluginHostBuild = Object.freeze(${JSON.stringify(lock.host, null, 2)});\n`
      + `export const pluginBuilds = Object.freeze(${JSON.stringify(metadata, null, 2)});\n`)],
  ]);
}

export async function prepareDevSources({ root = repositoryRoot, pluginsRoot, ids = ['lyrics-workbench', 'youtube-music'],
  environment = process.env, fetchImpl = fetch, createArtifact: createArtifactImpl, createLock = computeDebugLock } = {}) {
  assertDevelopment(environment);
  root = await realpath(root);
  await assertNoDevSourceOverride(root);
  if (!pluginsRoot || !Array.isArray(ids) || !ids.length || ids.length > 32
    || new Set(ids).size !== ids.length || ids.some(id => !idPattern.test(id))) fail('PLUGIN_DEV_SOURCE_ARGUMENT_INVALID');
  pluginsRoot = await realpath(pluginsRoot);
  const current = await currentArtifacts(root, fetchImpl);
  if (ids.some(id => !current.some(item => item.entry.id === id))) fail('PLUGIN_DEV_SOURCE_NOT_SELECTED');
  if (!createArtifactImpl) {
    await readPluginOwnedFile(pluginsRoot, 'tooling/publish.mjs');
    createArtifactImpl = (await import(pathToFileURL(resolve(pluginsRoot, 'tooling/publish.mjs')).href)).createArtifact;
  }
  const wire = new Map(), replacements = new Map();
  for (const id of ids) {
    const built = await createArtifactImpl(id, { root: pluginsRoot });
    if (!built?.bytes || built.digest !== hash(built.bytes) || built.artifact?.manifest?.id !== id) fail('PLUGIN_DEV_ARTIFACT_INVALID');
    validatePluginArtifact(built.artifact, built.artifact.manifest);
    wire.set(built.digest, built.bytes);
    replacements.set(id, { entry: { id, version: built.artifact.manifest.version, manifest: built.artifact.manifest,
      source: { type: 'artifact', id: 'dev-local', url: `https://dev-source.invalid/${id}/${built.digest}.json`, sha256: built.digest } },
    artifact: built.artifact });
  }
  const artifacts = current.map(item => replacements.get(item.entry.id) || item);
  const manifests = validatePluginManifests(artifacts.map(item => item.entry.manifest));
  const selectedIds = manifests.map(manifest => manifest.id);
  if (manifests.some(manifest => !resolvePluginAvailability(manifests, selectedIds, manifest.id).available)) fail('PLUGIN_DEV_SELECTION_INCOMPATIBLE');
  const runId = randomUUID(), runPath = `.tmp/plugins-dev-source/${runId}`;
  const stage = resolve(root, runPath, 'stage');
  await mkdir(stage, { recursive: true });
  const compatibility = await optionalBytes(root, 'tooling/plugins/compatibility.json');
  if (compatibility) await writePluginOwnedFile(stage, 'tooling/plugins/compatibility.json', compatibility);
  await materializePluginArtifacts({ root: stage, artifacts, pluginDeployment: null });
  const outputs = await mutableStageFiles(stage);
  const marker = { schemaVersion: 1, mode: 'dev-source', root, runId, runPath, pluginsRoot,
    createdAt: new Date().toISOString(), state: 'prepared',
    selected: artifacts.map(item => ({ id: item.entry.id, sha256: item.entry.source.sha256, local: replacements.has(item.entry.id) })), files: [] };
  async function register(newOutputs) {
    for (const [path, after] of newOutputs) {
      outputPath(path);
      const before = await optionalBytes(root, path);
      if (before?.equals(after)) continue;
      const backup = before === null ? null : `${runPath}/backup/${path}`;
      if (backup) await writePluginOwnedFile(root, backup, before, true);
      marker.files.push({ path, backup, beforeSha256: before === null ? null : hash(before), afterSha256: hash(after) });
    }
  }
  const saveMarker = () => writePluginOwnedFile(root, DEV_SOURCE_MARKER, bytes(marker));
  async function apply(newOutputs) {
    const changes = marker.files.filter(item => newOutputs.has(item.path));
    for (const item of changes) {
      const found = await optionalBytes(root, item.path);
      if ((found === null ? null : hash(found)) !== item.beforeSha256) fail('PLUGIN_DEV_PREPARE_CONFLICT', { paths: [item.path] });
    }
    for (const item of changes) await writePluginOwnedFile(root, item.path, newOutputs.get(item.path));
  }
  await register(outputs);
  // Reserve the marker before touching mutable checkout outputs. This also
  // rejects a second prepare that raced the initial active-marker check.
  await writePluginOwnedFile(root, DEV_SOURCE_MARKER, bytes(marker), true);
  try {
    await hydratePluginArtifactCache({ root, artifacts });
    for (const [digest, content] of wire) await writePluginOwnedFile(root, `shared/plugins/.artifact-cache/${digest}.json`, content, true);
    await apply(outputs);
    const debug = lockOutputs(await createLock(root));
    await register(debug); await saveMarker(); await apply(debug);
    marker.state = 'active'; await saveMarker();
  } catch (error) {
    marker.state = 'failed'; marker.error = /^PLUGIN_[A-Z_]+$/.test(error.code || '') ? error.code : 'PLUGIN_DEV_PREPARE_FAILED';
    await saveMarker(); throw error;
  }
  return { mode: 'dev-source', marker: DEV_SOURCE_MARKER, plugins: ids, retained: current.length - ids.length, files: marker.files.length };
}

export async function restoreDevSources({ root = repositoryRoot } = {}) {
  root = await realpath(root);
  const content = await optionalBytes(root, DEV_SOURCE_MARKER);
  if (!content) return { restored: false, reason: 'inactive' };
  const marker = JSON.parse(content.toString());
  if (marker.schemaVersion !== 1 || marker.mode !== 'dev-source' || marker.root !== root
    || !/^[a-f0-9-]{36}$/.test(marker.runId || '') || marker.runPath !== `.tmp/plugins-dev-source/${marker.runId}`
    || !Array.isArray(marker.files) || marker.files.length > 8192) fail('PLUGIN_DEV_MARKER_INVALID');
  const work = [], conflicts = [], seen = new Set();
  for (const item of marker.files) {
    outputPath(item.path);
    if (seen.has(item.path) || !isDigest(item.afterSha256) || item.beforeSha256 !== null && !isDigest(item.beforeSha256)
      || item.backup !== (item.beforeSha256 === null ? null : `${marker.runPath}/backup/${item.path}`)) fail('PLUGIN_DEV_MARKER_INVALID');
    seen.add(item.path);
    const current = await optionalBytes(root, item.path), digest = current === null ? null : hash(current);
    if (digest !== item.afterSha256 && digest !== item.beforeSha256) { conflicts.push(item.path); continue; }
    if (digest === item.beforeSha256) continue;
    const before = item.backup ? await readPluginOwnedFile(root, item.backup, 16 * 1024 * 1024) : null;
    if (before && hash(before) !== item.beforeSha256) fail('PLUGIN_DEV_BACKUP_INVALID');
    work.push({ ...item, before });
  }
  if (conflicts.length) fail('PLUGIN_DEV_RESTORE_CONFLICT', { paths: conflicts });
  for (const item of work) {
    const current = await optionalBytes(root, item.path);
    if ((current === null ? null : hash(current)) !== item.afterSha256) fail('PLUGIN_DEV_RESTORE_CONFLICT', { paths: [item.path] });
    if (item.before === null) await unlink(resolve(root, item.path));
    else await writePluginOwnedFile(root, item.path, item.before);
  }
  if (hash(await readPluginOwnedFile(root, DEV_SOURCE_MARKER)) !== hash(content)) fail('PLUGIN_DEV_RESTORE_CONFLICT', { paths: [DEV_SOURCE_MARKER] });
  await unlink(resolve(root, DEV_SOURCE_MARKER));
  return { restored: true, files: work.length, cachesRetained: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!['prepare', 'restore'].includes(command)) fail('PLUGIN_DEV_SOURCE_ARGUMENT_INVALID');
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!['--plugins-root', '--ids'].includes(args[index]) || !args[index + 1]) fail('PLUGIN_DEV_SOURCE_ARGUMENT_INVALID');
      if (args[index] === '--plugins-root') options.pluginsRoot = args[index + 1];
      else options.ids = args[index + 1].split(',');
    }
    console.log(JSON.stringify(command === 'prepare' ? await prepareDevSources(options) : await restoreDevSources()));
  } catch (error) {
    console.error(JSON.stringify({ error: /^PLUGIN_[A-Z_]+$/.test(error.code || '') ? error.code : 'PLUGIN_DEV_SOURCE_FAILED',
      ...(error.paths ? { paths: error.paths } : {}) })); process.exitCode = 1;
  }
}
