import test from 'node:test';
import assert from 'node:assert/strict';
import { guardExternalLyricStore } from './playbackLyrics.js';
import { guardStoreAuthority } from './storeAuthority.js';

test('local late lyric writes are rejected after the song is removed even when its object remains', async()=>{
  let live=true, writes=0, reads=0, checks=0;
  const original={text:'original'};
  const store={get:async()=>{reads++;return original;}, putIfMatch:async()=>{writes++;return {state:'updated'};}};
  const guarded=guardExternalLyricStore(store,'local-song',async()=>{checks++;return live;});
  assert.equal(await guarded.get('local-song'),original);
  assert.equal(checks,0,'ordinary local reads retain the existing lookup budget');
  await guarded.putIfMatch('local-song',{},'v1'); assert.equal(writes,1);
  live=false;
  await assert.rejects(guarded.putIfMatch('local-song',{},'v1'),/no longer available/);
  assert.equal(writes,1);assert.equal(reads,1);
});

test('a later AI service lease wrapper preserves the local song existence write guard', async()=>{
  let writes=0;
  const source=guardExternalLyricStore({putIfMatch:async()=>{writes++;}},'local-song',async()=>false);
  const guarded=guardStoreAuthority(source,async()=>{});
  await assert.rejects(guarded.putIfMatch('local-song',{},'v1'),/no longer available/);
  assert.equal(writes,0);
});
