import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LYRIC_SOURCES, normalizeLyricSources, validateLyricEndpoint, lyricSourceLabel } from '../../../shared/lyricSources.js';
import { createLyricSourceLoader, fetchLyricsDocumentWithFallback } from './lyricSourceLoader.js';
import { lyricSourceLoaderForDb } from './lyricSourcesConfig.js';
import { TEST_LYRIC_SOURCES } from '../test/lyricSourceConfigFixtures.js';
import { makeReadyArtifact } from '../test/lyricAssetFixtures.js';
import { validateLyricArtifact } from './lyricArtifactStore.js';
import { handleLocalLyricsManageRoute } from '../routes/localLyricsManage.js';

const song = { id: 's1', title: 'Song', artist: 'Artist', duration: 200 };
test('defaults query only LRCLIB; unconfigured adapters never fetch', async () => {
  const calls = [];
  const loader = createLyricSourceLoader({ fetchImpl: async (url, init) => {
    calls.push(new URL(url)); assert.equal(init.redirect, 'error');
    return Response.json(new URL(url).pathname.endsWith('/get') ? {id:1,trackName:'Song',artistName:'Artist',duration:200,syncedLyrics:'[00:01.00]Hello'} : []);
  } });
  assert.deepEqual(loader.enabledSources, ['lrclib']);
  const doc = await fetchLyricsDocumentWithFallback('auto', song, loader.fetchSourceDocument, {enabledSources: loader.enabledSources});
  assert.equal(doc.source,'lrclib'); assert.ok(calls.length > 0); assert.ok(calls.every(url => url.hostname === 'lrclib.net'));
  const before = calls.length;
  for (const source of ['custom_krc','custom_lrc']) for (const method of ['fetchSourceDocument','listSourceCandidates','createCandidateInspectionSnapshot']) {
    await assert.rejects(loader[method](source,song),{kind:'unavailable'});
  }
  assert.equal(calls.length,before);
});
test('endpoint validation rejects local/literal/credential/redirect-injection input', () => {
  for(const url of ['http://lyrics.example.com','https://127.1/x','https://10.0.0.1/x','https://[::1]/x','https://localhost/x','https://x.local/x','https://x.internal/x','https://user:pass@lyrics.example.com/x','https://lyrics.example.com/x?token=secret','https://lyrics.example.com/x#x','https://lyrics.example.com:8443/x','https://lyrics.example.com\\@127.0.0.1/x']) assert.throws(()=>validateLyricEndpoint(url),undefined,url);
  assert.equal(validateLyricEndpoint('https://lyrics.example.com/search'),'https://lyrics.example.com/search');
  assert.throws(()=>normalizeLyricSources({...DEFAULT_LYRIC_SOURCES,custom_krc:{enabled:true}}));
});
test('configuration changes and different databases never share loaders or disabled-source caches', async () => {
  let settings = structuredClone(TEST_LYRIC_SOURCES);
  const db=()=>({prepare:()=>({first:async()=>({value_json:JSON.stringify(settings)})})});
  const first=db(), second=db();
  const a=await lyricSourceLoaderForDb(first);
  assert.equal(await lyricSourceLoaderForDb(first),a);
  assert.notEqual(await lyricSourceLoaderForDb(second),a);
  settings.custom_krc.enabled=false;
  const b=await lyricSourceLoaderForDb(first); assert.notEqual(a,b); assert.ok(!b.enabledSources.includes('custom_krc'));
});
test('members receive only enabled IDs; anonymous access and settings writes are refused', async () => {
  const db={prepare:()=>({first:async()=>({value_json:JSON.stringify(TEST_LYRIC_SOURCES)})})};
  const route=(method,session)=>{ const request=new Request('https://app.example.com/api/lyrics/sources',{method});return handleLocalLyricsManageRoute(request,new URL(request.url),db,{},session); };
  assert.equal((await route('GET',null)).status,401);
  const member={mode:'normal',account:{accountId:'member',role:'member'}};
  const response=await route('GET',member); assert.equal(response.status,200);
  const body=await response.json(); assert.deepEqual(body.data.sources,['custom_krc','custom_lrc','lrclib']); assert.doesNotMatch(JSON.stringify(body),/https|example\.com|searchUrl/);
  assert.equal((await route('PUT',member)).status,405);
});
test('old stored assets remain canonical and use neutral UI labels', () => {
  for (const source of ['kugou','netease']) {
    const asset=makeReadyArtifact(); asset.original.source=source; if(asset.translation) asset.translation.source=source;
    const validated=validateLyricArtifact(asset); assert.equal(validated.valid,true); assert.equal(validated.artifact.original.source,source);
    assert.match(lyricSourceLabel(source),/自定义/);
  }
});
