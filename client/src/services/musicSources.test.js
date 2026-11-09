import assert from 'node:assert/strict';
import test from 'node:test';
import { getMusicSourcesRevision, notifyMusicSourcesChanged, subscribeMusicSources } from './musicSources.js';
import { readCatalog, readAlbum, peekCachedAlbum } from './catalogRead.js';

test('source invalidation notifies current subscribers without retaining data or firing retired subscribers', () => {
  const seen=[],start=getMusicSourcesRevision();
  const unsubscribe=subscribeMusicSources(value=>seen.push(value));
  notifyMusicSourcesChanged(); assert.deepEqual(seen,[start+1]);
  unsubscribe(); notifyMusicSourcesChanged(); assert.deepEqual(seen,[start+1]);
});

test('source invalidation carries optional plugin identity without changing the legacy revision argument', () => {
  const seen=[],start=getMusicSourcesRevision();
  const stop=subscribeMusicSources((value,pluginId)=>seen.push([value,pluginId]));
  notifyMusicSourcesChanged('first-source');
  notifyMusicSourcesChanged('second-source');
  notifyMusicSourcesChanged();
  assert.deepEqual(seen,[[start+1,'first-source'],[start+2,'second-source'],[start+3,undefined]]);
  stop();
});

test('an old mixed search response cannot reintroduce YouTube after a source change', async () => {
  const before=globalThis.fetch;let reply;
  globalThis.fetch=()=>new Promise(resolve=>{reply=resolve;});
  try {
    const request=readCatalog('songs',{query:'Same'});
    notifyMusicSourcesChanged();
    reply(new Response(JSON.stringify({data:{songs:[{id:'yt:QBtVFL0Qefs',audio_url:'/media/youtube/audio/QBtVFL0Qefs'}]}})));
    await assert.rejects(request,{name:'AbortError'});
  } finally {globalThis.fetch=before;}
});

test('expired source responses do not refill the YouTube album cache while local album reads remain valid', async () => {
  const before=globalThis.fetch;let reply;
  globalThis.fetch=()=>new Promise(resolve=>{reply=resolve;});
  try {
    const id='yt:album:MPREb_revisiontest';
    const yt=readAlbum(id);notifyMusicSourcesChanged();
    reply(new Response(JSON.stringify({data:{title:'Old YT album',songs:[]}})));
    await assert.rejects(yt,{name:'AbortError'});assert.equal(peekCachedAlbum(id),null);
    const local=readAlbum('local-revision-test');notifyMusicSourcesChanged();
    reply(new Response(JSON.stringify({data:{title:'Local album',songs:[]}})));
    assert.equal((await local).title,'Local album');
  } finally {globalThis.fetch=before;}
});
