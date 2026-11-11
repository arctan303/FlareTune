import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../routes/localAssistant.fixture.js';
import { createPluginRegistry } from '../plugins/registry.js';
import { createPluginServiceLease } from '../plugins/services.js';
import { createLyricDocument } from '../utils/lyricDocument.js';
import { createLyricSources, selectLyricSource } from './lyricSourceChain.js';
import { guardStoreAuthority } from './storeAuthority.js';
import { bindServiceConfiguration, createServiceConfigGuard } from '../plugins/serviceConfig.js';

const manifest = (id, dependencies = {}) => ({ id, name: id, description: id,
  icon: 'settings', version: '0.1.0', hostApiVersion: 1, apiVersion: 1,
  capabilityRoles: ['admin', 'member'], dependencies, pages: [], entries: [] });
const value = () => ({ quality: 'good', document: createLyricDocument({ source: 'manual',
  format: 'plain', lines: [{ text: 'Synthetic test line' }] }),
  translation: { supported: false, state: 'unavailable' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function pausedAdoption(t, timeoutMs = 1000, configurationBound = false) {
  const f = fixture(); t.after(() => f.sqlite.close());
  const session = f.session('account-A'), env = { DB: f.db };
  const registry = createPluginRegistry({ deployment: null, manifests: [
    { ...manifest('assistant', { 'ai-gateway': { apiVersion: 1 } }),
      serviceConfigurations: { 'ai-gateway': ['ai-model'] } }, manifest('ai-gateway'),
  ] });
  const lease = await createPluginServiceLease({ env, session, registry,
    consumerId: 'assistant', providerId: 'ai-gateway' });
  let assertion = lease.assertCurrent;
  if (configurationBound) {
    f.sqlite.exec("CREATE TABLE plugin_ai_gateway__source_profiles(id TEXT PRIMARY KEY,revision INTEGER); INSERT INTO plugin_ai_gateway__source_profiles VALUES('provider',1)");
    f.sqlite.prepare(`INSERT OR REPLACE INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      VALUES ('plugin.data.assistant.instance.ai-model','{}',1,1,'account-A')`).run();
    const request = { env, session, registry, serviceLease: lease, consumerId: 'assistant' };
    const guard = createServiceConfigGuard(request, { constraints: [{ table: 'plugin_ai_gateway__source_profiles',
      where: { id: 'provider' }, expected: { revision: 1 } }] });
    assertion = bindServiceConfiguration(request, { revision: 1, guard }).assertCurrent;
  }
  const started = deferred(), resumed = deferred(), finished = deferred();
  let writes = 0, writeError;
  const sources = await createLyricSources({ env, session, deps: { registry,
    store: { get: async () => ({ state: 'missing', artifact: null }),
      putIfMatch: async () => { writes++; return { state: 'updated' }; } },
    modules: { assistant: { createLyricSource({ dependencies }) {
      dependencies.registerServiceAuthority(lease);
      const store = guardStoreAuthority(dependencies.store, assertion);
      return { id: 'assistant', timeoutMs, claim: () => true,
        resolve: async () => ({ ...value(), onAdopt: async () => {
          started.resolve();
          // Deliberately ignore cancellation while preparing a write. The
          // host storage capability must still reject after interruption.
          await resumed.promise;
          try { await store.putIfMatch('test-song', {}, 'test-etag'); }
          catch (error) { writeError = error; }
          finally { finished.resolve(); }
          return value();
        } }) };
    } } } } });
  return { sources, started: started.promise, release: resumed.resolve, finished: finished.promise,
    writes: () => writes, writeError: () => writeError, sqlite: f.sqlite, session };
}

test('parent cancellation during adoption rejects selection and prevents the composed service store write', { timeout: 3000 }, async t => {
  const f = await pausedAdoption(t), controller = new AbortController();
  const selected = selectLyricSource({ sources: f.sources, order: ['assistant'],
    song: { id: 'test-song' }, signal: controller.signal, adopt: true });
  const rejected = assert.rejects(selected, { name: 'AbortError' });
  await f.started;
  controller.abort();
  f.release();
  await rejected;
  await f.finished;
  assert.equal(f.writes(), 0);
  assert.equal(f.writeError()?.name, 'AbortError');
});

test('adoption timeout selects the next source and prevents the interrupted source from writing later', { timeout: 3000 }, async t => {
  const f = await pausedAdoption(t, 50), diagnostics = [];
  const fallback = { id: 'fallback', claim: () => true, resolve: async () => value() };
  const selected = selectLyricSource({ sources: [...f.sources, fallback], order: ['assistant', 'fallback'],
    song: { id: 'test-song' }, adopt: true, onDiagnostic: row => diagnostics.push(row) });
  await f.started;
  assert.equal((await selected).source.id, 'fallback');
  assert.equal(f.writes(), 0);
  f.release();
  await f.finished;
  assert.equal(f.writes(), 0);
  assert.equal(f.writeError(), 'source_timeout');
  assert.deepEqual(diagnostics, [{ sourceId: 'assistant', code: 'LYRIC_SOURCE_INTERRUPTED' }]);
});

test('configuration-bound source stores keep cancellation and timeout fences after composing the stronger gate', { timeout: 3000 }, async t => {
  for (const interruption of ['cancel', 'timeout']) {
    const f = await pausedAdoption(t, interruption === 'timeout' ? 50 : 1000, true);
    const controller = new AbortController(), diagnostics = [];
    const fallback = { id: 'fallback', claim: () => true, resolve: async () => value() };
    const selected = selectLyricSource({ sources: [...f.sources, fallback], order: ['assistant', 'fallback'],
      song: { id: 'test-song' }, signal: controller.signal, adopt: true, onDiagnostic: row => diagnostics.push(row) });
    const cancelled = interruption === 'cancel' ? assert.rejects(selected, { name: 'AbortError' }) : null;
    await f.started;
    if (interruption === 'cancel') { controller.abort(); f.release(); await cancelled; }
    else { assert.equal((await selected).source.id, 'fallback'); f.release(); }
    await f.finished;
    assert.equal(f.writes(), 0, interruption);
    if (interruption === 'cancel') assert.equal(f.writeError()?.name, 'AbortError');
    else assert.equal(f.writeError(), 'source_timeout');
  }
});

test('configuration-bound source writes retain config, provider, session and both installation checks', async t => {
  for (const revoke of ['config', 'provider', 'session', 'consumer', 'gateway']) {
    const f = await pausedAdoption(t, 1000, true);
    const selected = selectLyricSource({ sources: f.sources, order: ['assistant'], song: { id: 'test-song' }, adopt: true });
    await f.started;
    if (revoke === 'config') f.sqlite.exec("UPDATE instance_settings SET revision=2 WHERE key='plugin.data.assistant.instance.ai-model'");
    else if (revoke === 'provider') f.sqlite.exec("UPDATE plugin_ai_gateway__source_profiles SET revision=2 WHERE id='provider'");
    else if (revoke === 'session') f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), f.session.tokenHash);
    else {
      const id = revoke === 'consumer' ? 'assistant' : 'ai-gateway';
      f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?')
        .run(JSON.stringify({ installed: true, epoch: crypto.randomUUID() }), `plugin.installation.${id}`);
    }
    f.release(); await selected.catch(() => {}); await f.finished;
    assert.equal(f.writes(), 0, revoke);
    assert.ok(f.writeError(), revoke);
    if (revoke === 'config' || revoke === 'provider') assert.equal(f.writeError().code, 'PLUGIN_SERVICE_CONFIGURATION_CHANGED');
  }
});
