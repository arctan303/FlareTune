import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginCiContext, runPluginCiChannel } from './ci-channel.mjs';

const environment = { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'codex/plugin-host-dev-20261108',
  FLARETUNE_PLUGIN_SITE_URL: 'https://tune-dev.arcinks.com', FLARETUNE_PLUGIN_WORKER_NAME: 'flaretune-dev',
  FLARETUNE_PLUGIN_BUILD_TOKEN: 'synthetic-build-token-for-testing-only' };

test('dedicated CI accepts only its exact branch and development target', () => {
  assert.equal(pluginCiContext(environment).branch, environment.WORKERS_CI_BRANCH);
  for (const change of [{ WORKERS_CI_BRANCH: 'dev' }, { WORKERS_CI: '0' },
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
    assert.equal(effective.WORKERS_CI_BRANCH, 'codex/plugin-host-dev-20261108');
  };
  const options = { environment: providerEnvironment, root: '/synthetic',
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

test('unrecognized controllers, alternate controller branches and controller deployment targets are rejected before work', async () => {
  for (const change of [
    { WRANGLER_CI_OVERRIDE_NAME: 'some-other-worker' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build', FLARETUNE_PLUGIN_DEPLOY_WORKER_TAG: 'invalid-tag' },
    { WRANGLER_CI_OVERRIDE_NAME: 'flaretune-plugin-build', WORKERS_CI_BRANCH: 'codex/other', FLARETUNE_PLUGIN_BUILD_BRANCH: 'codex/other' },
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
