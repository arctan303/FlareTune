import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { bundleWorkerModules } from '../dev/bundle-worker-modules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('preview bundle supplies the pinned QuickJS Wasm as a real workerd compiled module', async () => {
  const temporaryRoot = resolve(root, '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(resolve(temporaryRoot, 'compiled-wasm-test-'));
  const entryPoint = resolve(directory, 'worker.mjs');
  const evaluator = relative(directory, resolve(root, 'server/src/plugins/youtube/worker-evaluator.mjs')).split(sep).join('/');
  let mf;
  try {
    await writeFile(entryPoint, `import {evaluatePlayer} from ${JSON.stringify(evaluator)};
export default {async fetch(){const value=await evaluatePlayer({output:'return {n:"workerd-ready",sig:String(6*7)};'});return Response.json(value);}};`);
    const bundled = await bundleWorkerModules({ esbuild, entryPoint });
    assert.equal(bundled.modules[0].type, 'ESModule');
    const wasm = bundled.modules.filter(module => module.type === 'CompiledWasm');
    assert.equal(wasm.length, 1);
    assert.equal(wasm[0].contents.byteLength, 503134);
    assert.deepEqual(Array.from(wasm[0].contents.slice(0, 4)), [0, 97, 115, 109]);
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'wasm-preview-test', ...bundled,
      compatibilityDate: '2026-09-23', outboundService: () => { throw new Error('TEST_OUTBOUND_BLOCKED'); } }] }));
    const response = await mf.dispatchFetch('https://wasm-preview.test/');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { n: 'workerd-ready', sig: '42' });
  } finally {
    if (mf) await mf.dispose();
    assert.equal(dirname(directory), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  }
});
