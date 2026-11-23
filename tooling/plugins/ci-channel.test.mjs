import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { deliveryPlanDigest } from './assemble.mjs';
import { pluginCiContext, runPluginCiChannel } from './ci-channel.mjs';

const environment = { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'dev',
  FLARETUNE_PLUGIN_SITE_URL: 'https://tune-dev.arcinks.com', FLARETUNE_PLUGIN_WORKER_NAME: 'flaretune-dev',
  FLARETUNE_PLUGIN_BUILD_TOKEN: 'synthetic-build-token-for-testing-only' };
const reservedHostUpgrade = { kind: 'host-upgrade', buildStatus: 'queued', host: { version: '1.3.0', sourceDigest: 'a'.repeat(64) } };
const legacyPlan = { fetchSnapshot: async () => reservedHostUpgrade, hostIdentity: async () => reservedHostUpgrade.host };

test('dedicated CI accepts only its exact branch and development target', () => {
  assert.equal(pluginCiContext(environment).branch, environment.WORKERS_CI_BRANCH);
  for (const change of [{ WORKERS_CI_BRANCH: 'main' }, { WORKERS_CI_BRANCH: 'codex/plugin-host-dev-20261108' }, { WORKERS_CI: '0' },
    { FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/*' }, { FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/a..b' },
    { FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/.hidden' }, { FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/a.lock' },
    { FLARETUNE_PLUGIN_WORKER_NAME: 'flaretune' }, { FLARETUNE_PLUGIN_SITE_URL: 'https://other.example' }]) {
    assert.throws(() => pluginCiContext({ ...environment, ...change }), /^Error: PLUGIN_/);
  }
  assert.equal(pluginCiContext({ ...environment, FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/reviewed-host',
    WORKERS_CI_BRANCH: 'codex/reviewed-host' }).branch, 'codex/reviewed-host');
});

test('CI builds only after immutable preparation and lock generation succeeded', async () => {
  const calls = [];
  const options = { environment, root: '/synthetic',
    ...legacyPlan,
    runDeliveryImpl: async command => calls.push(command),
    runNpmImpl: async (_root, args) => calls.push(args.join(' ')) };
  assert.deepEqual(await runPluginCiChannel('build', options), { status: 'built' });
  assert.deepEqual(calls, ['prepare-current', 'run plugins:lock', 'run build']);
  calls.length = 0;
  await assert.rejects(runPluginCiChannel('build', { ...options, runDeliveryImpl: async () => {
    throw Object.assign(new Error('PLUGIN_BUILD_SUPERSEDED'), { code: 'PLUGIN_BUILD_SUPERSEDED' });
  } }), { code: 'PLUGIN_BUILD_SUPERSEDED' });
  assert.deepEqual(calls, []);
});

test('CI compile failure reports only its prepared frozen task and never a preflight failure or deployed replay', async () => {
  const prepared = { buildId: '5a735ce2-2ceb-4a93-83b2-1937650da147', planDigest: 'a'.repeat(64), prepared: true };
  const compileError = Object.assign(new Error('synthetic compile failure'), { code: 'PLUGIN_CI_COMMAND_FAILED' });
  const reports = [];
  const options = { environment, root: '/synthetic',
    ...legacyPlan,
    runDeliveryImpl: async command => { assert.equal(command, 'prepare-current'); return prepared; },
    runNpmImpl: async (_root, args) => { if (args.join(' ') === 'run build') throw compileError; },
    reportImpl: async (connection, plan, status) => {
      assert.equal(connection.origin, environment.FLARETUNE_PLUGIN_SITE_URL);
      reports.push({ buildId: plan.buildId, planDigest: plan.planDigest, status });
    },
  };
  await assert.rejects(runPluginCiChannel('build', options), error => error === compileError);
  assert.deepEqual(reports, [{ buildId: prepared.buildId, planDigest: prepared.planDigest, status: 'failed' }]);
  reports.length = 0;
  const preflightError = Object.assign(new Error('preflight conflict'), { code: 'PLUGIN_BUILD_IN_PROGRESS' });
  await assert.rejects(runPluginCiChannel('build', { ...options, runDeliveryImpl: async () => { throw preflightError; } }), error => error === preflightError);
  assert.deepEqual(reports, []);
  await assert.rejects(runPluginCiChannel('build', { ...options, runDeliveryImpl: async () => ({ ...prepared, replay: true }) }), error => error === compileError);
  assert.deepEqual(reports, []);
  await assert.rejects(runPluginCiChannel('build', { ...options, reportImpl: async () => { throw new Error('lost failure report'); } }), error => error === compileError);
});

test('CI hands only the generated private config to controlled deploy and recovery', async () => {
  const calls = [];
  const options = { environment: { ...environment, FLARETUNE_PLUGIN_WRANGLER_CONFIG: 'wrong.toml', FLARETUNE_PLUGIN_WRANGLER_ENV: 'production' },
    prepareConfigImpl: async () => { calls.push('metadata'); return { configPath: '/synthetic/private/dev.json' }; },
    deployImpl: async options => {
      calls.push('deploy');
      assert.equal(options.environment.FLARETUNE_PLUGIN_WRANGLER_CONFIG, '/synthetic/private/dev.json');
      assert.equal(options.environment.FLARETUNE_PLUGIN_WRANGLER_ENV, '');
      return { recover: options.recover };
    } };
  assert.deepEqual(await runPluginCiChannel('deploy', options), { recover: false });
  assert.deepEqual(await runPluginCiChannel('recover', options), { recover: true });
  assert.deepEqual(calls, ['metadata', 'deploy', 'metadata', 'deploy']);
});

test('named build controller reaches only the development target without mutating its provider environment', async () => {
  const providerEnvironment = { ...environment, WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build',
    WRANGLER_CI_MATCH_TAG: 'c'.repeat(32), FLARETUNE_PLUGIN_DEPLOY_WORKER_TAG: 'd'.repeat(32) };
  const calls = [];
  const checkEnvironment = effective => {
    assert.equal(effective.WRANGLER_CI_OVERRIDE_NAME, 'flaretune-dev');
    assert.equal(effective.WRANGLER_CI_MATCH_TAG, 'd'.repeat(32));
    assert.equal(effective.FLARETUNE_PLUGIN_WORKER_NAME, 'flaretune-dev');
    assert.equal(effective.WORKERS_CI_BRANCH, 'dev');
  };
  const options = { environment: providerEnvironment, root: '/synthetic',
    ...legacyPlan,
    runDeliveryImpl: async (command, options) => { checkEnvironment(options.environment); calls.push(command); },
    runNpmImpl: async (_root, args, effective) => { checkEnvironment(effective); calls.push(args.join(' ')); },
    prepareConfigImpl: async options => { checkEnvironment(options.environment); calls.push('metadata'); return { configPath: '/synthetic/dev.json' }; },
    deployImpl: async options => { checkEnvironment(options.environment); assert.equal(options.buildWorkerName, 'flaretune-plugin-build'); calls.push(options.recover ? 'recover' : 'deploy'); return { ok: true }; } };
  await runPluginCiChannel('build', options);
  await runPluginCiChannel('deploy', options);
  await runPluginCiChannel('recover', options);
  assert.deepEqual(calls, ['prepare-current', 'run plugins:lock', 'run build', 'metadata', 'deploy', 'metadata', 'recover']);
  assert.equal(providerEnvironment.WRANGLER_CI_OVERRIDE_NAME, 'flaretune-plugin-build');
  assert.equal(providerEnvironment.WRANGLER_CI_MATCH_TAG, 'c'.repeat(32));
});

const hash = value => createHash('sha256').update(value).digest('hex');
const pluginBuildId = '825c01b4-4adf-4dad-a6d4-4065b5ac0e76';
const releaseCommit = 'c'.repeat(40);

function fixtureArchive(files) {
  const parts = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write(`FlareTune-${releaseCommit}/${name}`);
    header.write(bytes.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156); header[156] = 48;
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0'), 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

async function exactFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-plugin-ci-test-'));
  t.after(async () => {
    const directory = await realpath(root);
    assert.equal(dirname(directory), await realpath(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const packageFile = '{"name":"running-host","version":"1.3.0","type":"module"}';
  const host = { version: '1.3.0', sourceDigest: hash(JSON.stringify([{ path: 'package.json', sha256: hash(packageFile) }])) };
  const archive = fixtureArchive({ 'package.json': packageFile, 'plugins.lock.json': JSON.stringify({ host, hostApiVersion: 6 }) });
  const hostRelease = { schemaVersion: 1, id: `1.3.0:${releaseCommit}`, version: '1.3.0', commit: releaseCommit,
    host, hostApiVersion: 6, minVersion: '1.3.0', notes: { zh: '更新', en: 'Update' }, migration: { compatible: true },
    channel: 'candidate', source: { url: `https://codeload.github.com/arctan303/FlareTune/tar.gz/${releaseCommit}`, sha256: hash(archive) } };
  const snapshot = { schemaVersion: 1, buildId: pluginBuildId, buildStatus: 'queued', host, plugins: [], hostRelease };
  snapshot.planDigest = deliveryPlanDigest(snapshot);
  return { root, archive, packageFile, snapshot };
}

test('plugin CI carries the exact verified running source through both stages even when the controller is elsewhere', async t => {
  const { root, archive, packageFile, snapshot } = await exactFixture(t);
  const endpoint = `${environment.FLARETUNE_PLUGIN_SITE_URL}/api/plugin-build/snapshot`;
  const calls = [];
  let preparedRoot;
  const options = { root, environment: { ...environment, CLOUDFLARE_API_TOKEN: 'synthetic-deploy-token' },
    fetchImpl: async (url, init) => {
      if (url === endpoint) {
        assert.equal(init.headers.Authorization, `Bearer ${environment.FLARETUNE_PLUGIN_BUILD_TOKEN}`);
        return Response.json(snapshot);
      }
      assert.equal(url, snapshot.hostRelease.source.url);
      assert.equal(init.headers.Authorization, undefined);
      calls.push('download'); return new Response(archive);
    },
    hostIdentity: async () => assert.fail('controller HEAD cannot select the build source'),
    runDeliveryImpl: async (command, options) => {
      assert.equal(command, 'prepare');
      assert.notEqual(options.root, root);
      assert.equal(await readFile(resolve(options.root, 'package.json'), 'utf8'), packageFile);
      assert.equal(options.environment.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal((await (await options.fetchImpl(endpoint)).json()).buildId, pluginBuildId);
      preparedRoot = options.root;
      calls.push('prepare'); return { buildId: pluginBuildId, planDigest: snapshot.planDigest };
    },
    runNpmImpl: async (cwd, args, effective) => {
      assert.notEqual(cwd, root);
      assert.equal(effective.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(effective.FLARETUNE_PLUGIN_BUILD_TOKEN, undefined);
      assert.equal(effective.FLARETUNE_UPDATE_COMMIT, releaseCommit);
      calls.push(args.join(' '));
    },
    prepareConfigImpl: async ({ root }) => {
      assert.equal(root, preparedRoot); calls.push('config'); return { configPath: resolve(root, 'dev.json') };
    },
    deployImpl: async ({ root, fetchImpl, environment }) => {
      assert.equal(root, preparedRoot);
      assert.equal(environment.FLARETUNE_PLUGIN_WRANGLER_CONFIG, resolve(root, 'dev.json'));
      assert.equal((await (await fetchImpl(endpoint)).json()).planDigest, snapshot.planDigest);
      calls.push('deploy'); return { status: 'deployed' };
    },
  };
  assert.deepEqual(await runPluginCiChannel('build', options), { status: 'built' });
  assert.deepEqual(await runPluginCiChannel('deploy', options), { status: 'deployed' });
  assert.deepEqual(calls, ['download', 'ci', 'prepare', 'run plugins:lock', 'run build', 'config', 'deploy']);
  snapshot.buildId = '395c01b4-4adf-4dad-a6d4-4065b5ac0e76';
  await assert.rejects(runPluginCiChannel('deploy', options), { code: 'PLUGIN_BUILD_SUPERSEDED' });
  snapshot.buildId = pluginBuildId;
  await writeFile(resolve(preparedRoot, 'package.json'), packageFile + '\n');
  await assert.rejects(runPluginCiChannel('deploy', options), { code: 'SYSTEM_UPDATE_HOST_MISMATCH' });
  assert.equal(calls.length, 7);
});

test('a plugin-only plan with a moving controller fails closed when no pinned source is known', async t => {
  const { root, snapshot } = await exactFixture(t);
  delete snapshot.hostRelease;
  const plan = { root, environment, fetchSnapshot: async () => snapshot };
  await assert.rejects(runPluginCiChannel('build', { ...plan,
    hostIdentity: async () => ({ ...snapshot.host, sourceDigest: 'e'.repeat(64) }),
    runDeliveryImpl: async () => assert.fail('no legacy host upgrade') }), { code: 'PLUGIN_CI_SOURCE_REQUIRED' });
  let preparation;
  const compatible = await runPluginCiChannel('build', { ...plan, hostIdentity: async () => snapshot.host,
    runDeliveryImpl: async command => { preparation = command; return { buildId: pluginBuildId, planDigest: snapshot.planDigest }; },
    runNpmImpl: async (_root, _args, options) => assert.equal(options.FLARETUNE_PLUGIN_BUILD_TOKEN, undefined) });
  assert.deepEqual(compatible, { status: 'built' });
  assert.equal(preparation, 'prepare');
});

test('an immutable source byte mismatch stops before compilation or plugin task reporting', async t => {
  const { root, snapshot } = await exactFixture(t);
  await assert.rejects(runPluginCiChannel('build', { root, environment, fetchSnapshot: async () => snapshot,
    fetchImpl: async () => new Response('wrong archive'),
    runNpmImpl: async () => assert.fail('unverified source must not compile'), reportImpl: async () => assert.fail('no owned build') }),
  { code: 'SYSTEM_UPDATE_SOURCE_DIGEST_MISMATCH' });
});

test('a newer plugin plan arriving during source preparation cannot be claimed by the older build', async t => {
  const { root, snapshot } = await exactFixture(t);
  delete snapshot.hostRelease;
  let calls = 0;
  await assert.rejects(runPluginCiChannel('build', { root, environment, hostIdentity: async () => snapshot.host,
    fetchSnapshot: async () => ++calls === 1 ? snapshot : { ...snapshot, buildId: '395c01b4-4adf-4dad-a6d4-4065b5ac0e76' },
    runDeliveryImpl: async (_command, { fetchImpl }) => {
      await fetchImpl(`${environment.FLARETUNE_PLUGIN_SITE_URL}/api/plugin-build/snapshot`);
      assert.fail('a replaced plan must not reach preparation');
    },
    runNpmImpl: async () => assert.fail('superseded source must not compile'),
    reportImpl: async () => assert.fail('only an owned build can be reported') }), { code: 'PLUGIN_BUILD_SUPERSEDED' });
  assert.equal(calls, 2);
});

test('a late duplicate hook for an already completed plugin-only plan does no work', async t => {
  const { root, snapshot } = await exactFixture(t);
  snapshot.buildStatus = 'deployed';
  const options = { root, environment, fetchSnapshot: async () => snapshot,
    runDeliveryImpl: async () => assert.fail('completed plugin build must not advance the host'),
    runNpmImpl: async () => assert.fail('completed build must not compile'),
    prepareConfigImpl: async () => assert.fail('completed duplicate must not touch provider'),
    deployImpl: async () => assert.fail('completed duplicate must not submit deploy') };
  assert.deepEqual(await runPluginCiChannel('build', options), { status: 'idle' });
  assert.deepEqual(await runPluginCiChannel('deploy', options), { status: 'idle' });
  // A host update can remove the old release descriptor. A newer selected
  // plugin job still identifies itself and never enters the legacy updater.
  delete snapshot.hostRelease;
  snapshot.selectedUpdate = true;
  assert.deepEqual(await runPluginCiChannel('build', options), { status: 'idle' });
  assert.deepEqual(await runPluginCiChannel('deploy', options), { status: 'idle' });
  snapshot.buildStatus = 'queued';
  await assert.rejects(runPluginCiChannel('deploy', options), { code: 'PLUGIN_BUILD_SUPERSEDED' });
});

test('the authenticated no-task result is idle, while permission errors stop before preparation', async t => {
  const { root } = await exactFixture(t);
  const options = { root, environment,
    runDeliveryImpl: async () => assert.fail('an unclaimed hook must not prepare anything'),
    runNpmImpl: async () => assert.fail('an unclaimed hook must not compile'),
    prepareConfigImpl: async () => assert.fail('an idle hook must not contact the deploy provider') };
  await assert.rejects(runPluginCiChannel('build', { ...options,
    fetchImpl: async () => Response.json({ error: 'forbidden' }, { status: 403 }) }), { code: 'PLUGIN_BUILD_AUTH_FAILED' });
  const idle = { ...options, fetchImpl: async () => Response.json({ error: 'PLUGIN_BUILD_NOT_ACTIVE' }, { status: 409 }) };
  assert.deepEqual(await runPluginCiChannel('build', idle), { status: 'idle' });
  assert.deepEqual(await runPluginCiChannel('deploy', idle), { status: 'idle' });
});

test('a legacy reserved host upgrade cannot reserve a different upgrade after seeing newer state', async () => {
  await assert.rejects(runPluginCiChannel('build', { ...legacyPlan, environment,
    fetchImpl: async () => assert.fail('a new reservation must never reach the site'),
    runDeliveryImpl: async (command, { fetchImpl }) => {
      assert.equal(command, 'prepare-current');
      await fetchImpl(`${environment.FLARETUNE_PLUGIN_SITE_URL}/api/plugin-build/upgrade`, { method: 'POST' });
    },
    runNpmImpl: async () => assert.fail('an unconfirmed target must not compile') }), { code: 'PLUGIN_BUILD_SUPERSEDED' });
});

test('unrecognized controllers, alternate controller branches and controller deployment targets are rejected before work', async () => {
  for (const change of [
    { WRANGLER_CI_OVERRIDE_NAME: 'some-other-worker' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build', FLARETUNE_PLUGIN_DEPLOY_WORKER_TAG: 'invalid-tag' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build', WORKERS_CI_BRANCH: 'codex/other', FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/other' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build', WORKERS_CI_BRANCH: 'codex/plugin-host-dev-20261108', FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/plugin-host-dev-20261108' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build', WORKERS_CI_BRANCH: 'main', FLARETUNE_PLUGIN_BUILD_BRANCH: 'main' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build', FLARETUNE_PLUGIN_WORKER_NAME: 'flaretune-plugin-build' },
  ]) for (const command of ['build', 'deploy', 'recover']) {
    let called = false;
    await assert.rejects(runPluginCiChannel(command, { environment: { ...environment, ...change },
      runDeliveryImpl: async () => { called = true; }, runNpmImpl: async () => { called = true; },
      prepareConfigImpl: async () => { called = true; }, deployImpl: async () => { called = true; } }),
    { code: 'PLUGIN_DEPLOY_TARGET_MISMATCH' });
    assert.equal(called, false);
  }
});
