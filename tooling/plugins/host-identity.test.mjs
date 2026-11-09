import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createPluginHostBuild } from './host-identity.mjs';

test('host identity covers runtime, auth, bindings, build config and assets at the same version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flaretune-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); };
  await put('package.json', JSON.stringify({ version: '1.2.1' }));
  const paths = ['server/src/auth/local/index.js', 'server/src/instance/accessPolicy.js', 'server/src/routes/localAssistant.js',
    'wrangler.toml', 'client/vite.config.js', 'client/public/icon.svg', 'server/db/migrations-flaretune/0001.sql'];
  for (const path of paths) {
    const before = await createPluginHostBuild(root);
    await put(path, `changed input ${path}`);
    assert.notEqual((await createPluginHostBuild(root)).sourceDigest, before.sourceDigest, path);
  }
  const before = await createPluginHostBuild(root);
  await put('shared/plugins/delivery.generated.js', 'delivery metadata');
  await put('shared/plugins/build.generated.js', 'generated lock metadata');
  await put('shared/plugins/.delivery/remote/entry.js', 'remote plugin');
  await put('server/src/plugins/youtube/.generated/quickjs.wasm', 'generated wasm');
  await put('tooling/plugins/.delivery-recovery/task.json', 'recovery receipt');
  assert.deepEqual(await createPluginHostBuild(root), before);
});
