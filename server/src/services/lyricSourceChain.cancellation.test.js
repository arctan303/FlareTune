import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../routes/localAssistant.fixture.js';
import { createPluginRegistry } from '../plugins/registry.js';
import { createPluginServiceLease } from '../plugins/services.js';
import { createLyricDocument } from '../utils/lyricDocument.js';
import { createLyricSources, selectLyricSource } from './lyricSourceChain.js';
import { guardStoreAuthority } from './storeAuthority.js';

const manifest = (id, dependencies = {}) => ({ id, name: id, description: id,
  icon: 'settings', version: '0.1.0', hostApiVersion: 1, apiVersion: 1,
  capabilityRoles: ['admin', 'member'], dependencies, pages: [], entries: [] });
const value = () => ({ quality: 'good', document: createLyricDocument({ source: 'manual',
  format: 'plain', lines: [{ text: 'Synthetic test line' }] }),
  translation: { supported: false, state: 'unavailable' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function pausedAdoption(t, timeoutMs = 1000) {
  const f = fixture(); t.after(() => f.sqlite.close());
  const session = f.session('account-A'), env = { DB: f.db };
  const registry = createPluginRegistry({ deployment: null, manifests: [
    manifest('assistant', { 'ai-gateway': { apiVersion: 1 } }), manifest('ai-gateway'),
  ] });
  const lease = await createPluginServiceLease({ env, session, registry,
    consumerId: 'assistant', providerId: 'ai-gateway' });
  const started = deferred(), resumed = deferred(), finished = deferred();
  let writes = 0, writeError;
  const sources = await createLyricSources({ env, session, deps: { registry,
    store: { get: async () => ({ state: 'missing', artifact: null }),
      putIfMatch: async () => { writes++; return { state: 'updated' }; } },
    modules: { assistant: { createLyricSource({ dependencies }) {
      dependencies.registerServiceAuthority(lease);
      const store = guardStoreAuthority(dependencies.store, lease.assertCurrent);
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
    writes: () => writes, writeError: () => writeError };
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
