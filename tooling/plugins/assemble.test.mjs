import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { canonicalPluginManifest } from '../../shared/plugins/manifest.js';
import { createPluginHostBuild } from './host-identity.mjs';
import { assemblePluginDelivery, deliveryPlanDigest, readBoundedResponse, validateDeliverySnapshot, validatePluginArtifact,
  verifyDeliveryCheckout, ARTIFACT_MAX_BYTES } from './assemble.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const manifest = (id = 'test-extension', additions = {}) => ({ id, version: '1.0.0', hostApiVersion: 1, apiVersion: 1,
  name: 'Test extension', description: 'Synthetic extension', icon: 'puzzle', pages: [
    { id: 'settings', label: 'Settings', icon: 'settings', kind: 'settings', roles: ['admin', 'member'], scope: 'account' },
  ], entries: [], ...additions });
const packageArtifact = (plugin = manifest()) => ({ schemaVersion: 1, manifest: plugin,
  files: { 'client/index.js': "import { value } from '@flaretune/plugin-sdk'; export default function Page() { return value; }",
    'server/index.js': "export function createHandler() { return () => 'synthetic'; } export const migrations = [];" },
  entries: { client: 'client/index.js', server: 'server/index.js' } });

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = { 'package.json': JSON.stringify({ name: 'synthetic-host', version: '1.2.1', type: 'module' }),
    'package-lock.json': '{"lockfileVersion":3}',
    'tooling/plugins/sources.json': JSON.stringify({ hostFiles: ['host.js', 'client/src/plugins/sdk.js'] }),
    'host.js': 'export const host = true;\n', 'client/src/plugins/sdk.js': 'export const value = "synthetic SDK";\n' };
  for (const [path, value] of Object.entries(content)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), value); }
  const host = await createPluginHostBuild(root);
  const workspace = manifest('existing-workspace');
  const sources = Object.entries(content).map(([path, value]) => ({ path, sha256: sha(value) })).sort((a, b) => a.path.localeCompare(b.path));
  const lock = { schemaVersion: 1, host, plugins: [{ id: workspace.id, version: workspace.version, source: 'workspace',
    sourceDigest: sha(JSON.stringify(sources)), manifestDigest: sha(canonicalPluginManifest(workspace)), sources }] };
  await writeFile(resolve(root, 'plugins.lock.json'), JSON.stringify(lock));
  const artifact = packageArtifact(); const bytes = JSON.stringify(artifact);
  const plugins = [{ id: workspace.id, version: workspace.version, manifest: workspace,
    source: { type: 'workspace', id: 'workspace', sourceDigest: lock.plugins[0].sourceDigest } },
  { id: artifact.manifest.id, version: artifact.manifest.version, manifest: artifact.manifest,
    source: { type: 'artifact', id: 'third-party', url: 'https://plugins.example.net/test.json', sha256: sha(bytes) } }];
  const snapshot = { schemaVersion: 1, buildId: '895c1cb8-cea8-4f32-abf7-b324191005c8', host, plugins };
  snapshot.planDigest = deliveryPlanDigest(snapshot);
  return { root, host, lock, workspace, snapshot, artifact, bytes };
}

test('prepare verifies the exact checkout and creates loadable static modules without executing package code', async t => {
  const f = await fixture(t); const requests = [];
  const result = await assemblePluginDelivery({ root: f.root, snapshot: f.snapshot, fetchImpl: async (url, init) => {
    requests.push({ url, init }); return new Response(f.bytes);
  } });
  assert.equal(result.artifacts, 1);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.headers.Authorization, undefined, 'build API credentials never reach package publishers');
  const shared = await import(pathToFileURL(resolve(f.root, 'shared/plugins/delivery.generated.js')));
  assert.equal(shared.pluginDeployment.planDigest, f.snapshot.planDigest);
  assert.deepEqual(shared.deliveryPluginManifests, [f.artifact.manifest]);
  assert.equal(shared.pluginDeployment.plugins.length, 2, 'workspace and artifact target state are both recorded');
  const client = await import(pathToFileURL(resolve(f.root, 'client/src/plugins/delivery.generated.js')));
  assert.equal((await client.deliveryPluginBindings['test-extension'].loadContent()).default(), 'synthetic SDK');
  assert.equal(await client.deliveryPluginBindings['test-extension'].start({}), undefined);
  const server = await import(pathToFileURL(resolve(f.root, 'server/src/plugins/delivery.generated.js')));
  assert.equal(server.deliveryPluginModules['test-extension'].createHandler()(), 'synthetic');
  const inventory = JSON.parse(await readFile(resolve(f.root, 'tooling/plugins/delivery-source.generated.json'), 'utf8'));
  assert.equal(inventory.plugins['test-extension'].source, `artifact:third-party:${f.snapshot.plugins[1].source.sha256}`);
  assert.equal(inventory.plugins['test-extension'].files.length, 6, 'artifact and generated bindings are covered by the remote source lock');
  await assemblePluginDelivery({ root: f.root, snapshot: f.snapshot, fetchImpl: async () => new Response(f.bytes) });
  assert.equal((await readFile(resolve(f.root, 'plugins.lock.json'), 'utf8')), JSON.stringify(f.lock), 'prepare does not silently bless a new source lock');
});

test('artifact validation rejects traversal, cross-platform collisions and undeclared build-time reads', () => {
  const cases = [
    ['traversal', item => { item.files['client/../../outside.js'] = 'export {};'; }, 'PLUGIN_ARTIFACT_PATH_INVALID'],
    ['Windows drive', item => { item.files['C:/outside.js'] = 'export {};'; }, 'PLUGIN_ARTIFACT_PATH_INVALID'],
    ['Windows reserved name', item => { item.files['client/NUL.js'] = 'export {};'; }, 'PLUGIN_ARTIFACT_PATH_INVALID'],
    ['case collision', item => { item.files['client/INDEX.js'] = 'export {};'; }, 'PLUGIN_ARTIFACT_PATH_INVALID'],
    ['external import', item => { item.files['client/index.js'] = "import 'https://plugins.example.net/execute.js';"; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['host path import', item => { item.files['server/index.js'] = "import '../../../../server/dev/credentials.json';"; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['unavailable package', item => { item.files['client/index.js'] = "import 'unapproved-package';"; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['variable import', item => { item.files['client/index.js'] = 'export const load = path => import(path);'; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['CommonJS loader', item => { item.files['server/index.js'] = "const fs = require('fs');"; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['Vite URL asset read', item => { item.files['client/index.js'] = "const secret = new URL('../../../../.dev.vars', import.meta.url);"; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['CSS filesystem import', item => { item.files['client/style.css'] = '@import "../../../../private.css";'; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['CSS asset read', item => { item.files['client/style.css'] = 'a { background: url(../../../../.dev.vars); }'; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['shared cross-boundary import', item => { item.files['shared/helper.js'] = "import '../client/index.js';"; }, 'PLUGIN_ARTIFACT_IMPORT_INVALID'],
    ['invalid syntax', item => { item.files['client/index.js'] = 'export function ('; }, 'PLUGIN_ARTIFACT_SOURCE_INVALID'],
    ['npm package manifest', item => { item.files['package.json'] = '{"scripts":{"postinstall":"do not execute"}}'; }, 'PLUGIN_ARTIFACT_PATH_INVALID'],
    ['missing declared entry', item => { item.entries.client = 'client/absent.js'; }, 'PLUGIN_ARTIFACT_ENTRY_INVALID'],
  ];
  for (const [label, mutate, code] of cases) {
    const artifact = packageArtifact(); mutate(artifact);
    assert.throws(() => validatePluginArtifact(artifact, manifest()), { code }, label);
  }
});

test('artifact identity, file bounds, actual bytes and total stream bounds are enforced', async () => {
  const item = packageArtifact(); item.manifest.version = '2.0.0';
  assert.throws(() => validatePluginArtifact(item, manifest()), { code: 'PLUGIN_ARTIFACT_MANIFEST_MISMATCH' });
  const oversized = packageArtifact(); oversized.files['shared/large.json'] = ' '.repeat(512 * 1024 + 1);
  assert.throws(() => validatePluginArtifact(oversized, manifest()), { code: 'PLUGIN_ARTIFACT_SOURCE_INVALID' });
  await assert.rejects(readBoundedResponse(new Response('12345'), 4), { code: 'PLUGIN_DOWNLOAD_TOO_LARGE' });
  await assert.rejects(readBoundedResponse(new Response('tiny', { headers: { 'content-length': String(ARTIFACT_MAX_BYTES + 1) } }), ARTIFACT_MAX_BYTES), { code: 'PLUGIN_DOWNLOAD_TOO_LARGE' });
});

test('tampered package bytes fail before replacing an existing deployment receipt', async t => {
  const f = await fixture(t); const path = resolve(f.root, 'shared/plugins/delivery.generated.js');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'previous receipt\n');
  await assert.rejects(assemblePluginDelivery({ root: f.root, snapshot: f.snapshot, fetchImpl: async () => new Response('{}') }), { code: 'PLUGIN_ARTIFACT_DIGEST_MISMATCH' });
  assert.equal(await readFile(path, 'utf8'), 'previous receipt\n');
});

test('host mismatch, modified files and mismatched workspace code cannot be blessed by prepare', async t => {
  const f = await fixture(t);
  const mismatch = structuredClone(f.snapshot); mismatch.host.sourceDigest = sha('another host');
  await assert.rejects(verifyDeliveryCheckout(f.root, mismatch), { code: 'PLUGIN_HOST_BUILD_MISMATCH' });
  const changed = structuredClone(f.snapshot); changed.plugins[0].source.sourceDigest = sha('other workspace code');
  await assert.rejects(verifyDeliveryCheckout(f.root, changed), { code: 'PLUGIN_WORKSPACE_BUILD_MISMATCH' });
  await writeFile(resolve(f.root, 'client/src/plugins/sdk.js'), 'export const value = "changed host SDK";');
  await assert.rejects(verifyDeliveryCheckout(f.root, f.snapshot), { code: 'PLUGIN_HOST_BUILD_MISMATCH' });
});

test('snapshot locks manifest, dependencies and complete plan digest', async t => {
  const f = await fixture(t);
  const changed = structuredClone(f.snapshot); changed.plugins[1].manifest.description = 'changed';
  assert.throws(() => validateDeliverySnapshot(changed), { code: 'PLUGIN_PLAN_DIGEST_MISMATCH' });
  const dependency = structuredClone(f.snapshot); dependency.plugins[1].manifest.dependencies = { absent: { apiVersion: 1 } };
  dependency.planDigest = deliveryPlanDigest(dependency);
  assert.throws(() => validateDeliverySnapshot(dependency), { code: 'PLUGIN_PLAN_INCOMPATIBLE' });
  const privateSource = structuredClone(f.snapshot); privateSource.plugins[1].source.url = 'https://127.0.0.1/plugin.json';
  assert.throws(() => validateDeliverySnapshot(privateSource), { code: 'PLUGIN_URL_INVALID' });
  const reverse = structuredClone(f.snapshot); reverse.plugins.reverse();
  assert.equal(deliveryPlanDigest(reverse), f.snapshot.planDigest, 'stable plugin ordering is shared with the Worker');
});

test('artifact code stays unevaluated during assembly and local packages cannot redirect output using links', async t => {
  const f = await fixture(t);
  const artifact = packageArtifact(); artifact.files['client/index.js'] = 'throw new Error("must not run while preparing"); export default function Page() {}';
  const bytes = JSON.stringify(artifact); f.snapshot.plugins[1].source.sha256 = sha(bytes); f.snapshot.planDigest = deliveryPlanDigest(f.snapshot);
  await assemblePluginDelivery({ root: f.root, snapshot: f.snapshot, fetchImpl: async () => new Response(bytes) });
  assert.ok((await readFile(resolve(f.root, 'shared/plugins/delivery.generated.js'), 'utf8')).includes(f.snapshot.planDigest));
  const other = await fixture(t); const outside = await mkdtemp(resolve(tmpdir(), 'flaretune-delivery-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(resolve(other.root, 'shared/plugins'), { recursive: true });
  try { await symlink(outside, resolve(other.root, 'shared/plugins/.delivery'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Junction creation unavailable; path and collision checks still ran.'); return; } throw error; }
  await assert.rejects(assemblePluginDelivery({ root: other.root, snapshot: other.snapshot, fetchImpl: async () => new Response(other.bytes) }), { code: 'PLUGIN_OUTPUT_PATH_INVALID' });
});

test('two remote packages produce real client/server bundles while adding and removing them preserves the workspace host identity', async t => {
  const f = await fixture(t);
  const second = packageArtifact(manifest('second-extension'));
  delete second.files['client/index.js'];
  second.files['client/index.jsx'] = "import React from 'react'; export default function Page() { return <div>second synthetic page</div>; }";
  second.entries.client = 'client/index.jsx';
  const secondBytes = JSON.stringify(second);
  f.snapshot.plugins.push({ id: second.manifest.id, version: second.manifest.version, manifest: second.manifest,
    source: { type: 'artifact', id: 'third-party', url: 'https://plugins.example.net/second.json', sha256: sha(secondBytes) } });
  f.snapshot.planDigest = deliveryPlanDigest(f.snapshot);
  await assemblePluginDelivery({ root: f.root, snapshot: f.snapshot, fetchImpl: async url => new Response(url.endsWith('/second.json') ? secondBytes : f.bytes) });
  assert.deepEqual(await createPluginHostBuild(f.root), f.host);
  for (const kind of ['client', 'server']) {
    const result = await build({ entryPoints: [resolve(f.root, `${kind}/src/plugins/delivery.generated.js`)], bundle: true,
      write: false, platform: kind === 'client' ? 'browser' : 'neutral', format: 'esm', external: ['react'], logLevel: 'silent' });
    assert.equal(result.errors.length, 0);
    assert.ok(result.outputFiles[0].text.includes(kind === 'client' ? 'second synthetic page' : 'createHandler'));
  }
  const inventory = JSON.parse(await readFile(resolve(f.root, 'tooling/plugins/delivery-source.generated.json'), 'utf8'));
  assert.deepEqual(Object.keys(inventory.plugins).sort(), ['second-extension', 'test-extension']);
  assert.ok(Object.values(inventory.plugins).every(row => row.files.includes('client/src/plugins/delivery.generated.js')));
  f.snapshot.plugins = f.snapshot.plugins.filter(row => row.source.type === 'workspace');
  f.snapshot.planDigest = deliveryPlanDigest(f.snapshot);
  await assemblePluginDelivery({ root: f.root, snapshot: f.snapshot, fetchImpl: async () => { throw new Error('No artifact fetch should occur after removal'); } });
  assert.deepEqual(await createPluginHostBuild(f.root), f.host);
  assert.equal(JSON.parse(await readFile(resolve(f.root, 'plugins.lock.json'), 'utf8')).plugins[0].sourceDigest, f.lock.plugins[0].sourceDigest);
  assert.deepEqual(JSON.parse(await readFile(resolve(f.root, 'tooling/plugins/delivery-source.generated.json'), 'utf8')).plugins, {});
  assert.equal((await import(`${pathToFileURL(resolve(f.root, 'client/src/plugins/delivery.generated.js'))}?empty`)).deliveryPluginBindings['test-extension'], undefined);
});
