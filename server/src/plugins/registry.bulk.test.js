import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';
import { createPluginRegistry, installationKey } from './registry.js';
import { migrationChecksum, migrationKey } from './migrations.js';

const manifest = (id, extra = {}) => ({ id, version: '1.2.0', hostApiVersion: 1, apiVersion: 1,
  name: id, description: 'Bulk lease fixture', icon: 'box', pages: [], entries: [], ...extra });
async function setup(t) {
  const f = await fixture(); t.after(f.close);
  const statements = ['CREATE TABLE plugin_gateway__fixture (id TEXT PRIMARY KEY)'];
  const migrations = [{ version: 1, statements, checksum: await migrationChecksum(statements) }];
  const manifests = [manifest('gateway', { dataVersion: 1 }),
    manifest('bridge', { dependencies: { gateway: { apiVersion: 1, version: '^1.0.0' } } }),
    manifest('consumer', { dependencies: { bridge: { apiVersion: 1 } } }),
    manifest('optional', { optionalDependencies: { gateway: { apiVersion: 1, features: ['ai'] } } })];
  const modules = { gateway: { migrations } };
  const registry = createPluginRegistry({ manifests, modules, deployment: null });
  for (const id of ['gateway', 'bridge', 'consumer', 'optional']) await registry.setInstalled(f.env, f.signed.session, id, { installed: true, revision: 0 });
  return { ...f, registry, manifests, modules };
}

test('bulk service installation reads one snapshot and returns requested plugins plus recursive required epochs', async t => {
  const f = await setup(t); const before = f.db.queries.length;
  const result = await f.registry.requirePluginsInstalled(f.env, ['consumer', 'optional']);
  assert.equal(f.db.queries.length - before, 1);
  assert.deepEqual([...result.keys()], ['consumer', 'bridge', 'gateway', 'optional']);
  for (const [id, installed] of result) {
    assert.equal(installed.epoch, JSON.parse(f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(installationKey(id)).value_json).epoch);
  }
  assert.deepEqual([...(await f.registry.requirePluginsInstalled(f.env, ['optional'])).keys()], ['optional']);
  await assert.rejects(f.registry.requirePluginsInstalled(f.env, []), { code: 'invalid_input' });
  await assert.rejects(f.registry.requirePluginsInstalled(f.env, ['missing']), { code: 'PLUGIN_NOT_FOUND' });
});

test('bulk availability preserves missing dependency, migration checksum, API/version and delivery gates', async t => {
  const f = await setup(t);
  f.sqlite.exec('SAVEPOINT bulk_gate');
  f.sqlite.prepare('DELETE FROM instance_settings WHERE key=?').run(installationKey('gateway'));
  await assert.rejects(f.registry.requirePluginsInstalled(f.env, ['consumer']), { code: 'PLUGIN_UNAVAILABLE' });
  f.sqlite.exec('ROLLBACK TO bulk_gate');
  f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(JSON.stringify({ completed: [{ version: 1, checksum: 'wrong' }] }), migrationKey('gateway'));
  await assert.rejects(f.registry.requirePluginsInstalled(f.env, ['consumer']), { code: 'PLUGIN_UNAVAILABLE' });
  f.sqlite.exec('ROLLBACK TO bulk_gate');
  const incompatible = createPluginRegistry({ manifests: f.manifests.map(item => item.id === 'gateway' ? { ...item, version: '2.0.0', apiVersion: 2 } : item), modules: f.modules, deployment: null });
  await assert.rejects(incompatible.requirePluginsInstalled(f.env, ['consumer']), { code: 'PLUGIN_UNAVAILABLE' });
  const deployment = { buildId: 'fixture-build', planDigest: 'a'.repeat(64), plugins: [{ id: 'consumer' }] };
  const pending = createPluginRegistry({ manifests: f.manifests, modules: f.modules, deployment });
  await assert.rejects(pending.requirePluginsInstalled(f.env, ['consumer']), error => error.publicDetails?.availability.reason === 'deployment_pending');
  f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES ('plugin.delivery.v1',?,1,1,'test')`).run(JSON.stringify({ activeDeployment: { buildId: deployment.buildId, planDigest: deployment.planDigest } }));
  assert.equal((await pending.requirePluginsInstalled(f.env, ['consumer'])).size, 3);
  f.sqlite.exec('ROLLBACK TO bulk_gate; RELEASE bulk_gate');
});
