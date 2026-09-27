import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildChildEnv, startPreview, validatePreviewConfig } from './preview-worker.mjs';

const absent = async (path) => access(path).then(() => false, () => true);

test('preview config is local-only and fixed to the FlareTune baseline', async () => {
  await validatePreviewConfig();
});

test('child environment excludes ambient credentials', () => {
  const env = buildChildEnv({ PATH: 'x', CLIENT_SECRET: 'real', OPENAI_API_KEY: 'real' });
  assert.equal(env.PATH, 'x');
  assert.equal(env.CLIENT_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('preview state must stay inside server/.wrangler', async () => {
  const runtimeLoader = async () => { throw new Error('must not load runtime'); };
  for (const statePath of [resolve('server/.wrangler'), resolve('server/.wrangler/../outside-preview')]) {
    await assert.rejects(startPreview({ statePath, runtimeLoader }), /Preview state path must be a child/);
  }
});

test('runtime load failure removes ephemeral state', async () => {
  const statePath = resolve(`server/.wrangler/test-runtime-failure-${process.pid}`);
  const failure = new Error('runtime loader failed');
  await assert.rejects(
    startPreview({ ephemeral: true, statePath, runtimeLoader: async () => { throw failure; } }),
    (error) => error === failure,
  );
  assert.equal(await absent(statePath), true);
});

test('dispose failure does not prevent ephemeral state removal and is reported', async () => {
  const statePath = resolve(`server/.wrangler/test-dispose-failure-${process.pid}`);
  const disposeFailure = new Error('dispose failed');
  const preview = await startPreview({
    ephemeral: true,
    statePath,
    runtimeLoader: async () => ({}),
    runtimeStarter: async () => ({ dispose: async () => { throw disposeFailure; } }),
  });
  await assert.rejects(preview.stop(), (error) => error instanceof AggregateError && error.errors.includes(disposeFailure));
  assert.equal(await absent(statePath), true);
});

test('runtime ready failure disposes the unreturned Miniflare and removes ephemeral state', async () => {
  const statePath = resolve(`server/.wrangler/test-ready-failure-${process.pid}`);
  const readyFailure = new Error('runtime ready failed');
  const disposeFailure = new Error('inner dispose failed');
  let disposed = 0;
  class FakeMiniflare {
    constructor() { this.ready = Promise.reject(readyFailure); }
    async dispose() { disposed += 1; throw disposeFailure; }
  }
  const runtimeLoader = async () => ({
    wrangler: { unstable_getMiniflareWorkerOptions: async () => ({ workerOptions: {}, externalWorkers: [] }) },
    miniflare: { Miniflare: FakeMiniflare, convertV4MiniflareOptions: (options) => options },
    esbuild: { build: async () => ({ outputFiles: [{ text: 'export default {}' }] }) },
  });
  await assert.rejects(
    startPreview({ ephemeral: true, statePath, runtimeLoader }),
    (error) => error === readyFailure && error.cleanupErrors?.includes(disposeFailure),
  );
  assert.equal(disposed, 1);
  assert.equal(await absent(statePath), true);
});
