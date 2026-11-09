import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';
import { createPluginRegistry } from './registry.js';
import { handlePluginApi } from '../routes/plugins.js';

const manifest = { id: 'external-sample', version: '1.0.0', hostApiVersion: 2, apiVersion: 1,
  name: 'External sample', description: 'Selected entry fixture', icon: 'box', pages: [], entries: [], capabilityRoles: ['admin', 'member'] };
const json = (body, status = 200) => Response.json(body, { status });
test('selected entry receives the live registry, execution context and source dependencies', async t => {
  const f = await fixture(); t.after(f.close);
  const registry = createPluginRegistry({ manifests: [manifest], deployment: null });
  await registry.setInstalled(f.env, f.signed.session, manifest.id, { installed: true, revision: 0 });
  const executionContext = { waitUntil() {} }, source = async () => null;
  let called = 0;
  const modules = { fixture: { createLyricDependencies(env, session, ctx) {
    assert.equal(env, f.env); assert.equal(session, f.signed.session); assert.equal(ctx, executionContext);
    return { fetchNativeDocument: source };
  } }, [manifest.id]: { createHandler(env, session, options) {
    assert.equal(options.registry, registry); assert.equal(options.executionContext, executionContext);
    assert.equal(options.dependencies.fetchNativeDocument, source);
    return async ({ context }) => { await context.requireRoles(['admin']); called++; return json({ selected: true }); };
  } } };
  const path = '/api/account/plugins/external-sample/read';
  const response = await handlePluginApi(new Request('https://test.example' + path), path, f.env, f.signed.session, json,
    { registry, modules, executionContext });
  assert.equal(response.status, 200); assert.equal(called, 1);
  const missing = await handlePluginApi(new Request('https://test.example' + path), path, f.env, f.signed.session, json,
    { registry, modules: {}, executionContext });
  assert.equal(missing.status, 404); assert.equal(called, 1);
});
