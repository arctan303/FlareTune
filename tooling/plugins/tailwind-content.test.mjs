import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { pluginTailwindContent } from './tailwind-content.mjs';

test('utility CSS follows the selected package even when hydration retains unselected and server caches', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-selected-css-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = 'a'.repeat(64);
  const selected = `shared/plugins/.delivery/selected/${digest}`;
  const cached = `shared/plugins/.delivery/cached/${digest}`;
  const put = async (path, value) => { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), value); };
  await put(`${selected}/client/index.js`, 'export const view = "w-[137px]";');
  await put(`${selected}/shared/styles.js`, 'export const sharedStyle = "p-[29px]";');
  await put(`${selected}/server/vendor.js`, 'export const unrelatedServerText = "h-[593px]";');
  await put(`${cached}/client/index.js`, 'export const retiredView = "w-[947px]";');
  const inventory = { schemaVersion: 1, plugins: { selected: { files: [
    `${selected}/client/index.js`, `${selected}/shared/styles.js`, `${selected}/server/vendor.js`,
    'client/src/plugins/delivery.generated.js',
  ] } } };
  await put('tooling/plugins/delivery-source.generated.json', JSON.stringify(inventory));
  const compile = async () => (await postcss([tailwindcss({ content: pluginTailwindContent(root),
    corePlugins: { preflight: false }, theme: {}, plugins: [] })]).process('@tailwind utilities;', { from: undefined })).css;
  const css = await compile();
  assert.match(css, /width: 137px/);
  assert.match(css, /padding: 29px/);
  assert.doesNotMatch(css, /947px|593px/);
  await put('tooling/plugins/delivery-source.generated.json', JSON.stringify({schemaVersion:1,plugins:{}}));
  assert.deepEqual(pluginTailwindContent(root), [], 'An empty selection must ignore every retained cache');
  assert.doesNotMatch(await compile(), /137px|29px|947px|593px/);
});

test('generated utility inputs cannot redirect a selected package to another package or outside its cache', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-selected-css-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root,'tooling/plugins'),{recursive:true});
  for (const path of [`shared/plugins/.delivery/other/${'a'.repeat(64)}/client/index.js`,
    `shared/plugins/.delivery/selected/${'a'.repeat(64)}/client/../../private.js`]) {
    await writeFile(resolve(root,'tooling/plugins/delivery-source.generated.json'),JSON.stringify({plugins:{selected:{files:[path]}}}));
    assert.throws(()=>pluginTailwindContent(root),/PLUGIN_CSS_INVENTORY_INVALID/);
  }
});
