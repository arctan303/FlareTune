import assert from 'node:assert/strict';
import test from 'node:test';
import { readCatalog, readArtist, readAlbum } from './catalogRead.js';

test('existing catalog transport preserves mixed source identity, server pagination and warnings', async () => {
  const original=globalThis.fetch, requests=[];
  const warnings=[{source:'youtube',code:'unavailable'}];
  globalThis.fetch=async (url,options)=>{
    requests.push({url,options});
    return new Response(JSON.stringify({data:{songs:[
      {id:'local',title:'Same',audio_url:'audio/local.mp3'},
      {id:'yt:QBtVFL0Qefs',title:'Same',source:'youtube',audio_url:'/media/youtube/audio/QBtVFL0Qefs'},
    ],hasMore:false,nextOffset:40,sourceWarnings:warnings}}),{headers:{'Content-Type':'application/json'}});
  };
  try {
    const page=await readCatalog('songs',{query:'Same',offset:20,limit:20});
    assert.equal(page.items.length,2);
    assert.equal(page.items[1].audio_url,'/media/youtube/audio/QBtVFL0Qefs');
    assert.equal(page.nextOffset,40); assert.equal(page.hasMore,false);
    assert.deepEqual(page.sourceWarnings,warnings);
    assert.match(requests[0].url,/offset=20/);
    assert.equal(requests[0].options.credentials,'include');
  } finally { globalThis.fetch=original; }
});

test('existing detail transport encodes YouTube ids without treating them as local numeric ids', async () => {
  const original=globalThis.fetch, requests=[];
  globalThis.fetch=async url=>{
    requests.push(url);
    return new Response(JSON.stringify({data:{name:'Artist',title:'Album',songs:[],albums:[{id:'yt:album:MPREb_a'}]}}),{headers:{'Content-Type':'application/json'}});
  };
  try {
    const artist=await readArtist('yt:artist:UCtest');
    assert.equal(artist.albums[0].id,'yt:album:MPREb_a');
    await readAlbum('yt:album:MPREb_test');
    assert.match(requests[0],/artists\/yt%3Aartist%3AUCtest/);
    assert.match(requests[1],/albums\/yt%3Aalbum%3AMPREb_test/);
  } finally { globalThis.fetch=original; }
});
