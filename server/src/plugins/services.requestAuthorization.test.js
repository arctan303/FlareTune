import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../routes/localAssistant.fixture.js';
import { createPluginRegistry } from './registry.js';
import { createPluginOperationLease, createPluginServiceLease } from './services.js';
import { createServiceConfigGuard, bindServiceConfiguration } from './serviceConfig.js';
import { createRequestEnvironment, authorizeRequestEnvironment, bindRequestResponse } from '../services/requestAuthorization.js';
const manifest = (id, extra = {}) => ({ id, name: id, description: id, icon: 'settings', version: '0.1.0', hostApiVersion: 1,
  apiVersion: 1, capabilityRoles: ['admin', 'member'], pages: [], entries: [], ...extra });
function setup(t) {
  const f = fixture(); t.after(() => f.sqlite.close());
  const registry = createPluginRegistry({ deployment: null, manifests: [manifest('assistant', { optionalDependencies: { 'ai-gateway': { apiVersion: 1 } },
    serviceConfigurations: { 'ai-gateway': ['ai-model'] } }), manifest('ai-gateway')] });
  const session = f.session('account-A'); let count = 0;
  const prepare = f.db.prepare.bind(f.db), batch = f.db.batch.bind(f.db);
  f.db.prepare = sql => { const s = prepare(sql); for (const m of ['first','all','run']) { const run = s[m]; s[m] = (...args) => { count++; return run.apply(s,args); }; } return s; };
  f.db.batch = statements => { count++; return batch(statements); };
  const env = createRequestEnvironment({ DB: f.db }, new Request('https://example.test/api/lyrics'));
  authorizeRequestEnvironment(env, session);
  return { ...f, env, session, registry, count: () => count };
}
test('an accepted request does not repeat account queries while its model runs', async t => {
  const f = setup(t), lease = await createPluginOperationLease({ ...f, pluginId: 'assistant', authorization: 'request' });
  const before = f.count();
  f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), f.session.tokenHash);
  for (let n = 0; n < 50; n++) await lease.assertCurrent();
  assert.equal(f.count(), before);
  const next = createRequestEnvironment({ DB: f.db }, new Request('https://example.test/api/lyrics'));
  await assert.rejects(createPluginOperationLease({ ...f, env: next, pluginId: 'assistant', authorization: 'request' }));
  await bindRequestResponse(f.env, new Response('done')).text();
  await assert.rejects(lease.assertCurrent(), { name: 'AbortError' });
});
test('model configuration is checked once and does not poll during an accepted request', async t => {
  const f = setup(t);
  f.sqlite.prepare("INSERT OR REPLACE INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES('plugin.data.assistant.instance.ai-model','{}',1,1,'fixture')").run();
  const serviceLease = await createPluginServiceLease({ ...f, consumerId: 'assistant', providerId: 'ai-gateway', authorization: 'request' });
  const input = { ...f, consumerId: 'assistant', serviceLease };
  const authority = bindServiceConfiguration(input, { revision: 1, guard: createServiceConfigGuard(input) });
  await authority.assertCurrent(); const before = f.count();
  f.sqlite.prepare("UPDATE instance_settings SET revision=2 WHERE key='plugin.data.assistant.instance.ai-model'").run();
  for (let n = 0; n < 50; n++) await authority.assertCurrent();
  assert.equal(f.count(), before);
  await authority.guardedDb().prepare('SELECT 1 AS value').first(); assert.equal(f.count(), before + 1);
});
