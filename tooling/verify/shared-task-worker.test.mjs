import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Controlled handler completion is the established failure mechanism. This
// does not claim to reproduce a historical production HTTP disconnection.
test('shared source, schema/columns and R2 asset survive an owner finishing early', { timeout: 45_000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import {createSingleFlightDocumentFetcherCore} from './server/src/services/lyricSourceCache.js';
    import {readSchemaInventory} from './server/src/instance/schemaInventory.js';
    import {readOrCreateLyricArtifact} from './server/src/services/lyricAssetWorkflow.js';
    const wrapped = new WeakMap();
    const assetCalls = {};
    const source = createSingleFlightDocumentFetcherCore(async (provider,song,{signal}) => {
      const response = await fetch('https://upstream.invalid/'+song.id,{signal}); return response.text();
    },{optionsKey:()=>'',createAbortError:()=>new DOMException('Canceled','AbortError')});
    export default {async fetch(request,env,ctx) {
      const url = new URL(request.url); const mode = url.searchParams.get('mode');
      const key = url.searchParams.get('key');
      const cancel = Number(url.searchParams.get('cancel') || 0);
      const controller = new AbortController();
      if (cancel) setTimeout(()=>controller.abort(),cancel);
      try {
        let task;
        if (mode === 'source') task = source('kugou',{id:key},{signal:controller.signal,executionContext:ctx});
        else if (mode === 'asset') task = readOrCreateLyricArtifact({
          env, song:{id:key,title:'Local',artist:'Fixture',language:'en'},
          signal:controller.signal, executionContext:ctx,
          fetchDocument:async (provider) => { assetCalls[provider]=(assetCalls[provider]||0)+1; await new Promise(r=>setTimeout(r,250));
            return {source:'kugou',format:'lrc',syncMode:'line',lines:[{time:1,text:'Fixture lyrics'}]}; },
        }).then(r=>({state:r.state,status:r.artifact?.status,assetCalls}));
        else {
          let db = wrapped.get(env.DB);
          if (!db) { db = {prepare:sql=>({async all(){
            await new Promise(r=>setTimeout(r,150)); return env.DB.prepare(sql).all();
          }})}; wrapped.set(env.DB,db); }
          task = (async()=>{
            const inventory = await readSchemaInventory(db,Number(key),true,ctx);
            if (mode === 'columns') return (await inventory.playlistColumns(ctx)).results.map(r=>r.name);
            return inventory.schema.results.map(r=>r.name);
          })();
          if (cancel) task = Promise.race([task,new Promise((_,reject)=>{
            controller.signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true});
          })]);
        }
        return Response.json({value:await task});
      } catch (error) { return Response.json({error:error.name},{status:499}); }
    }};` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  let sourceCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name:'shared-task',
    modules:true, script:bundle.outputFiles[0].text, compatibilityDate:'2026-09-23',
    d1Databases:['DB'], r2Buckets:['MEDIA_BUCKET'],
    outboundService:async()=>{sourceCalls++; await new Promise(r=>setTimeout(r,250)); return new Response('Fixture lyrics');},
  }] }));
  try {
    const {DB, MEDIA_BUCKET} = await mf.getBindings('shared-task');
    await DB.prepare('CREATE TABLE Member_Playlists(id TEXT PRIMARY KEY, cached_song_count INTEGER)').run();
    const call = async params => {
      const response = await mf.dispatchFetch('https://local/?'+new URLSearchParams(params),{signal:AbortSignal.timeout(3000)});
      return {status:response.status,body:await response.json()};
    };
    for (const [mode,key] of [['source','source-1'],['schema','1000'],['columns','62000'],['asset','asset-1']]) {
      const owner = call({mode,key,cancel:'80'});
      await new Promise(r=>setTimeout(r,25));
      const waiter = call({mode,key});
      const [first,second] = await Promise.all([owner,waiter]);
      assert.equal(first.status,499,mode);
      assert.equal(second.status,200,JSON.stringify({mode,second}));
      if (mode === 'source') { assert.equal(second.body.value,'Fixture lyrics'); assert.equal(sourceCalls,1); }
      if (mode === 'schema') assert.ok(second.body.value.includes('Member_Playlists'));
      if (mode === 'columns') assert.ok(second.body.value.includes('cached_song_count'));
      if (mode === 'asset') {
        assert.equal(second.body.value.status,'ready');
        assert.ok(Object.values(second.body.value.assetCalls).every(n=>n===1));
        assert.ok((await MEDIA_BUCKET.list()).objects.length===1);
        const cached = await call({mode,key});
        assert.equal(cached.body.value.status,'ready');
        assert.deepEqual(cached.body.value.assetCalls,second.body.value.assetCalls);
      }
    }
  } finally { await mf.dispose(); }
});
