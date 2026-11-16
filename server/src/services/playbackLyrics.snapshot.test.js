import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';
import { resolveLyricSong } from './playbackLyrics.js';
const song = { id: 'yt:PDNOBW6xYKM', source: 'youtube', sourceId: 'PDNOBW6xYKM',
  title: 'Synthetic Russian song', artist: 'Fixture', duration: 267, language: null };
async function setup(t, metadata = song) {
  const f = await fixture(); t.after(f.close);
  f.sqlite.prepare(`INSERT INTO Member_External_Songs(account_id,song_id,source,source_id,metadata_json,updated_at)
    VALUES(?,?,'youtube',?,?,1)`).run(f.owner, song.id, song.sourceId, JSON.stringify(metadata));
  return f;
}
test('an existing account reference resolves by internal ID despite an upstream metadata outage', async t => {
 const f=await setup(t);let upstream=0,gates=0;
 const actual=await resolveLyricSong(f.db,song.id,{session:f.signed.session,songStillExists:async id=>{gates++;assert.equal(id,song.id);return true;},resolveSong:async()=>{upstream++;throw Error('Synthetic metadata outage');}});
 assert.equal(actual.title,song.title);assert.equal(actual.id,song.id);assert.equal(upstream,0);assert.equal(gates,1);
});
test('a cached reference cannot bypass a disconnected or revoked source',async t=>{
 const f=await setup(t);const deps={session:f.signed.session,resolveSong:async()=>{assert.fail('A retired reference must not acquire another binding');}};
 assert.equal(await resolveLyricSong(f.db,song.id,{...deps,songStillExists:async()=>false}),null);
 await assert.rejects(resolveLyricSong(f.db,song.id,{...deps,songStillExists:async()=>{throw Object.assign(Error('forbidden'),{code:'forbidden'});}}),{code:'forbidden'});
});
test('another account cannot consume the owner metadata snapshot; a missing reference uses the provider',async t=>{
 const f=await setup(t);let upstream=0,gates=0;
 const actual=await resolveLyricSong(f.db,song.id,{accountId:'member',songStillExists:async()=>{gates++;return true;},resolveSong:async()=>{upstream++;return {...song,title:'Provider result'};}});
 assert.equal(actual.title,'Provider result');assert.equal(upstream,1);assert.equal(gates,0);
});
test('a wrong-ID stored reference is rejected and falls back to trusted provider metadata',async t=>{
 const f=await setup(t,{...song,id:'yt:abcdefghijk'});let upstream=0;
 const actual=await resolveLyricSong(f.db,song.id,{session:f.signed.session,songStillExists:async()=>true,resolveSong:async()=>{upstream++;return song;}});
 assert.equal(actual.id,song.id);assert.equal(upstream,1);
});
test('an unmigrated reference table keeps the provider fallback; other DB errors remain failures',async()=>{
 let upstream=0;const deps={accountId:'fixture',songStillExists:async()=>true,resolveSong:async()=>{upstream++;return song;}};
 assert.equal((await resolveLyricSong({prepare(){throw Error('no such table: Member_External_Songs');}},song.id,deps)).id,song.id);
 await assert.rejects(resolveLyricSong({prepare(){throw Error('database unavailable');}},song.id,deps),/database unavailable/u);
 assert.equal(upstream,1);
});
