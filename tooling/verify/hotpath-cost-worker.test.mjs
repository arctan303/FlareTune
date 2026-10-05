import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { MIGRATION_BUNDLE } from '../../server/src/instance/migrationBundle.generated.js';

// Actual local workerd/D1 metadata, synthetic data only. No production billing
// or network-latency claims: compare the same SQL/data before and after 0013.
test('hotpaths bound real D1 read costs and preserve transaction results', { timeout: 90_000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import { querySongs } from './server/src/tools/searchSongs.js';
    import { handleLocalAccountMusicRoute } from './server/src/routes/localAccountMusic.js';
    import { invalidateSchemaInventory, readSchemaInventory } from './server/src/instance/schemaInventory.js';
    let metrics;
    const bindings = new WeakMap();
    function measured(native) {
      if (bindings.has(native)) return bindings.get(native);
      const capture = (sql, result) => { metrics.push({sql, read:result.meta.rows_read,
        written:result.meta.rows_written, changes:result.meta.changes}); return result; };
      function wrap(sql, actual) {
        return { actual, sql, bind(...args) { return wrap(sql, actual.bind(...args)); },
          async all() { return capture(sql, await actual.all()); },
          async run() { return capture(sql, await actual.run()); },
          async first() { return (await this.all()).results[0] || null; } };
      }
      const db = { prepare(sql) { return wrap(sql, native.prepare(sql)); },
        async batch(statements) { const results = await native.batch(statements.map(s => s.actual));
          return results.map((r,i) => capture(statements[i].sql, r)); } };
      bindings.set(native, db); return db;
    }
    export default { async fetch(request, env) {
      metrics = []; const db = measured(env.DB); const input = await request.json();
      let data;
      if (input.op === 'search') data = await querySongs(db, 'zzzznotfound', 20, 0);
      else if (input.op === 'plays') {
        const response = await handleLocalAccountMusicRoute(new Request('https://local/api/account/play-stats', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({events:input.events})
        }), new URL('https://local/api/account/play-stats'), db, {}, {accountId:'fixture',mode:'normal'});
        data = { status:response.status, body:await response.json() };
      } else if (input.op === 'reset') { invalidateSchemaInventory(db); data = true; }
      else if (input.op === 'prime') { await readSchemaInventory(db,Date.now(),true); data = true; }
      else data = await db.prepare(input.sql).bind(...(input.values || []))[input.method || 'all']();
      return Response.json({data, metrics, rowsRead:metrics.reduce((n,r)=>n+r.read,0),
        rowsWritten:metrics.reduce((n,r)=>n+r.written,0), queries:metrics.length});
    } };` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'hotpath-cost',
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-23',
    d1Databases: ['DB'], outboundService: () => { throw new Error('TEST_OUTBOUND_BLOCKED'); },
  }] }));
  const costs = {};
  try {
    const { DB: db } = await mf.getBindings('hotpath-cost');
    await db.batch(MIGRATION_BUNDLE.slice(0, 12).flatMap(m => m.statements).map(sql => db.prepare(sql)));
    await db.prepare(`INSERT INTO accounts(account_id,username,role,created_at,updated_at)
      VALUES ('fixture','fixture','admin',1,1)`).run();
    await db.prepare(`WITH RECURSIVE n(v) AS (SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<4999)
      INSERT INTO Songs(id,title,artist,album,audio_url,cover_url,language)
      SELECT printf('s%05d',v), 'かな' || printf('%05d',v), 'かな Artist ' || (v%10),
        'かな Album ' || (v%50), '/audio/local', '/cover/local', 'ja' FROM n`).run();
    await db.prepare(`WITH RECURSIVE n(v) AS (SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<9)
      INSERT INTO Member_Playlists(id,account_id,kind,name,created_at,updated_at)
      SELECT 'p'||v,'fixture','regular','List '||v,1,1 FROM n`).run();
    const call = async input => {
      const response = await mf.dispatchFetch('https://local/cost', {method:'POST',body:JSON.stringify(input)});
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const sql = (query, values = [], method = 'all') => call({sql:query, values, method});
    const members = id => `INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at)
      WITH RECURSIVE n(v) AS (SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<499)
      SELECT '${id}',printf('s%05d',v),v,v FROM n`;
    const beforeInsertion = await sql(members('p0'), [], 'run');
    costs.insertBefore = beforeInsertion.rowsRead;
    costs.insertWritesBefore = beforeInsertion.rowsWritten;
    for (let i=1; i<10; i++) await db.prepare(members('p'+i)).run();
    const count = expression => `SELECT p.id, ${expression} AS songCount FROM Member_Playlists p
      WHERE p.account_id=? AND p.kind='regular' ORDER BY p.created_at,p.id`;
    const beforeCounts = await sql(count('(SELECT COUNT(*) FROM Member_Playlist_Songs ps WHERE ps.playlist_id=p.id)'), ['fixture']);
    costs.initBefore = beforeCounts.rowsRead;
    const preview = `SELECT p.id, (SELECT json_group_array(cover_url) FROM (
      SELECT s.cover_url FROM Member_Playlist_Songs ps JOIN Songs s ON s.id=ps.song_id
      WHERE ps.playlist_id=p.id AND s.cover_url IS NOT NULL AND trim(s.cover_url)<>''
      ORDER BY ps.added_at DESC,ps.sort_order DESC,ps.song_id LIMIT 4)) AS covers
      FROM Member_Playlists p WHERE p.account_id=? ORDER BY p.id`;
    const beforePreview = await sql(preview, ['fixture']);
    costs.previewBefore = beforePreview.rowsRead;
    const optional = `SELECT id,title,artist FROM Songs WHERE (?='' OR title=?) AND (?='' OR artist=?) ORDER BY id LIMIT 1`;
    const beforeMatch = await sql(optional, ['かな04999','かな04999','かな Artist 9','かな Artist 9']);
    costs.lyricsBefore = beforeMatch.rowsRead;
    await db.batch(MIGRATION_BUNDLE[12].statements.map(query => db.prepare(query)));
    await call({op:'reset'});
    const afterCounts = await sql(count('p.cached_song_count'), ['fixture']);
    assert.deepEqual(afterCounts.data.results, beforeCounts.data.results);
    costs.initAfter = afterCounts.rowsRead;
    assert.ok(costs.initAfter <= 20 && costs.initBefore > 5000);
    const afterPreview = await sql(preview, ['fixture']);
    assert.deepEqual(afterPreview.data.results, beforePreview.data.results);
    costs.previewAfter = afterPreview.rowsRead;
    assert.ok(costs.previewAfter <= 150 && costs.previewBefore > 10000);
    const exact = await sql('SELECT id,title,artist FROM Songs WHERE title=? AND artist=? ORDER BY id LIMIT 1',
      ['かな04999','かな Artist 9']);
    assert.deepEqual(exact.data.results, beforeMatch.data.results);
    costs.lyricsAfter = exact.rowsRead;
    assert.ok(exact.rowsRead <= 2);
    for (const [field, value] of [['title','かな04999'], ['artist','かな Artist 9']]) {
      assert.ok((await sql('SELECT id,title,artist FROM Songs WHERE '+field+'=? ORDER BY id LIMIT 1',[value])).rowsRead <= 2);
    }
    await db.prepare(`INSERT INTO Member_Playlists(id,account_id,kind,name,created_at,updated_at)
      VALUES ('pilot','fixture','regular','Pilot',1,1)`).run();
    const insertion = await sql(members('pilot'), [], 'run');
    costs.insertAfter = insertion.rowsRead;
    costs.insertWritesAfter = insertion.rowsWritten;
    assert.ok(costs.insertAfter <= 1600 && costs.insertBefore > 100000, JSON.stringify(costs));
    assert.equal((await db.prepare("SELECT cached_song_count AS n FROM Member_Playlists WHERE id='pilot'").first()).n,500);
    const search = await call({op:'search'});
    assert.deepEqual(search.data, []);
    costs.searchRead = search.rowsRead; costs.searchQueries = search.queries;
    assert.ok(search.queries <= 8, JSON.stringify(costs));
    assert.ok(search.rowsRead <= 20000, JSON.stringify(costs));
    await call({op:'prime'});
    const at = Date.now();
    async function seedEvents(from, to) {
      await db.prepare(`WITH RECURSIVE n(v) AS (SELECT ? UNION ALL SELECT v+1 FROM n WHERE v<?)
        INSERT INTO Member_Play_Events(account_id,event_id,song_id,played_at,received_at)
        SELECT 'fixture','seed-'||v,'s00000',?,? FROM n`).bind(from,to-1,at,at).run();
    }
    await seedEvents(0,1000);
    const event = id => ({event_id:id,song_id:'s00000',played_at:at});
    const small = await call({op:'plays',events:[event('small')]});
    assert.equal(small.data.status,200); assert.equal(small.data.body.data.recorded,1);
    await seedEvents(1000,4999);
    const large = await call({op:'plays',events:[event('large')]});
    assert.equal(large.data.status,200); assert.equal(large.data.body.data.recorded,1);
    costs.quotaRead1000 = small.rowsRead; costs.quotaRead5000 = large.rowsRead;
    assert.ok(large.rowsRead <= 50 && large.rowsRead <= small.rowsRead);
    assert.equal((await db.prepare("SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id='fixture'").first()).receipt_count,5001);
    const duplicate = await call({op:'plays',events:[event('large')]});
    assert.equal(duplicate.data.body.data.recorded,0);
    await seedEvents(4999,9997);
    const contenders = await Promise.all(['race-a','race-b'].map(id => call({op:'plays',events:[event(id)]})));
    assert.deepEqual(contenders.map(r=>r.data.status).sort(),[200,429]);
    assert.equal(contenders.find(r=>r.data.status===200).data.body.data.recorded,1);
    assert.equal((await db.prepare("SELECT receipt_count FROM Member_Play_Receipt_Counts WHERE account_id='fixture'").first()).receipt_count,10000);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM Member_Play_Events WHERE account_id='fixture'").first()).n,10000);
    console.log('HOTPATH_D1_COSTS '+JSON.stringify(costs));
  } finally { await mf.dispose(); }
});
