import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createPluginHostBuild } from '../plugins/host-identity.mjs';
import { generateSystemUpdateRuntime, prepareSystemUpdateRuntime } from './system-update-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flaretune-update-runtime-'));
  t.after(async () => { assert(root.startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  await mkdir(resolve(root, 'shared/plugins'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.3.0' }));
  await writeFile(resolve(root, 'shared/plugins/delivery.generated.js'), 'export const pluginDeployment=null; export const deliveryPluginManifests=[]; export const compiledPluginSources={};');
  const host = await createPluginHostBuild(root);
  return { root, plan: { target: { commit: 'a'.repeat(40), host }, plugins: [] } };
}
const generated = async root => (await import(pathToFileURL(resolve(root, 'shared/systemUpdate.generated.js')).href)).systemUpdateRuntime;
function packageEntry() {
  const manifest = { id: 'test-plugin', name: 'Test', description: 'Test package', icon: 'puzzle', version: '1.0.0', hostApiVersion: 1, apiVersion: 1, pages: [], entries: [] };
  const artifact = { schemaVersion: 1, manifest, entries: { server: 'server/index.js' }, files: { 'server/index.js': 'export const value = 42;\n' } };
  const bytes = Buffer.from(JSON.stringify(artifact));
  const entry = { id: manifest.id, version: manifest.version, manifest,
    source: { type: 'artifact', id: 'custom-source', url: 'https://plugins.example.com/fixed.json', sha256: createHash('sha256').update(bytes).digest('hex') } };
  return { entry, bytes };
}
test('runtime identifies actual server sources and exact compiled packages without credentials', async t => {
  const { root, plan } = await fixture(t);
  await generateSystemUpdateRuntime({ root, commit: plan.target.commit });
  const runtime = await generated(root);
  assert.equal(runtime.version, '1.3.0'); assert.equal(runtime.commit, 'a'.repeat(40)); assert.deepEqual(runtime.plugins, []);
  assert.deepEqual(await createPluginHostBuild(root), plan.target.host, 'generated metadata must not create a digest cycle');
  await assert.rejects(generateSystemUpdateRuntime({ root, commit: 'main' }), { code: 'SYSTEM_UPDATE_COMMIT_INVALID' });
});
test('empty installation remains empty during system update instead of activating seed defaults', async t => {
  const { root, plan } = await fixture(t);
  await prepareSystemUpdateRuntime({ root, plan });
  assert.deepEqual((await generated(root)).plugins, []);
  const delivery = await import(pathToFileURL(resolve(root, 'shared/plugins/delivery.generated.js')).href);
  assert.equal(delivery.pluginDeployment, null); assert.deepEqual(delivery.compiledPluginSources, {});
});
test('host mismatch rejects before a plugin download or generated selection change', async t => {
  const { root, plan } = await fixture(t); plan.target.host.sourceDigest = 'f'.repeat(64);
  await assert.rejects(prepareSystemUpdateRuntime({ root, plan, fetchImpl: async () => assert.fail('unexpected download') }), { code: 'SYSTEM_UPDATE_HOST_MISMATCH' });
  assert.match(await readFile(resolve(root, 'shared/plugins/delivery.generated.js'), 'utf8'), /deliveryPluginManifests=\[\]/);
});
test('immutable plugin bytes and source identity survive actual materialization', async t => {
  const { root, plan } = await fixture(t); const { entry, bytes } = packageEntry(); plan.plugins = [entry];
  await prepareSystemUpdateRuntime({ root, plan, fetchImpl: async (url, options) => {
    assert.equal(url, entry.source.url); assert.equal(options.redirect, 'error'); return new Response(bytes);
  } });
  const runtime = await generated(root);
  assert.deepEqual(runtime.plugins.map(({ id, version, source }) => ({ id, version, source })), [{ id: entry.id, version: entry.version, source: entry.source }]);
  const module = await import(pathToFileURL(resolve(root, 'server/src/plugins/delivery.generated.js')).href);
  assert.equal(module.deliveryPluginModules['test-plugin'].value, 42);
});
test('tampered bytes and target-host incompatible packages never replace the compiled selection', async t => {
  const { root, plan } = await fixture(t); const { entry } = packageEntry(); plan.plugins = [entry];
  await assert.rejects(prepareSystemUpdateRuntime({ root, plan, fetchImpl: async () => new Response('{}') }), { code: 'SYSTEM_UPDATE_PLUGIN_DIGEST_MISMATCH' });
  entry.manifest.hostApiVersion = 999;
  await assert.rejects(prepareSystemUpdateRuntime({ root, plan, fetchImpl: async () => assert.fail('must preflight compatibility') }), { code: 'SYSTEM_UPDATE_PLUGIN_INCOMPATIBLE' });
});
