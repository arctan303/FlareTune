import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Local workerd/D1 only. Verify binding identity actually permits cross-request
// reuse; an ordinary JS mock cannot establish this runtime property.
test('local workerd reuses D1 metadata across requests and refreshes at expiry', { timeout: 45_000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import { readSchemaInventory } from './server/src/instance/schemaInventory.js';
    let scans = 0;
    const bindings = new WeakSet();
    export default { async fetch(request, env) {
      if (!bindings.has(env.DB)) {
        bindings.add(env.DB);
        const original = env.DB.prepare.bind(env.DB);
        env.DB.prepare = (sql) => { if (sql.includes('sqlite_master')) scans++; return original(sql); };
      }
      const now = Number(new URL(request.url).searchParams.get('now'));
      const inventory = await readSchemaInventory(env.DB, now, true);
      return Response.json({ scans, tables: inventory.schema.results.filter(r => r.type === 'table').map(r => r.name) });
    } };` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'schema-cache-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-23', d1Databases: ['DB'],
    outboundService: () => { throw new Error('TEST_OUTBOUND_BLOCKED'); },
  }] }));
  try {
    const { DB: db } = await mf.getBindings('schema-cache-test');
    await db.prepare('CREATE TABLE before_expiry(id INTEGER)').run();
    const call = async (now) => (await mf.dispatchFetch(`http://local.test/?now=${now}`)).json();
    assert.equal((await call(1000)).scans, 1);
    await db.prepare('CREATE TABLE after_expiry(id INTEGER)').run();
    const warm = await Promise.all(Array.from({ length: 10 }, () => call(2000)));
    assert.ok(warm.every((r) => r.scans === 1 && !r.tables.includes('after_expiry')));
    const refreshed = await call(61000);
    assert.equal(refreshed.scans, 2);
    assert.ok(refreshed.tables.includes('after_expiry'));
  } finally { await mf.dispose(); }
});
