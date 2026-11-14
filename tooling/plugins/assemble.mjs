import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath, rename } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, posix } from 'node:path';
import { parse } from '@babel/parser';
import { canonicalPluginManifest, resolvePluginAvailability, validatePluginManifests } from '../../shared/plugins/manifest.js';
import { canonicalPluginPlan, validatePublicHttpsUrl } from '../../shared/plugins/delivery.js';
import { createPluginHostBuild } from './host-identity.mjs';
import { pluginSdkImports, pluginModuleSide, allowsPluginImport, declaredPluginService } from '../../shared/plugins/sdkImports.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const ownKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
export const ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

export function publicHttpsUrl(value) {
  return validatePublicHttpsUrl(value);
}

export function deliveryPlanDigest({ host, plugins }) {
  return sha256(canonicalPluginPlan({ host, plugins }));
}

export function validateDeliveryPlan(snapshot) {
  if (!plain(snapshot) || !plain(snapshot.host) || !ownKeys(snapshot.host, ['version', 'sourceDigest'])
    || !/^\d+\.\d+\.\d+$/.test(snapshot.host.version) || !digest(snapshot.host.sourceDigest)
    || !Array.isArray(snapshot.plugins) || snapshot.plugins.length > 32) fail('PLUGIN_SNAPSHOT_INVALID');
  const ids = new Set();
  for (const entry of snapshot.plugins) {
    if (!plain(entry) || !ownKeys(entry, ['id', 'version', 'manifest', 'source']) || !identifier(entry.id)
      || ids.has(entry.id) || entry.version !== entry.manifest?.version || entry.id !== entry.manifest?.id
      || !plain(entry.source) || !identifier(entry.source.id)) fail('PLUGIN_SNAPSHOT_INVALID');
    ids.add(entry.id);
    if (entry.source.type === 'workspace') {
      if (entry.source.id !== 'workspace' || !digest(entry.source.sourceDigest)
        || !ownKeys(entry.source, ['type', 'id', 'sourceDigest'])) fail('PLUGIN_SNAPSHOT_INVALID');
    } else if (entry.source.type === 'artifact') {
      if (!digest(entry.source.sha256) || !ownKeys(entry.source, ['type', 'id', 'url', 'sha256'])) fail('PLUGIN_SNAPSHOT_INVALID');
      publicHttpsUrl(entry.source.url);
    } else fail('PLUGIN_SNAPSHOT_INVALID');
  }
  const manifests = validatePluginManifests(snapshot.plugins.map(entry => entry.manifest));
  for (const entry of snapshot.plugins) if (!resolvePluginAvailability(manifests, [...ids], entry.id).available) fail('PLUGIN_PLAN_INCOMPATIBLE');
  return snapshot;
}

export function validateDeliverySnapshot(snapshot) {
  if (!plain(snapshot) || snapshot.schemaVersion !== 1 || typeof snapshot.buildId !== 'string'
    || !/^[a-f0-9-]{36}$/.test(snapshot.buildId) || !digest(snapshot.planDigest)) fail('PLUGIN_SNAPSHOT_INVALID');
  validateDeliveryPlan(snapshot);
  if (deliveryPlanDigest(snapshot) !== snapshot.planDigest) fail('PLUGIN_PLAN_DIGEST_MISMATCH');
  return snapshot;
}

function safeFilePath(path, binary = false) {
  if (typeof path !== 'string' || path.length > 220 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(path)
    || !(binary ? path.startsWith('server/') && path.endsWith('.wasm') : /\.(?:js|mjs|jsx|json|css)$/.test(path))
    || path.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.endsWith('.')
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))
    || !/^(?:client|server|shared)\//.test(path)) fail('PLUGIN_ARTIFACT_PATH_INVALID');
  return path;
}

function moduleTarget(path, specifier, files, { schemaVersion = 1, manifest } = {}) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    if (['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', '@flaretune/plugin-sdk'].includes(specifier)
      && path.startsWith('client/')) return specifier;
    if (schemaVersion === 2) {
      const sdk = pluginSdkImports[specifier];
      if (sdk && allowsPluginImport(pluginModuleSide(path), sdk.side)) return specifier;
      const service = declaredPluginService(specifier, manifest);
      if (service && allowsPluginImport(pluginModuleSide(path), service.side)) return specifier;
    }
    fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
  }
  if (specifier.includes('\\') || /[?#\0]/.test(specifier)) fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  if (target.startsWith('../') || target.startsWith('/')
    || (path.startsWith('client/') && target.startsWith('server/'))
    || (path.startsWith('server/') && target.startsWith('client/'))
    || (path.startsWith('shared/') && !target.startsWith('shared/'))) fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
  const found = [target, `${target}.js`, `${target}.mjs`, `${target}.jsx`, `${target}.json`, `${target}/index.js`, `${target}/index.jsx`]
    .find(candidate => Object.hasOwn(files, candidate));
  if (!found) fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
  return found;
}

function importLiterals(path, code, files, contract = {}) {
  const literals = [];
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx'], createImportExpressions: true }); }
  catch { fail('PLUGIN_ARTIFACT_SOURCE_INVALID'); }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      node.source.requestedNames = (node.specifiers || []).map(specifier => specifier.type === 'ImportDefaultSpecifier' ? 'default'
        : specifier.type === 'ImportSpecifier' ? specifier.imported?.name || specifier.imported?.value
        : specifier.type === 'ExportSpecifier' ? specifier.local?.name || specifier.local?.value : null).filter(Boolean);
      literals.push(node.source);
    }
    if (node.type === 'ImportExpression') {
      if (node.source?.type !== 'StringLiteral') fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
      literals.push(node.source);
    }
    // Vite rewrites new URL(..., import.meta.url) into build-time file reads.
    // The package import graph is the only supported way to include local files.
    if (node.type === 'MetaProperty' && node.meta?.name === 'import') fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
    // Packages are ESM sources. CommonJS loaders cannot bypass the import graph.
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
    for (const [key, value] of Object.entries(node)) if (!['loc', 'start', 'end', 'extra'].includes(key)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  for (const literal of literals) moduleTarget(path, literal.value, files, contract);
  return literals;
}

export function validatePluginArtifact(artifact, expectedManifest) {
  if (!plain(artifact) || ![1,2].includes(artifact.schemaVersion)
    || !ownKeys(artifact, artifact.schemaVersion === 2 ? ['schemaVersion', 'manifest', 'files', 'entries', 'exports', 'assets'] : ['schemaVersion', 'manifest', 'files', 'entries'])
    || !plain(artifact.files) || !plain(artifact.entries) || !ownKeys(artifact.entries, ['client', 'server'])
    || Object.keys(artifact.entries).length === 0 || Object.keys(artifact.files).length === 0
    || Object.keys(artifact.files).length > 256
    || artifact.schemaVersion === 2 && (!plain(artifact.exports) || !plain(artifact.assets))) fail('PLUGIN_ARTIFACT_INVALID');
  validatePluginManifests([artifact.manifest]);
  if (artifact.schemaVersion === 2 && artifact.manifest.hostApiVersion < 2) fail('PLUGIN_ARTIFACT_HOST_API_MISMATCH');
  if (canonicalPluginManifest(artifact.manifest) !== canonicalPluginManifest(expectedManifest)) fail('PLUGIN_ARTIFACT_MANIFEST_MISMATCH');
  let bytes = 0; const paths = new Set();
  const assets = artifact.assets || {};
  if (Object.keys(assets).length + Object.keys(artifact.files).length > 256) fail('PLUGIN_ARTIFACT_INVALID');
  const allFiles = { ...artifact.files, ...assets };
  for (const [path, asset] of Object.entries(assets)) {
    safeFilePath(path, true);
    if (paths.has(path.toLowerCase())) fail('PLUGIN_ARTIFACT_PATH_INVALID');
    paths.add(path.toLowerCase());
    if (!plain(asset) || !ownKeys(asset, ['encoding','data','size','sha256']) || asset.encoding !== 'base64'
      || !Number.isInteger(asset.size) || asset.size < 1 || asset.size > 2 * 1024 * 1024 || !digest(asset.sha256)
      || typeof asset.data !== 'string' || asset.data.length > Math.ceil(2 * 1024 * 1024 / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) fail('PLUGIN_ARTIFACT_ASSET_INVALID');
    const decoded = Buffer.from(asset.data, 'base64');
    if (decoded.length !== asset.size || decoded.toString('base64') !== asset.data || sha256(decoded) !== asset.sha256) fail('PLUGIN_ARTIFACT_ASSET_INVALID');
    bytes += decoded.length;
  }
  for (const [path, source] of Object.entries(artifact.files)) {
    safeFilePath(path);
    if (paths.has(path.toLowerCase())) fail('PLUGIN_ARTIFACT_PATH_INVALID');
    paths.add(path.toLowerCase());
    if (typeof source !== 'string' || source.includes('\0') || Buffer.byteLength(source) > (artifact.schemaVersion === 2 ? 2 * 1024 * 1024 : 512 * 1024)) fail('PLUGIN_ARTIFACT_SOURCE_INVALID');
    bytes += Buffer.byteLength(source);
    if (bytes > ARTIFACT_MAX_BYTES) fail('PLUGIN_ARTIFACT_TOO_LARGE');
    if (/\.(?:js|mjs|jsx)$/.test(path)) importLiterals(path, source, allFiles, artifact);
    if (/\.css$/.test(path) && /\\|@import\b|\burl\s*\(|\b(?:-webkit-)?image-set\s*\(/i.test(source)) fail('PLUGIN_ARTIFACT_IMPORT_INVALID');
    if (/\.json$/.test(path)) { try { JSON.parse(source); } catch { fail('PLUGIN_ARTIFACT_SOURCE_INVALID'); } }
  }
  if (artifact.schemaVersion === 2) {
    if (Object.keys(artifact.exports).length > 256) fail('PLUGIN_ARTIFACT_EXPORT_INVALID');
    const publicKeys = new Set();
    for (const [key, path] of Object.entries(artifact.exports)) {
      safeFilePath(key);
      if (publicKeys.has(key.toLowerCase()) || typeof path !== 'string' || !Object.hasOwn(artifact.files, path)
        || !allowsPluginImport(pluginModuleSide(key), pluginModuleSide(path))) fail('PLUGIN_ARTIFACT_EXPORT_INVALID');
      publicKeys.add(key.toLowerCase());
    }
  }
  for (const [kind, path] of Object.entries(artifact.entries)) {
    if (typeof path !== 'string' || !path.startsWith(`${kind}/`) || !/\.(?:js|mjs|jsx)$/.test(path)
      || !Object.hasOwn(artifact.files, path)) fail('PLUGIN_ARTIFACT_ENTRY_INVALID');
  }
  if ((expectedManifest.pages.length || expectedManifest.entries.length) && !artifact.entries.client) fail('PLUGIN_ARTIFACT_ENTRY_INVALID');
  return artifact;
}

export async function readBoundedResponse(response, limit, code = 'PLUGIN_DOWNLOAD_FAILED') {
  if (!response.ok || !response.body) fail(code);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { await response.body.cancel(); fail('PLUGIN_DOWNLOAD_TOO_LARGE'); }
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) fail('PLUGIN_DOWNLOAD_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

const inside = (root, path) => {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('PLUGIN_OUTPUT_PATH_INVALID');
  return path;
};
async function assertNoSymlinks(root, path) {
  inside(root, path);
  let next = path;
  while (next !== root) {
    try { if ((await lstat(next)).isSymbolicLink()) fail('PLUGIN_OUTPUT_PATH_INVALID'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(next);
    if (parent === next) fail('PLUGIN_OUTPUT_PATH_INVALID');
    next = parent;
  }
}
export async function writePluginOwnedFile(root, rel, data, immutable = false) {
  root = await realpath(root);
  const path = inside(root, resolve(root, rel));
  await assertNoSymlinks(root, path);
  await mkdir(dirname(path), { recursive: true });
  if (immutable) {
    try {
      const existing = await readFile(path);
      if (!existing.equals(Buffer.isBuffer(data) ? data : Buffer.from(data))) fail('PLUGIN_ARTIFACT_CACHE_MISMATCH');
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(path, data, { flag: 'wx' });
  } else {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, path);
  }
}
const writeOwned = writePluginOwnedFile;

export async function readPluginOwnedFile(root, rel, limit = ARTIFACT_MAX_BYTES) {
  root = await realpath(root);
  const path = inside(root, resolve(root, rel));
  await assertNoSymlinks(root, path);
  if ((await lstat(path)).size > limit) fail('PLUGIN_DOWNLOAD_TOO_LARGE');
  return readFile(path);
}

export async function verifyDeliveryCheckout(root, snapshot) {
  const directory = await realpath(root);
  const lock = JSON.parse(await readFile(resolve(directory, 'plugins.lock.json'), 'utf8'));
  if (!plain(lock.host) || canonicalPluginManifest(lock.host) !== canonicalPluginManifest(snapshot.host)) fail('PLUGIN_HOST_BUILD_MISMATCH');
  const version = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).version;
  if (version !== snapshot.host.version) fail('PLUGIN_HOST_BUILD_MISMATCH');
  const actualHost = await createPluginHostBuild(directory);
  if (canonicalPluginManifest(actualHost) !== canonicalPluginManifest(snapshot.host)) fail('PLUGIN_HOST_BUILD_MISMATCH');
  for (const entry of lock.plugins || []) {
    if (!Array.isArray(entry.sources) || !digest(entry.sourceDigest) || sha256(JSON.stringify(entry.sources)) !== entry.sourceDigest) fail('PLUGIN_CHECKOUT_MISMATCH');
    for (const source of entry.sources) {
      if (typeof source.path !== 'string' || source.path.includes('\\')) fail('PLUGIN_CHECKOUT_MISMATCH');
      const path = inside(directory, resolve(directory, source.path));
      await assertNoSymlinks(directory, path);
      if (sha256(await readFile(path)) !== source.sha256) fail('PLUGIN_CHECKOUT_MISMATCH');
    }
  }
  for (const entry of snapshot.plugins.filter(plugin => plugin.source.type === 'workspace')) {
    const locked = lock.plugins.find(plugin => plugin.id === entry.id);
    if (!locked || locked.version !== entry.version || locked.source !== 'workspace' || locked.sourceDigest !== entry.source.sourceDigest
      || locked.manifestDigest !== sha256(canonicalPluginManifest(entry.manifest))) fail('PLUGIN_WORKSPACE_BUILD_MISMATCH');
  }
  return directory;
}

const importPath = (from, to) => {
  let path = relative(dirname(from), to).replaceAll('\\', '/');
  if (!path.startsWith('.')) path = `./${path}`;
  return path;
};
function sdkImports(root, path, code, artifact) {
  const imports = importLiterals(path, code, { ...artifact.files, ...artifact.assets }, artifact)
    .filter(literal => Object.hasOwn(pluginSdkImports, literal.value) || declaredPluginService(literal.value, artifact.manifest));
  let result = code;
  for (const literal of imports.sort((a, b) => b.start - a.start)) {
    const service = declaredPluginService(literal.value, artifact.manifest);
    const target = service ? `shared/plugins/.api/${service.providerId}/${service.publicKey}` : pluginSdkImports[literal.value].target;
    const sdk = importPath(resolve(root, 'shared/plugins/.delivery', '__ID__', '__DIGEST__', path), resolve(root, target));
    result = result.slice(0, literal.start) + JSON.stringify(sdk) + result.slice(literal.end);
  }
  return result;
}

function exportedNames(artifact, path, visited = new Set()) {
  if (visited.has(path)) return [];
  visited.add(path);
  if (path.endsWith('.json')) return ['default'];
  if (!/\.(?:js|mjs|jsx)$/.test(path)) return [];
  const names = new Set();
  const ast = parse(artifact.files[path], { sourceType:'module', plugins:['jsx'] });
  for (const node of ast.program.body) {
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration?.id?.name) names.add(node.declaration.id.name);
      for (const declaration of node.declaration?.declarations || []) if (declaration.id?.name) names.add(declaration.id.name);
      for (const specifier of node.specifiers || []) if (specifier.exported?.name || specifier.exported?.value) names.add(specifier.exported.name || specifier.exported.value);
    }
    if (node.type === 'ExportAllDeclaration' && node.source.value.startsWith('.')) {
      const target = moduleTarget(path,node.source.value,{...artifact.files,...artifact.assets},artifact);
      for (const name of exportedNames(artifact,target,visited)) if (name !== 'default') names.add(name);
    }
  }
  return [...names];
}

function unavailableModule(exports = []) {
  const code = ["const unavailable = () => { const error = new Error('PLUGIN_NOT_COMPILED'); error.code = 'PLUGIN_NOT_COMPILED'; throw error; };\n"];
  for (const item of exports) {
    const name = typeof item === 'string' ? item : item.name;
    if (name === 'default') { code.push('export default unavailable;\n'); continue; }
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name || '')) fail('PLUGIN_BRIDGE_INVALID');
    const kind = typeof item === 'string' ? 'function' : item.kind;
    if (kind === 'class') code.push(`export class ${name} extends Error { constructor() { super('PLUGIN_NOT_COMPILED'); this.code='PLUGIN_NOT_COMPILED'; } }\n`);
    else if (kind === 'value') code.push(`export const ${name} = ${item.fallback === undefined ? 'undefined' : JSON.stringify(item.fallback)};\n`);
    else code.push(`export const ${name} = unavailable;\n`);
  }
  return code.join('');
}

async function materializePublicBridges(root, artifacts) {
  let compatibility = {};
  try { compatibility = JSON.parse(await readFile(resolve(root,'tooling/plugins/compatibility.json'),'utf8')); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }
  const selected = new Map(artifacts.map(item=>[item.entry.id,item]));
  const bridges = new Map();
  const add = (id,key,exportList,kind) => {
    if (!identifier(id)) fail('PLUGIN_BRIDGE_INVALID'); safeFilePath(key);
    const rel = `shared/plugins/${kind}/${id}/${key}`;
    const current = bridges.get(rel) || { id,key,rel,exports:new Map() };
    for (const item of exportList || []) current.exports.set(typeof item === 'string' ? item : item.name,item);
    bridges.set(rel,current);
  };
  for (const record of Object.values(compatibility)) add(record.pluginId,record.publicKey,record.exports,'.bridges');
  for (const {artifact} of artifacts) for (const [path,code] of Object.entries(artifact.files)) if (/\.(?:js|mjs|jsx)$/.test(path)) {
    for (const literal of importLiterals(path,code,{...artifact.files,...artifact.assets},artifact)) {
      const service = declaredPluginService(literal.value,artifact.manifest);
      if(service) add(service.providerId,service.publicKey,literal.requestedNames,'.api');
    }
  }
  for (const bridge of bridges.values()) {
    const provider = selected.get(bridge.id);
    const target = provider?.artifact.exports?.[bridge.key];
    let code;
    if (provider && !target) fail('PLUGIN_ARTIFACT_EXPORT_MISSING');
    if (target) {
      const packagePath = resolve(root,'shared/plugins/.delivery',bridge.id,provider.entry.source.sha256,target);
      const specifier = importPath(resolve(root,bridge.rel),packagePath);
      code = bridge.key.endsWith('.css') ? `@import ${JSON.stringify(specifier)};\n`
        : `export * from ${JSON.stringify(specifier)};\n${exportedNames(provider.artifact,target).includes('default') ? `export { default } from ${JSON.stringify(specifier)};\n` : ''}`;
    } else code = bridge.key.endsWith('.css') ? '/* Plugin not compiled. */\n' : unavailableModule([...bridge.exports.values()]);
    await writeOwned(root,bridge.rel,code);
  }
  return [...bridges.keys()].sort();
}

export async function assemblePluginDelivery({ root, snapshot, fetchImpl = fetch, signal } = {}) {
  validateDeliverySnapshot(snapshot);
  root = await verifyDeliveryCheckout(root, snapshot);
  const artifacts = [];
  let total = 0;
  for (const entry of snapshot.plugins.filter(plugin => plugin.source.type === 'artifact')) {
    const url = publicHttpsUrl(entry.source.url);
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: signal || AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
    const bytes = await readBoundedResponse(response, ARTIFACT_MAX_BYTES);
    total += bytes.length;
    if (total > 32 * 1024 * 1024) fail('PLUGIN_PLAN_TOO_LARGE');
    if (sha256(bytes) !== entry.source.sha256) fail('PLUGIN_ARTIFACT_DIGEST_MISMATCH');
    let artifact;
    try { artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('PLUGIN_ARTIFACT_INVALID'); }
    validatePluginArtifact(artifact, entry.manifest);
    artifacts.push({ entry, artifact });
  }
  const pluginDeployment = { buildId: snapshot.buildId, planDigest: snapshot.planDigest, host: snapshot.host,
    plugins: snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })) };
  return materializePluginArtifacts({ root, artifacts, pluginDeployment });
}

// Used by both a real immutable delivery plan and a distinct, honest bootstrap.
// Bootstrap has no build ID and does not claim an installation activation.
export async function hydratePluginArtifactCache({ root, artifacts }) {
  root = await realpath(root);
  for (const { entry, artifact } of artifacts) {
    if (!identifier(entry?.id) || !digest(entry.source?.sha256) || entry.id !== artifact.manifest?.id) fail('PLUGIN_ARTIFACT_INVALID');
    validatePluginArtifact(artifact, entry.manifest);
  }
  const files = {};
  for (const { entry, artifact } of artifacts) {
    const base = `shared/plugins/.delivery/${entry.id}/${entry.source.sha256}`;
    const paths = [];
    for (const [path, source] of Object.entries(artifact.files).sort(([a], [b]) => a.localeCompare(b))) {
      const transformed = /\.(?:js|mjs|jsx)$/.test(path) ? sdkImports(root, path, source, artifact) : source;
      const target = `${base}/${path}`;
      await writeOwned(root, target, transformed, true);
      paths.push(target);
    }
    for (const [path, asset] of Object.entries(artifact.assets || {}).sort(([a],[b])=>a.localeCompare(b))) {
      const target = `${base}/${path}`;
      await writeOwned(root, target, Buffer.from(asset.data, 'base64'), true);
      paths.push(target);
    }
    files[entry.id] = paths;
  }
  return files;
}

export async function materializePluginArtifacts({ root, artifacts, pluginDeployment = null }) {
  root = await realpath(root);
  const files = await hydratePluginArtifactCache({ root, artifacts });
  const bridgePaths = await materializePublicBridges(root, artifacts);
  const inventory = { schemaVersion: 1, plugins: {} };
  const client = []; const serverImports = []; const server = [];
  for (const [index, { entry, artifact }] of artifacts.entries()) {
    const base = `shared/plugins/.delivery/${entry.id}/${entry.source.sha256}`;
    const paths = files[entry.id];
    inventory.plugins[entry.id] = { source: `artifact:${entry.source.id}:${entry.source.sha256}`, files: [...paths,
      'client/src/plugins/delivery.generated.js', 'server/src/plugins/delivery.generated.js',
      'shared/plugins/delivery.generated.js', 'tooling/plugins/delivery-source.generated.json', ...bridgePaths] };
    if (artifact.entries.client) {
      const path = importPath(resolve(root, 'client/src/plugins/delivery.generated.js'), resolve(root, base, artifact.entries.client));
      const load = `import(${JSON.stringify(path)})`;
      const actions = [...new Set(entry.manifest.entries.filter(item => item.action).map(item => item.action))];
      client.push(`  ${JSON.stringify(entry.id)}: Object.freeze({ loadContent: () => ${load}, start: async host => (await ${load}).start?.(host), loadAction: async () => { const module = await ${load}; return typeof module.loadAction === 'function' ? module.loadAction() : module; }, actions: Object.freeze(${JSON.stringify(actions)}) })`);
    }
    if (artifact.entries.server) {
      const path = importPath(resolve(root, 'server/src/plugins/delivery.generated.js'), resolve(root, base, artifact.entries.server));
      serverImports.push(`import * as plugin${index} from ${JSON.stringify(path)};`);
      server.push(`  ${JSON.stringify(entry.id)}: plugin${index}`);
    }
  }
  const prefix = '// Generated by plugins:prepare. No site credentials belong in this module.\n';
  await writeOwned(root, 'client/src/plugins/delivery.generated.js', prefix + `export const deliveryPluginBindings = Object.freeze({\n${client.join(',\n')}\n});\n`);
  await writeOwned(root, 'server/src/plugins/delivery.generated.js', prefix + serverImports.join('\n') + `\nexport const deliveryPluginModules = Object.freeze({\n${server.join(',\n')}\n});\n`);
  const data = value => `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
  const compiledSources = Object.fromEntries(artifacts.map(({entry})=>[entry.id,entry.source]));
  await writeOwned(root, 'shared/plugins/delivery.generated.js', prefix + `export const pluginDeployment = Object.freeze(${data(pluginDeployment)});\nexport const deliveryPluginManifests = Object.freeze(${data(artifacts.map(({ entry }) => entry.manifest))});\nexport const compiledPluginSources = Object.freeze(${data(compiledSources)});\n`);
  await writeOwned(root, 'tooling/plugins/delivery-source.generated.json', `${JSON.stringify(inventory, null, 2)}\n`);
  return { ...(pluginDeployment ? {buildId:pluginDeployment.buildId,planDigest:pluginDeployment.planDigest}:{}), artifacts: artifacts.length, pluginDeployment };
}
