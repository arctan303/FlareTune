import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { pluginBuilds } from '../../shared/plugins/build.generated.js';
import { bundleWorkerModules } from '../dev/bundle-worker-modules.mjs';

test('installed roam plugin gates both URLs, reuses its directory across Worker requests and bounds tiny-catalog reads', async () => {
  const buildDigest = pluginBuilds.find(plugin => plugin.id === 'roam')?.sourceDigest;
  assert.match(buildDigest || '', /^[a-f0-9]{64}$/u);
  const temporaryRoot = resolve('.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(resolve(temporaryRoot, 'roam-worker-'));
  const routePath = relative(directory, resolve('server/src/routes/plugins.js')).split(sep).join('/');
  let mf;
  try {
    const entryPoint = resolve(directory, 'worker.mjs');
    await writeFile(entryPoint, `
    import { handlePluginApi } from ${JSON.stringify(routePath)};
    const bindings = new WeakMap(); let reads = 0, queries = 0;
    const session = {mode:'normal',tokenHash:'a'.repeat(64),account:{accountId:'fixture',role:'admin'}};
    const json = (body,status=200) => Response.json(body,{status});
    export default { async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/metrics') return Response.json({ reads, queries });
      let db = bindings.get(env.DB);
      if (!db) {
        const wrap = (statement,sql) => ({ raw:statement, bind: (...args) => wrap(statement.bind(...args),sql),
          first: (...args) => statement.first(...args), run: (...args) => statement.run(...args),
          async all() { const result = await statement.all();
            if (/\\bFROM Songs\\b/u.test(sql)) { reads += result.meta.rows_read; queries++; }
            return result; } });
        db = { prepare: sql => wrap(env.DB.prepare(sql),sql),
          batch: statements => env.DB.batch(statements.map(statement => statement.raw)) };
        bindings.set(env.DB, db);
      }
      return await handlePluginApi(request,new URL(request.url).pathname,{...env,DB:db},session,json,{executionContext:ctx})
        || json({error:'not_found'},404);
    } };
  `);
    const bundled = await bundleWorkerModules({ esbuild, entryPoint });
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'roam-route', ...bundled,
      compatibilityDate: '2026-09-23', d1Databases: ['DB'],
      outboundService: () => { throw new Error('OUTBOUND_BLOCKED'); },
    }] }));
    const { DB } = await mf.getBindings('roam-route');
    const baseline = readFileSync('server/db/migrations-flaretune/0001_baseline.sql', 'utf8');
    for (const table of ['accounts', 'account_credentials', 'account_sessions', 'instance_settings', 'Songs']) {
      await DB.prepare(baseline.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`))[0]).run();
    }
    await DB.prepare("INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES('fixture','fixture','admin',1,1)").run();
    await DB.prepare(`INSERT INTO account_credentials(account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,updated_at)
      VALUES('fixture','pbkdf2-sha256-chain',2,'{"iterations":100000,"rounds":6}',?,?,1)`)
      .bind(Buffer.alloc(16, 1).toString('base64url'), Buffer.alloc(32, 2).toString('base64url')).run();
    await DB.prepare("INSERT INTO account_sessions(token_hash,account_id,mode,created_at,expires_at) VALUES(?,'fixture','normal',1,?)")
      .bind('a'.repeat(64), Date.now() + 60 * 60 * 1000).run();
    await DB.prepare(`INSERT INTO Songs(id,title,audio_url,language) VALUES ${Array.from({ length: 1000 }, (_, i) => `('s${i}','Song ${i}','/audio','en')`).join(',')}`).run();
    const paths = ['/api/account/plugins/roam/sample', '/api/songs/roam'];
    const request = (path, payload = {}, digest = buildDigest) => mf.dispatchFetch(`http://local${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(digest ? { 'X-FlareTune-Plugin-Build': digest } : {}) },
      body: JSON.stringify({ strategy: 'recent', recentSongIds: [], queuedSongIds: [], limit: 10, ...payload }) });
    const call = async (payload = {}, path = paths[0]) => {
      const response = await request(path, payload);
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    };
    const metrics = async () => (await mf.dispatchFetch('http://local/metrics')).json();
    const install = async (installed, revision) => {
      const response = await mf.dispatchFetch('http://local/api/admin/plugins/roam', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installed, revision }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).plugin.installed, installed);
    };
    for (const path of paths) {
      const response = await request(path);
      assert.equal(response.status, 409, await response.clone().text());
      assert.deepEqual(await response.json(), { error: 'PLUGIN_NOT_INSTALLED' });
    }
    assert.deepEqual(await metrics(), { reads: 0, queries: 0 });
    await install(true, 0);
    for (const path of paths) for (const digest of [null, 'old-build']) {
      const response = await request(path, {}, digest);
      assert.equal(response.status, 409, await response.clone().text());
      assert.deepEqual(await response.json(), { error: 'PLUGIN_BUILD_MISMATCH' });
    }
    assert.deepEqual(await metrics(), { reads: 0, queries: 0 });
    assert.equal((await call()).recentWindow, 200);
    const cold = await metrics();
    assert.deepEqual(cold, { reads: 1020, queries: 2 });
    const recent = Array.from({ length: 1000 }, (_, i) => `s${i}`);
    const warm = await call({ recentSongIds: recent }, paths[1]);
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
    const beforeUninstall = await metrics();
    await install(false, 1);
    for (const path of paths) {
      const response = await request(path);
      assert.equal(response.status, 409, await response.clone().text());
      assert.deepEqual(await response.json(), { error: 'PLUGIN_NOT_INSTALLED' });
    }
    assert.deepEqual(await metrics(), beforeUninstall, 'warm directory never bypasses uninstall');
  } finally {
    if (mf) await mf.dispose();
    assert.equal(dirname(directory), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  }
});
