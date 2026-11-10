import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPluginHostBuild } from './host-identity.mjs';
import { deliveryPlanDigest } from './assemble.mjs';
import { prepareHostUpgrade, runDeliveryCommand } from './delivery.mjs';
import { preparePluginSeed } from './seed.mjs';
import { canonicalPluginManifest } from '../../shared/plugins/manifest.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = { FLARETUNE_PLUGIN_SITE_URL: 'https://music.example.net', FLARETUNE_PLUGIN_BUILD_TOKEN: 'synthetic_host_upgrade_token_not_a_secret_123456' };
const oldHost = { version: '1.2.1', sourceDigest: '1'.repeat(64) };
const manifest = (id, version = '0.4.2') => ({ id, version, hostApiVersion: 1, apiVersion: 1, name: id,
  description: 'Synthetic package', icon: 'box', pages: [], entries: [], dataVersion: 0 });
const artifact = manifest => ({ schemaVersion: 1, manifest, files: {
  'client/index.js': 'export default function Page() { return null; }',
  'server/index.js': 'export const migrations = []; export function createHandler() { return () => null; }',
}, entries: { client: 'client/index.js', server: 'server/index.js' } });

async function fixture(t, { seed = false, plugins = true } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-host-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = { 'package.json': JSON.stringify({ name: 'synthetic-host', version: '1.2.2', type: 'module' }),
    'package-lock.json': '{"lockfileVersion":3}', 'tooling/plugins/sources.json': '{"hostFiles":[]}',
    'client/src/plugins/sdk.js': 'export const stableApi = true;\n' };
  for (const [path, bytes] of Object.entries(files)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), bytes); }
  const host = await createPluginHostBuild(root);
  await writeFile(resolve(root, 'plugins.lock.json'), JSON.stringify({ schemaVersion: 1, host, plugins: [] }));
  const installedManifest = manifest('community-extension');
  const bytes = JSON.stringify(artifact(installedManifest));
  const installed = { id: installedManifest.id, version: installedManifest.version, manifest: installedManifest,
    source: { type: 'artifact', id: 'community', url: 'https://packages.example.net/community/0.4.2/immutable.json', sha256: sha(bytes) } };
  const state = { schemaVersion: 1, revision: 7, registryRevision: 3, host: oldHost, plugins: plugins ? [installed] : [],
    pending: false, build: { id: randomUUID(), status: 'deployed', host: oldHost, resultUnknown: false } };
  state.runningDigest = deliveryPlanDigest(state);
  state.build.planDigest = state.runningDigest;
  const byUrl = new Map([[installed.source.url, bytes]]);
  let seedEntry;
  if (seed) {
    const seedManifest = manifest('disabled-distribution-package', '1.0.0');
    const seedBytes = JSON.stringify(artifact(seedManifest));
    const digest = sha(seedBytes);
    seedEntry = { id: seedManifest.id, version: seedManifest.version, manifest: seedManifest, source: { type: 'artifact', id: 'official',
      url: `https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/${'a'.repeat(40)}/artifacts/${seedManifest.id}/1.0.0/${digest}.json`, sha256: digest } };
    byUrl.set(seedEntry.source.url, seedBytes);
    await writeFile(resolve(root, 'plugins.seed.lock.json'), JSON.stringify({ schemaVersion: 1, plugins: [seedEntry] }));
  }
  const calls = [], reports = [];
  const f = { root, host, state, installed, seedEntry, calls, reports, byUrl, plan: null, reserveResponse: null, getStatus: 200, postStatus: 200 };
  f.fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    assert.equal(init.redirect, 'error');
    if (url === `${environment.FLARETUNE_PLUGIN_SITE_URL}/api/plugin-build/upgrade`) {
      assert.equal(init.headers.Authorization, `Bearer ${environment.FLARETUNE_PLUGIN_BUILD_TOKEN}`);
      if (init.method === 'GET') return Response.json(state, { status: f.getStatus });
      if (f.postStatus !== 200) return Response.json({ error: 'conflict' }, { status: f.postStatus });
      const body = JSON.parse(init.body);
      f.plan = { schemaVersion: 1, buildId: randomUUID(), host: body.host, plugins: structuredClone(state.plugins), buildStatus: 'queued' };
      f.plan.planDigest = deliveryPlanDigest(f.plan);
      return Response.json(f.reserveResponse ? f.reserveResponse(f.plan) : f.plan);
    }
    if (url.endsWith('/api/plugin-build/snapshot')) return Response.json(f.plan);
    if (url.endsWith('/api/plugin-build/report')) { reports.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    if (byUrl.has(url)) return new Response(byUrl.get(url));
    throw new Error('Unexpected synthetic request');
  };
  f.prepare = (current = false) => prepareHostUpgrade({ root, environment, fetchImpl: f.fetchImpl, current });
  f.metadata = async () => import(`${pathToFileURL(resolve(root, 'shared/plugins/delivery.generated.js')).href}?check=${randomUUID()}`);
  return f;
}

async function coldSeedLock(f, { wrongFileHash = false } = {}) {
  await preparePluginSeed({ root: f.root, fetchImpl: f.fetchImpl });
  const paths = ['client/src/plugins/sdk.js', `shared/plugins/.delivery/${f.seedEntry.id}/${f.seedEntry.source.sha256}/client/index.js`].sort();
  const sources = [];
  for (const path of paths) sources.push({ path, sha256: sha(await readFile(resolve(f.root, path))) });
  if (wrongFileHash) sources.find(row => row.path.startsWith('shared/')).sha256 = '9'.repeat(64);
  const lock = { schemaVersion: 1, host: f.host, plugins: [{ id: f.seedEntry.id, version: f.seedEntry.version,
    source: `artifact:official:${f.seedEntry.source.sha256}`, manifestDigest: sha(canonicalPluginManifest(f.seedEntry.manifest)),
    sourceDigest: sha(JSON.stringify(sources)), sources }] };
  await writeFile(resolve(f.root, 'plugins.lock.json'), JSON.stringify(lock));
  for (const path of ['shared/plugins/.artifact-cache', 'shared/plugins/.delivery']) {
    const target = resolve(f.root, path);
    assert.equal(relative(f.root, target).startsWith('..'), false);
    await rm(target, { recursive: true, force: true });
  }
  await assert.rejects(access(resolve(f.root, paths.find(path => path.startsWith('shared/')))), { code: 'ENOENT' });
  f.calls.length = 0;
}

test('new host preparation inherits exact third-party bytes and version; distribution seed only hydrates caches', async t => {
  const f = await fixture(t, { seed: true });
  const result = await f.prepare();
  const post = f.calls.find(row => row.url.endsWith('/upgrade') && row.method === 'POST');
  assert.deepEqual(post.body, { revision: 7, registryRevision: 3, fromHost: oldHost, runningDigest: f.state.runningDigest, host: f.host });
  assert.equal(Object.hasOwn(post.body, 'plugins'), false);
  assert.equal(result.buildId, f.plan.buildId);
  assert.deepEqual(f.reports, [{ buildId: f.plan.buildId, planDigest: f.plan.planDigest, status: 'building' }]);
  const metadata = await f.metadata();
  assert.deepEqual(metadata.pluginDeployment.plugins, [{ id: f.installed.id, version: '0.4.2', source: f.installed.source }]);
  assert.deepEqual(metadata.deliveryPluginManifests.map(row => row.id), [f.installed.id]);
  assert.equal(Object.hasOwn(metadata.compiledPluginSources, f.seedEntry.id), false);
  await access(resolve(f.root, `shared/plugins/.delivery/${f.seedEntry.id}/${f.seedEntry.source.sha256}/client/index.js`));
  const inventory = JSON.parse(await readFile(resolve(f.root, 'tooling/plugins/delivery-source.generated.json'), 'utf8'));
  assert.deepEqual(Object.keys(inventory.plugins), [f.installed.id]);
});

test('empty running combination remains empty even with a nonempty reviewed distribution seed', async t => {
  const f = await fixture(t, { seed: true, plugins: false });
  await f.prepare();
  assert.deepEqual((await f.metadata()).deliveryPluginManifests, []);
  assert.deepEqual((await f.metadata()).pluginDeployment.plugins, []);
});

test('cold CI checkout restores locked ignored seed files before strict checkout verification and reservation', async t => {
  const f = await fixture(t, { seed: true });
  await coldSeedLock(f);
  await f.prepare(true);
  const seedFetch = f.calls.findIndex(row => row.url === f.seedEntry.source.url);
  const stateRead = f.calls.findIndex(row => row.url.endsWith('/upgrade') && row.method === 'GET');
  const reserve = f.calls.findIndex(row => row.url.endsWith('/upgrade') && row.method === 'POST');
  assert.ok(seedFetch >= 0 && stateRead > seedFetch && reserve > stateRead);
  assert.deepEqual((await f.metadata()).pluginDeployment.plugins, [{ id: f.installed.id, version: f.installed.version, source: f.installed.source }]);
  assert.equal(Object.hasOwn((await f.metadata()).compiledPluginSources, f.seedEntry.id), false);
  assert.deepEqual(f.reports.map(row => row.status), ['building']);
});

test('hydration cannot bypass an incorrect locked seed-file hash even when the source-list checksum is valid', async t => {
  const f = await fixture(t, { seed: true });
  await coldSeedLock(f, { wrongFileHash: true });
  await assert.rejects(f.prepare(true), { code: 'PLUGIN_CHECKOUT_MISMATCH' });
  assert.ok(f.calls.some(row => row.url === f.seedEntry.source.url), 'immutable seed bytes were restored before source-file validation');
  assert.equal(f.calls.some(row => row.method === 'POST' || row.url.includes('/api/plugin-build/')), false);
  assert.deepEqual(f.reports, []);
});

test('pre-reservation compatibility, pending, active and unknown failures never report failure against an older build', async t => {
  for (const [name, mutate, code] of [
    ['pending', f => { f.state.pending = true; }, 'PLUGIN_UPGRADE_PENDING_CHANGES'],
    ['active', f => { f.state.build.status = 'building'; }, 'PLUGIN_BUILD_IN_PROGRESS'],
    ['unknown', f => { f.state.build.resultUnknown = true; }, 'PLUGIN_BUILD_RESULT_UNKNOWN'],
    ['workspace', f => { f.state.plugins[0].source = { type: 'workspace', id: 'workspace', sourceDigest: '4'.repeat(64) }; f.state.runningDigest = deliveryPlanDigest(f.state); }, 'PLUGIN_UPGRADE_ARTIFACT_REQUIRED'],
    ['incompatible-api', f => { f.state.plugins[0].manifest.hostApiVersion = 99; f.state.runningDigest = deliveryPlanDigest(f.state); }, undefined],
  ]) await t.test(name, async t => {
    const f = await fixture(t); mutate(f);
    await assert.rejects(f.prepare(), code ? { code } : undefined);
    assert.deepEqual(f.reports, []);
    assert.equal(f.calls.some(row => row.method === 'POST'), false);
  });
});

test('an unsupported old protocol, denied token, or reservation conflict stops without corrupting current task', async t => {
  for (const [status, code] of [[404, 'PLUGIN_HOST_UPGRADE_UNAVAILABLE'], [403, 'PLUGIN_BUILD_AUTH_FAILED']]) {
    const f = await fixture(t); f.getStatus = status;
    await assert.rejects(f.prepare(), { code });
    assert.deepEqual(f.reports, []);
    assert.equal(f.calls.length, 1);
  }
  const f = await fixture(t); f.postStatus = 409;
  await assert.rejects(f.prepare(), { code: 'PLUGIN_BUILD_REQUEST_FAILED' });
  assert.deepEqual(f.reports, []);
});

test('checkout drift is detected before any network reservation or report', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.root, 'client/src/plugins/sdk.js'), 'export const unexpectedChange = true;\n');
  await assert.rejects(f.prepare(), { code: 'PLUGIN_HOST_BUILD_MISMATCH' });
  assert.deepEqual(f.calls, []);
});

test('a post-reservation corrupt artifact reports failure only for the new frozen task', async t => {
  const f = await fixture(t);
  f.byUrl.set(f.installed.source.url, '{}');
  await assert.rejects(f.prepare(), { code: 'PLUGIN_ARTIFACT_DIGEST_MISMATCH' });
  assert.deepEqual(f.reports, [{ buildId: f.plan.buildId, planDigest: f.plan.planDigest, status: 'failed' }]);
});

test('a mismatching reservation response cannot replace the inherited selection or fail another task', async t => {
  const f = await fixture(t);
  f.reserveResponse = plan => { plan.plugins = []; plan.planDigest = deliveryPlanDigest(plan); return plan; };
  await assert.rejects(f.prepare(), { code: 'PLUGIN_BUILD_RESPONSE_INVALID' });
  assert.deepEqual(f.reports, []);
});

test('CI preparation resumes its existing frozen new-host task while the old host still serves', async t => {
  const f = await fixture(t);
  f.plan = { schemaVersion: 1, buildId: randomUUID(), host: f.host, plugins: f.state.plugins, buildStatus: 'building' };
  f.plan.planDigest = deliveryPlanDigest(f.plan);
  f.state.build = { id: f.plan.buildId, planDigest: f.plan.planDigest, status: 'building', host: f.host, resultUnknown: false };
  const result = await runDeliveryCommand('prepare-current', { root: f.root, environment, fetchImpl: f.fetchImpl });
  assert.equal(result.buildId, f.plan.buildId);
  assert.equal(f.calls.some(row => row.url.endsWith('/upgrade') && row.method === 'POST'), false);
  assert.deepEqual(f.reports, [{ buildId: f.plan.buildId, planDigest: f.plan.planDigest, status: 'building' }]);
});

test('same-host completed CI replay preserves the deployed task without changing progress', async t => {
  const f = await fixture(t);
  f.state.host = f.host; f.state.runningDigest = deliveryPlanDigest(f.state);
  f.plan = { schemaVersion: 1, buildId: randomUUID(), host: f.host, plugins: f.state.plugins, buildStatus: 'deployed' };
  f.plan.planDigest = deliveryPlanDigest(f.plan);
  f.state.build = { id: f.plan.buildId, planDigest: f.plan.planDigest, status: 'deployed', host: f.host, resultUnknown: false };
  await f.prepare(true);
  assert.deepEqual((await f.metadata()).pluginDeployment.host, f.host);
  assert.deepEqual(f.reports, []);
  assert.equal(f.calls.some(row => row.url.endsWith('/upgrade') && row.method === 'POST'), false);
});

test('an unconfirmed promotion is not restarted by CI preparation', async t => {
  const f = await fixture(t);
  f.plan = { schemaVersion: 1, buildId: randomUUID(), host: f.host, plugins: f.state.plugins, buildStatus: 'activation_pending' };
  f.plan.planDigest = deliveryPlanDigest(f.plan);
  f.state.build = { id: f.plan.buildId, planDigest: f.plan.planDigest, status: 'activation_pending', host: f.host, resultUnknown: true };
  await assert.rejects(f.prepare(true), { code: 'PLUGIN_DEPLOYMENT_UNCONFIRMED' });
  assert.deepEqual(f.reports, []);
  assert.equal(f.calls.some(row => row.method === 'POST'), false);
});

test('a task changed between upgrade-state and snapshot reads cannot be assembled or receive a failure report', async t => {
  for (const [name, mutate] of [
    ['different-host', plan => { plan.host = { ...plan.host, sourceDigest: '6'.repeat(64) }; plan.planDigest = deliveryPlanDigest(plan); }],
    ['same-host-different-build-id', plan => { plan.buildId = randomUUID(); }],
    ['same-host-different-plan-digest', plan => { plan.plugins = []; plan.planDigest = deliveryPlanDigest(plan); }],
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    f.plan = { schemaVersion: 1, buildId: randomUUID(), host: f.host, plugins: f.state.plugins, buildStatus: 'building' };
    f.plan.planDigest = deliveryPlanDigest(f.plan);
    f.state.build = { id: f.plan.buildId, planDigest: f.plan.planDigest, status: 'building', host: f.host, resultUnknown: false };
    mutate(f.plan);
    await assert.rejects(f.prepare(true), { code: 'PLUGIN_BUILD_SUPERSEDED' });
    assert.deepEqual(f.reports, []);
    assert.deepEqual(f.calls.map(row => new URL(row.url).pathname), ['/api/plugin-build/upgrade', '/api/plugin-build/snapshot']);
  });
});
