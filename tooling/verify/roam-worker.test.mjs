import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('production roam route reuses the directory across Worker requests and bounds tiny-catalog reads', async () => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import { handleLocalMusicDiscoveryRoute } from './server/src/routes/localMusicDiscovery.js';
    const bindings = new WeakMap(); let reads = 0, queries = 0;
    export default { async fetch(request, env) {
      if (new URL(request.url).pathname === '/metrics') return Response.json({ reads, queries });
      let db = bindings.get(env.DB);
      if (!db) {
        const wrap = statement => ({ bind: (...args) => wrap(statement.bind(...args)),
          async all() { const result = await statement.all(); reads += result.meta.rows_read; queries++; return result; } });
        db = { prepare: sql => wrap(env.DB.prepare(sql)) }; bindings.set(env.DB, db);
      }
      return handleLocalMusicDiscoveryRoute(request, new URL(request.url), db, {}, 'fixture');
    } };
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'roam-route', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-23', d1Databases: ['DB'],
    outboundService: () => { throw new Error('OUTBOUND_BLOCKED'); },
  }] }));
  try {
    const { DB } = await mf.getBindings('roam-route');
    const baseline = readFileSync('server/db/migrations-flaretune/0001_baseline.sql', 'utf8');
    await DB.prepare(baseline.match(/CREATE TABLE Songs \([\s\S]*?\n\);/)[0]).run();
    await DB.prepare(`INSERT INTO Songs(id,title,audio_url,language) VALUES ${Array.from({ length: 1000 }, (_, i) => `('s${i}','Song ${i}','/audio','en')`).join(',')}`).run();
    const call = async (payload = {}) => {
      const response = await mf.dispatchFetch('http://local/api/songs/roam', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strategy: 'recent',
          recentSongIds: [], queuedSongIds: [], limit: 10, ...payload }) });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    };
    const metrics = async () => (await mf.dispatchFetch('http://local/metrics')).json();
    assert.equal((await call()).recentWindow, 200);
    const cold = await metrics();
    assert.deepEqual(cold, { reads: 1020, queries: 2 });
    const recent = Array.from({ length: 1000 }, (_, i) => `s${i}`);
    const warm = await call({ recentSongIds: recent });
    assert.ok(warm.songs.every(s => Number(s.id.slice(1)) < 800));
    assert.deepEqual(await metrics(), { reads: 1040, queries: 3 });
    const full = await call({ queuedSongIds: recent });
    assert.equal(full.songs.length, 0);
    assert.equal(full.exhausted, false);
    assert.deepEqual(await metrics(), { reads: 1040, queries: 3 });
    await DB.prepare("UPDATE Songs SET language='ko' WHERE id IN ('s0','s1','s2')").run();
    // Returning stale details rebuilds the snapshot once; subsequent language
    // requests see the new range without a COUNT query.
    await call({ language: 'en', queuedSongIds: recent.slice(3) });
    const small = await call({ language: 'ko', queuedSongIds: ['s0'] });
    assert.deepEqual(new Set(small.songs.map(s => s.id)), new Set(['s1', 's2']));
    assert.equal(small.recentWindow, 0);
    assert.equal(small.exhausted, false);
  } finally { await mf.dispose(); }
});
