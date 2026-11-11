import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { materializePluginArtifacts } from './assemble.mjs';
import { prepareDevSources, restoreDevSources, assertNoDevSourceOverride, DEV_SOURCE_MARKER } from './dev-source.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const artifactFor = (id, revision) => ({ schemaVersion: 2, manifest: {
  id, version: '0.1.0', hostApiVersion: 2, apiVersion: 1, name: id, description: 'Synthetic plugin',
  icon: 'puzzle', pages: [], entries: [], dataVersion: 0,
}, entries: { server: 'server/index.js' }, exports: { 'server/index.js': 'server/index.js' }, assets: {},
files: { 'server/index.js': `export function createHandler() { return ${JSON.stringify(revision)}; }` } });

function packaged(id, revision) {
  const artifact = artifactFor(id, revision), bytes = Buffer.from(JSON.stringify(artifact) + '\n'), digest = hash(bytes);
  return { artifact, bytes, digest, entry: { id, version: '0.1.0', manifest: artifact.manifest,
    source: { type: 'artifact', id: 'official', url: `https://example.test/${id}/${digest}.json`, sha256: digest } } };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-dev-source-'));
  const pluginsRoot = resolve(root, 'external-plugins');
  await mkdir(pluginsRoot);
  await mkdir(resolve(root, 'tooling/plugins'), { recursive: true });
  await writeFile(resolve(root, 'tooling/plugins/compatibility.json'), JSON.stringify({ source: {
    pluginId: 'lyrics-workbench', publicKey: 'server/index.js', exports: ['createHandler'],
  } }));
  const selected = ['lyrics-workbench', 'youtube-music', 'retained-provider'].map(id => packaged(id, 'published'));
  for (const item of selected) {
    const path = resolve(root, 'shared/plugins/.artifact-cache', `${item.digest}.json`);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, item.bytes);
  }
  await materializePluginArtifacts({ root, artifacts: selected.map(({ entry, artifact }) => ({ entry, artifact })) });
  await writeFile(resolve(root, 'plugins.lock.json'), 'original debug-independent lock\n');
  await writeFile(resolve(root, 'shared/plugins/build.generated.js'), 'export const original = true;\n');
  await writeFile(resolve(root, 'unrelated.txt'), 'parallel work is preserved\n');
  const paths = ['plugins.lock.json', 'shared/plugins/build.generated.js', 'shared/plugins/delivery.generated.js',
    'server/src/plugins/delivery.generated.js', 'client/src/plugins/delivery.generated.js',
    'tooling/plugins/delivery-source.generated.json', 'shared/plugins/.bridges/lyrics-workbench/server/index.js'];
  const baseline = new Map(await Promise.all(paths.map(async path => [path, await readFile(resolve(root, path))])));
  const built = [];
  const options = { root, pluginsRoot, environment: {}, fetchImpl: () => { throw Error('No network expected'); },
    createArtifact: async id => { built.push(id); return packaged(id, 'local-development'); },
    createLock: async currentRoot => {
      assert.equal(currentRoot, root);
      const inventory = JSON.parse(await readFile(resolve(root, 'tooling/plugins/delivery-source.generated.json'), 'utf8'));
      return { schemaVersion: 1, hostApiVersion: 2, host: { version: '1.2.1', sourceDigest: 'a'.repeat(64) },
        plugins: Object.entries(inventory.plugins).map(([id, value]) => ({ id, source: value.source, sourceDigest: 'b'.repeat(64), sources: [] })) };
    } };
  return { root, pluginsRoot, baseline, selected, options, built };
}

test('development override replaces only requested selected packages and marks an honest local build', async () => {
  const f = await fixture();
  const result = await prepareDevSources(f.options);
  assert.deepEqual(f.built, ['lyrics-workbench', 'youtube-music']);
  assert.equal(result.retained, 1);
  const marker = JSON.parse(await readFile(resolve(f.root, DEV_SOURCE_MARKER), 'utf8'));
  assert.equal(marker.mode, 'dev-source'); assert.equal(marker.state, 'active');
  assert.equal(marker.selected.length, 3);
  assert.equal(marker.selected.find(item => item.id === 'retained-provider').sha256, f.selected[2].digest);
  const generated = await readFile(resolve(f.root, 'shared/plugins/delivery.generated.js'), 'utf8');
  assert.match(generated, /dev-local/); assert.match(generated, /dev-source\.invalid/);
  assert.doesNotMatch(generated, /pluginDeployment = Object.freeze\(JSON.parse\("\{/);
  const lock = JSON.parse(await readFile(resolve(f.root, 'plugins.lock.json'), 'utf8'));
  assert.match(lock.plugins.find(item => item.id === 'youtube-music').source, /^artifact:dev-local:/);
  assert.match(lock.plugins.find(item => item.id === 'retained-provider').source, /^artifact:official:/);
  await assert.rejects(assertNoDevSourceOverride(f.root), { code: 'PLUGIN_DEV_SOURCE_ACTIVE' });
  assert.equal(await readFile(resolve(f.root, 'unrelated.txt'), 'utf8'), 'parallel work is preserved\n');
  await restoreDevSources({ root: f.root });
});

test('restore returns generated files, bridges and locks byte-for-byte while retaining immutable caches', async () => {
  const f = await fixture(); await prepareDevSources(f.options);
  const marker = JSON.parse(await readFile(resolve(f.root, DEV_SOURCE_MARKER), 'utf8'));
  const local = marker.selected.find(item => item.id === 'youtube-music');
  const result = await restoreDevSources({ root: f.root });
  assert.equal(result.restored, true);
  for (const [path, original] of f.baseline) assert.deepEqual(await readFile(resolve(f.root, path)), original, path);
  await access(resolve(f.root, 'shared/plugins/.artifact-cache', `${local.sha256}.json`));
  await assertNoDevSourceOverride(f.root);
  assert.deepEqual(await restoreDevSources({ root: f.root }), { restored: false, reason: 'inactive' });
});

test('restore detects parallel changes before modifying any generated file', async () => {
  const f = await fixture(); await prepareDevSources(f.options);
  const path = 'server/src/plugins/delivery.generated.js';
  const prepared = await readFile(resolve(f.root, path));
  await writeFile(resolve(f.root, path), '// another session changed this file\n');
  const unchanged = await readFile(resolve(f.root, 'shared/plugins/delivery.generated.js'));
  await assert.rejects(restoreDevSources({ root: f.root }), error => error.code === 'PLUGIN_DEV_RESTORE_CONFLICT'
    && error.paths.includes(path));
  assert.deepEqual(await readFile(resolve(f.root, 'shared/plugins/delivery.generated.js')), unchanged);
  assert.equal(await readFile(resolve(f.root, path), 'utf8'), '// another session changed this file\n');
  await access(resolve(f.root, DEV_SOURCE_MARKER));
  await writeFile(resolve(f.root, path), prepared);
  await restoreDevSources({ root: f.root });
});

test('prepare refuses production/CI, duplicate active overrides and packages absent from the current selection', async () => {
  const f = await fixture();
  await assert.rejects(prepareDevSources({ ...f.options, environment: { NODE_ENV: 'production' } }), { code: 'PLUGIN_DEV_SOURCE_NOT_ALLOWED' });
  await assert.rejects(prepareDevSources({ ...f.options, environment: { CI: 'true' } }), { code: 'PLUGIN_DEV_SOURCE_NOT_ALLOWED' });
  await assert.rejects(prepareDevSources({ ...f.options, ids: ['uninstalled-provider'] }), { code: 'PLUGIN_DEV_SOURCE_NOT_SELECTED' });
  assert.deepEqual(f.built, []);
  await prepareDevSources(f.options);
  await assert.rejects(prepareDevSources(f.options), { code: 'PLUGIN_DEV_SOURCE_ACTIVE' });
  await restoreDevSources({ root: f.root });
});

test('a lock-generation failure leaves a recoverable marker and exact backups', async () => {
  const f = await fixture();
  await assert.rejects(prepareDevSources({ ...f.options, createLock: async () => { throw Error('Synthetic lock failure'); } }), /Synthetic lock failure/);
  const marker = JSON.parse(await readFile(resolve(f.root, DEV_SOURCE_MARKER), 'utf8'));
  assert.equal(marker.state, 'failed');
  await restoreDevSources({ root: f.root });
  for (const [path, original] of f.baseline) assert.deepEqual(await readFile(resolve(f.root, path)), original);
});

test('restore rejects a marker path or backup tamper without overwriting current outputs', async () => {
  const f = await fixture(); await prepareDevSources(f.options);
  const marker = JSON.parse(await readFile(resolve(f.root, DEV_SOURCE_MARKER), 'utf8'));
  const record = marker.files.find(item => item.backup);
  const originalBackup = await readFile(resolve(f.root, record.backup));
  await writeFile(resolve(f.root, record.backup), 'tampered');
  await assert.rejects(restoreDevSources({ root: f.root }), { code: 'PLUGIN_DEV_BACKUP_INVALID' });
  await writeFile(resolve(f.root, record.backup), originalBackup);
  marker.files.push({ path: '../outside.txt', backup: null, beforeSha256: null, afterSha256: 'a'.repeat(64) });
  await writeFile(resolve(f.root, DEV_SOURCE_MARKER), JSON.stringify(marker));
  await assert.rejects(restoreDevSources({ root: f.root }), { code: 'PLUGIN_DEV_OUTPUT_INVALID' });
  marker.files.pop(); await writeFile(resolve(f.root, DEV_SOURCE_MARKER), JSON.stringify(marker));
  await restoreDevSources({ root: f.root });
});
