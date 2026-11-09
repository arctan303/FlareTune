import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { validatePluginArtifact, materializePluginArtifacts } from './assemble.mjs';
import { resolvePluginAvailability } from '../../shared/plugins/manifest.js';

const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=(id,extra={})=>({id,version:'1.0.0',hostApiVersion:2,apiVersion:1,name:id,description:'Synthetic package',
 icon:'puzzle',pages:[],entries:[],...extra});
const artifact=(id,extra={})=>({schemaVersion:2,manifest:manifest(id),entries:{server:'server/index.js'},
 files:{'server/index.js':'export function createHandler() { return () => true; }'},exports:{'server/index.js':'server/index.js'},assets:{},...extra});
const entry=item=>({id:item.manifest.id,version:item.manifest.version,manifest:item.manifest,
 source:{type:'artifact',id:'official',url:'https://packages.example.net/'+item.manifest.id+'.json',sha256:sha(JSON.stringify(item))}});
const wasm=Buffer.from([0,97,115,109,1,0,0,0]);

test('v2 validates hash-bound server Wasm and preserves SDK1 compatibility',()=>{
 const a=artifact('wasm-package');a.assets['server/runtime.wasm']={encoding:'base64',data:wasm.toString('base64'),size:wasm.length,sha256:sha(wasm)};
 a.files['server/index.js']="import wasm from './runtime.wasm'; export const module = wasm;";
 assert.equal(validatePluginArtifact(a,a.manifest),a);
 assert.equal(resolvePluginAvailability([manifest('old-package',{hostApiVersion:1})],['old-package'],'old-package').available,true);
 const legacy={schemaVersion:1,manifest:manifest('legacy',{hostApiVersion:1}),entries:{server:'server/index.js'},files:{'server/index.js':'export function createHandler() {}'}};
 assert.equal(validatePluginArtifact(legacy,legacy.manifest),legacy);
 const mislabeled=artifact('mislabeled',{manifest:manifest('mislabeled',{hostApiVersion:1})});
 assert.throws(()=>validatePluginArtifact(mislabeled,mislabeled.manifest),{code:'PLUGIN_ARTIFACT_HOST_API_MISMATCH'});
 for(const mutate of [x=>x.assets['server/runtime.wasm'].sha256='0'.repeat(64),x=>x.assets['server/runtime.wasm'].size++,
  x=>{x.assets['client/runtime.wasm']=x.assets['server/runtime.wasm'];delete x.assets['server/runtime.wasm'];}]){
   const bad=structuredClone(a);mutate(bad);assert.throws(()=>validatePluginArtifact(bad,bad.manifest));
 }
});

test('v2 keeps imports within side, SDK allowlist and declared provider boundaries',()=>{
 const a=artifact('consumer',{manifest:manifest('consumer',{optionalDependencies:{provider:{apiVersion:1,features:['service']}}})});
 a.files['server/index.js']="import { create } from '@flaretune/plugin-service/provider/server/client.js'; export { create };";
 assert.equal(validatePluginArtifact(a,a.manifest),a);
 const bad=structuredClone(a);delete bad.manifest.optionalDependencies;
 assert.throws(()=>validatePluginArtifact(bad,bad.manifest),{code:'PLUGIN_ARTIFACT_IMPORT_INVALID'});
 for(const source of ["import x from '@flaretune/plugin-sdk/private/store';", "import x from '@flaretune/plugin-sdk';",
  "import x from '../client/private.js';"]){const copy=structuredClone(a);copy.files['server/index.js']=source;copy.files['client/private.js']='export default 1;';assert.throws(()=>validatePluginArtifact(copy,copy.manifest),{code:'PLUGIN_ARTIFACT_IMPORT_INVALID'});}
});

test('bootstrap materializes binaries and selected-provider bridges without executing package code or inventing a build ID',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'flaretune-package-v2-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const provider=artifact('provider',{files:{'server/index.js':"throw new Error('must not execute at materialization'); export function create() { return true; }"}});
 const consumer=artifact('consumer',{manifest:manifest('consumer',{optionalDependencies:{provider:{apiVersion:1,features:['service']}}}),
 files:{'server/index.js':"import { create } from '@flaretune/plugin-service/provider/server/index.js'; export function use() { return create(); }"}});
 provider.assets['server/runtime.wasm']={encoding:'base64',data:wasm.toString('base64'),size:wasm.length,sha256:sha(wasm)};
 await mkdir(resolve(root,'tooling/plugins'),{recursive:true});
 await writeFile(resolve(root,'tooling/plugins/compatibility.json'),JSON.stringify({'legacy.js':{pluginId:'provider',publicKey:'server/index.js',exports:[{name:'create',kind:'function'}]}}));
 const first=await materializePluginArtifacts({root,artifacts:[{entry:entry(consumer),artifact:consumer}]});assert.equal(first.pluginDeployment,null);
 const bridge=resolve(root,'shared/plugins/.api/provider/server/index.js');assert.match(await readFile(bridge,'utf8'),/PLUGIN_NOT_COMPILED/);
 const consumerFile=resolve(root,'shared/plugins/.delivery/consumer',entry(consumer).source.sha256,'server/index.js');const before=await readFile(consumerFile,'utf8');
 await materializePluginArtifacts({root,artifacts:[{entry:entry(consumer),artifact:consumer},{entry:entry(provider),artifact:provider}]});
 assert.equal(await readFile(consumerFile,'utf8'),before,'Changing selected provider must not mutate immutable consumer bytes');
 assert.match(await readFile(bridge,'utf8'),new RegExp(entry(provider).source.sha256));
 assert.deepEqual(await readFile(resolve(root,'shared/plugins/.delivery/provider',entry(provider).source.sha256,'server/runtime.wasm')),wasm);
 const metadata=await readFile(resolve(root,'shared/plugins/delivery.generated.js'),'utf8');assert.match(metadata,/compiledPluginSources/);assert.doesNotMatch(metadata,/"buildId"/);
});
