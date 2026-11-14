import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePluginSeed, validatePluginSeed } from './seed.mjs';
import { materializePluginArtifacts } from './assemble.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const manifest = {id:'example',version:'1.0.0',hostApiVersion:2,apiVersion:1,
    name:'Example',description:'A synthetic package',icon:'puzzle',pages:[],entries:[]};
  const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
  const artifact = {schemaVersion:2,manifest,entries:{server:'server/index.js'},
    files:{'server/index.js':"throw new Error('package must not execute'); export const alive = true;"},
    exports:{'server/index.js':'server/index.js'},
    assets:{'server/runtime.wasm':{encoding:'base64',data:wasm.toString('base64'),size:wasm.length,sha256:sha(wasm)}}};
  const bytes = Buffer.from(JSON.stringify(artifact));
  const entry = {id:manifest.id,version:manifest.version,manifest,source:{type:'artifact',id:'official',sha256:sha(bytes),
    url:`https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/${'a'.repeat(40)}/artifacts/example/1.0.0/${sha(bytes)}.json`}};
  return {artifact,bytes,entry,wasm,seed:{schemaVersion:1,plugins:[entry]}};
}

test('seed accepts only immutable, hash-bound official packages without a deployment receipt', () => {
  const {seed} = fixture(); assert.equal(validatePluginSeed(seed),seed);
  for (const mutate of [s=>s.plugins[0].source.url=s.plugins[0].source.url.replace('a'.repeat(40),'main'),
    s=>s.plugins[0].source.url=s.plugins[0].source.url.replace('raw.githubusercontent.com','evil.example'),
    s=>s.plugins[0].source.type='workspace', s=>s.buildId=crypto.randomUUID(),
    s=>s.plugins.push(structuredClone(s.plugins[0]))]) {
    const copy=structuredClone(seed);mutate(copy);assert.throws(()=>validatePluginSeed(copy));
  }
});

test('clean bootstrap hydrates binary files without executing packages; repeat builds preserve the selected composition', async t => {
  const root=await mkdtemp(resolve(tmpdir(),'flaretune-seed-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {seed,bytes,entry,wasm}=fixture();let requests=0;
  const fetchImpl=async(url,options)=>{requests++;assert.equal(url,entry.source.url);assert.equal(options.redirect,'error');return new Response(bytes);};
  const result=await preparePluginSeed({root,seed,fetchImpl,bootstrap:true});assert.equal(result.pluginDeployment,null);assert.equal(requests,1);
  assert.deepEqual(await readFile(resolve(root,'shared/plugins/.delivery/example',entry.source.sha256,'server/runtime.wasm')),wasm);
  const removed={buildId:crypto.randomUUID(),planDigest:'b'.repeat(64),host:{version:'1.0.0',sourceDigest:'c'.repeat(64)},plugins:[]};
  await materializePluginArtifacts({root,artifacts:[],pluginDeployment:removed});
  const before=await readFile(resolve(root,'shared/plugins/delivery.generated.js'),'utf8');
  await preparePluginSeed({root,seed,fetchImpl});assert.equal(requests,1,'A hash-verified cache avoids repeat downloads');
  assert.equal(await readFile(resolve(root,'shared/plugins/delivery.generated.js'),'utf8'),before,'Hydrating must not restore removed plugins or overwrite the active receipt');
});

test('wire digest failure rejects bootstrap before selecting a package', async t => {
  const root=await mkdtemp(resolve(tmpdir(),'flaretune-seed-bad-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {seed}=fixture();
  await assert.rejects(()=>preparePluginSeed({root,seed,bootstrap:true,fetchImpl:async()=>new Response('{}')}),{code:'PLUGIN_ARTIFACT_DIGEST_MISMATCH'});
  await assert.rejects(readFile(resolve(root,'shared/plugins/delivery.generated.js')),{code:'ENOENT'});
});

test('seed hydration completes for file-URL roots with a trailing separator', { timeout: 10000 }, async t => {
  const root=await mkdtemp(resolve(tmpdir(),'flaretune-seed-trailing-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {seed,bytes}=fixture();
  const code=`import {preparePluginSeed} from ${JSON.stringify(new URL('./seed.mjs',import.meta.url).href)};
    const result=await preparePluginSeed({root:${JSON.stringify(root+sep)},seed:${JSON.stringify(seed)},
      fetchImpl:async()=>new Response(Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'))});
    process.stdout.write(String(result.hydrated));`;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{windowsHide:true,timeout:5000});
  assert.equal(result.stdout,'true');
});
