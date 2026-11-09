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
  assert.deepEqual(calls, ['prepare', 'run plugins:lock', 'run build']);
  calls.length = 0;
  await assert.rejects(runPluginCiChannel('build', { ...options, runDeliveryImpl: async () => {
    throw Object.assign(new Error('PLUGIN_BUILD_SUPERSEDED'), { code: 'PLUGIN_BUILD_SUPERSEDED' });
  } }), { code: 'PLUGIN_BUILD_SUPERSEDED' });
  assert.deepEqual(calls, []);
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
