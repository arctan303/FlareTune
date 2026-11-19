import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginSdkImports, allowsPluginImport } from './sdkImports.js';
import { HOST_PLUGIN_API_VERSION, resolvePluginAvailability, satisfiesPluginVersion } from './manifest.js';

const manifest = (id, extra = {}) => ({ id, version: '1.0.0', hostApiVersion: 6, apiVersion: 1,
  name: id, description: 'Synthetic SDK compatibility package', icon: 'box', pages: [], entries: [], ...extra });

test('API6 exposes task JSON helpers through the existing server-only HTTP security capability', async () => {
  assert.equal(HOST_PLUGIN_API_VERSION, 6);
  const capability = pluginSdkImports['@flaretune/plugin-sdk/server/http-security'];
  assert.deepEqual(capability, { target: 'server/src/plugins/sdk/http-security.js', side: 'server' });
  assert.equal(allowsPluginImport('server', capability.side), true);
  assert.equal(allowsPluginImport('client', capability.side), false);
  assert.equal(allowsPluginImport('shared', capability.side), false);
  const sdk = await import(new URL('../../' + capability.target, import.meta.url));
  assert.equal(typeof sdk.readBoundedJson, 'function', 'the prior public export remains available');
  let calls = 0;
  const response = sdk.jsonTaskResponse(async () => { calls++; return { ok: true, data: { complete: true } }; });
  assert.match(response.headers.get('Content-Type'), /^application\/json/u);
  assert.deepEqual(await response.json(), { ok: true, data: { complete: true } }); assert.equal(calls, 1);
  const ordinary = Response.json({ error: 'CONFLICT' }, { status: 409 });
  assert.equal(await sdk.deferredJsonTaskResponse(async () => ordinary), ordinary, 'ordinary responses retain their status');
  const started = await sdk.deferredJsonTaskResponse(async ({ onStart }) => { onStart(); return { ok: true, data: 'finished' }; });
  assert.deepEqual(await started.json(), { ok: true, data: 'finished' });
});

test('API6 dependency resolution accepts new workbench and unchanged consumers while API7 remains incompatible', () => {
  const gateway = manifest('ai-gateway', { version: '0.2.3' });
  const workbench = manifest('lyrics-workbench', { version: '1.1.0', optionalDependencies: {
    'ai-gateway': { apiVersion: 1, version: '^0.2.3', features: ['ai'] },
  } });
  const assistant = manifest('assistant', { hostApiVersion: 3, dependencies: { 'ai-gateway': { apiVersion: 1, version: '^0.2.0' } } });
  const items = [gateway, workbench, assistant], installed = items.map(item => item.id);
  for (const item of items) assert.equal(resolvePluginAvailability(items, installed, item.id).available, true, item.id);
  assert.equal(satisfiesPluginVersion('0.2.2', '^0.2.3'), false);
  assert.equal(satisfiesPluginVersion('0.2.3', '^0.2.3'), true);
  assert.equal(satisfiesPluginVersion('0.2.3', '^0.2.0'), true);
  const future = manifest('future', { hostApiVersion: 7 });
  assert.equal(resolvePluginAvailability([future], ['future'], 'future').reason, 'host_incompatible');
});
