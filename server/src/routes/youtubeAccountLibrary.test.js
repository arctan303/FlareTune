import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleYouTubeMedia, handleYouTubeMusicRoute, youtubeAccountMusicDependencies } from './youtubeIntegration.js';
import { loadExternalSongs, prepareExternalSongs } from '../services/externalMusicReferences.js';

const videoId = 'WqkrwFSFeAE';
const songId = 'yt:' + videoId;
const session = accountId => ({ mode: 'normal', account: { accountId, role: 'member' } });
const song = id => ({ id, source: 'youtube', sourceId: id.slice(3), title: 'Trusted title', artist: 'Trusted artist',
  album: 'Trusted album', albumId: 'yt:album:MPREb_example', duration: 211, language: null,
  artists: [{ id: 'yt:artist:UCexample', sourceId: 'UCexample', name: 'Trusted artist' }],
  cover_url: '/media/youtube/image?url=' + encodeURIComponent('https://lh3.googleusercontent.com/example=w120-h120') + '&size=1200',
  audio_url: 'https://should-never-be-persisted.googlevideo.com/private-signed-url' });

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0001_baseline.sql', '0002_expand_playlist_count.sql', '0013_hotpath_indexes_and_counts.sql', '0014_external_music_references.sql']) {
    database.exec(readFileSync(new URL('../../db/migrations-flaretune/' + name, import.meta.url), 'utf8'));
  }
  database.exec(`INSERT INTO accounts(account_id,username,role,created_at,updated_at)
    VALUES('A','user-a','member',1,1),('B','user-b','member',1,1)`);
  const db = { database, prepare(sql) {
    const create = args => ({ bind: (...next) => create(next),
      first: async () => database.prepare(sql).get(...args) || null,
      all: async () => ({ results: database.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(database.prepare(sql).run(...args).changes) } }),
    });
    return create([]);
  }, async batch(statements) {
    database.exec('BEGIN IMMEDIATE');
    try { const result=[]; for (const stmt of statements) result.push(await stmt.run()); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  return db;
}

test('account resolver bounds concurrency and cannot adopt a new binding while resolving or writing', async () => {
  let generation = 1, captures = 0, active = 0, peak = 0;
  const deps = youtubeAccountMusicDependencies({}, session('A'), {}, { getAccess: async () => {
    captures++; const captured = generation;
    return { service: { song: async id => { active++; peak=Math.max(peak,active); await Promise.resolve(); active--; return song('yt:'+id); } },
      assertCurrent: async () => { if (captured !== generation) throw new Error('retired'); return true; } };
  } });
  const ids=Array.from({length:9},(_,i)=>'yt:'+String(i).padStart(11,'0'));
  assert.deepEqual((await deps.resolveExternalSongs(ids)).map(x=>x.id),ids);
  assert.ok(peak<=4);
  generation=2;
  await assert.rejects(deps.assertExternalCurrent(),/retired/);
  await assert.rejects(deps.resolveExternalSongs([songId]),/retired/);
  assert.equal(captures,1);
  await assert.rejects(deps.resolveExternalSongs(['yt:invalid']));
});

test('partial account resolution keeps available songs but never adopts retired authority', async () => {
  const ids = ['yt:WqkrwFSFeAE', 'yt:QBtVFL0Qefs', 'yt:00000000000'];
  let current = true, checks = 0;
  const deps = youtubeAccountMusicDependencies({}, session('A'), {}, { getAccess: async () => ({
    service: { song: async id => {
      if (id === ids[1].slice(3)) throw new Error('metadata unavailable');
      if (id === ids[2].slice(3)) return song(ids[0]);
      return song('yt:' + id);
    } },
    assertCurrent: async () => { checks++; if (!current) throw new Error('retired'); return true; },
  }) });
  assert.deepEqual((await deps.resolveExternalSongs(ids, { partial: true })).map(x => x.id), [ids[0]]);
  assert.equal(checks, 1);
  await assert.rejects(deps.resolveExternalSongs(ids), /metadata unavailable/);
  current = false;
  await assert.rejects(deps.resolveExternalSongs(ids, { partial: true }), /retired/);
});

test('successful audio registers a private trusted reference once without creating a play or a catalog row', async t => {
  const db=fixture();t.after(()=>db.database.close());let metadataCalls=0;
  const access={ epoch:'one',assertCurrent:async()=>true,service:{song:async id=>{metadataCalls++;return song('yt:'+id);},
    stream:async()=>new Response('bytes',{status:206,headers:{'Content-Type':'audio/webm','Content-Range':'bytes 0-4/100'}})} };
  for(let n=0;n<2;n++) {
    const req=new Request('https://tune.test/media/youtube/audio/'+videoId,{headers:{Range:'bytes=0-4'}});
    const response=await handleYouTubeMedia(req,new URL(req.url).pathname,{DB:db},session('A'),{}, {getAccess:async()=>access});
    assert.equal(response.status,206);assert.equal(await response.text(),'bytes');
  }
  assert.equal(metadataCalls,1);
  const stored=await loadExternalSongs(db,'A',[songId]);
  assert.equal(stored.length,1);
  assert.equal(stored[0].audio_url,'/media/youtube/audio/'+videoId);
  assert.doesNotMatch(JSON.stringify(stored),/private-signed-url/);
  assert.deepEqual(await loadExternalSongs(db,'B',[songId]),[]);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM Songs').get().n,0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM Member_All_Play_Events').get().n,0);
});

test('HEAD and failed audio never register playback references, while auxiliary metadata failure leaves audio usable', async t => {
  const db=fixture();t.after(()=>db.database.close());let calls=0;
  const invoke=async(method,status)=>{
    const req=new Request('https://tune.test/media/youtube/audio/'+videoId,{method});
    return handleYouTubeMedia(req,new URL(req.url).pathname,{DB:db},session('A'),{}, {getAccess:async()=>({
      assertCurrent:async()=>true,service:{song:async()=>{calls++;throw new Error('temporary metadata outage');},
        stream:async()=>new Response(method==='HEAD'?null:'bytes',{status,headers:{'Content-Type':'audio/webm'}})},
    })});
  };
  assert.equal((await invoke('HEAD',200)).status,200);
  assert.equal((await invoke('GET',416)).status,416);
  assert.equal(calls,0);
  const successful=await invoke('GET',206);
  assert.equal(successful.status,206);assert.equal(await successful.text(),'bytes');
  assert.equal(calls,1);
  assert.deepEqual(await loadExternalSongs(db,'A',[songId]),[]);
});

test('disconnect during playback-reference resolution cancels the held stream and cannot persist stale authority', async t => {
  const db=fixture();t.after(()=>db.database.close());let live=true,cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const req=new Request('https://tune.test/media/youtube/audio/'+videoId);
  const result=await handleYouTubeMedia(req,new URL(req.url).pathname,{DB:db},session('A'),{}, {getAccess:async()=>({
    assertCurrent:async()=>{if(!live)throw new Error('retired');return true;},service:{
      stream:async()=>new Response(body,{status:206,headers:{'Content-Type':'audio/webm'}}),
      song:async()=>{live=false;return song(songId);},
    },
  })});
  assert.equal(result.status,502);assert.equal(cancelled,true);
  assert.deepEqual(await loadExternalSongs(db,'A',[songId]),[]);
});

test('source outage resolves only the current account saved references and leaves other accounts missing', async t => {
  const db=fixture();t.after(()=>db.database.close());
  const plan=await prepareExternalSongs(db,'A',[songId],Date.now(),{
    resolveExternalSongs:async ids=>ids.map(song),assertExternalCurrent:async()=>true,
  });await plan.assertCurrent();await db.batch(plan.statements);
  for(const accountId of ['A','B']) {
    const req=new Request('https://tune.test/api/songs/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({song_ids:[songId]})});
    const response=await handleYouTubeMusicRoute(req,new URL(req.url),{DB:db},session(accountId),{}, {
      getAccess:async()=>{throw new Error('source disconnected');},
    });
    const data=(await response.json()).data;
    assert.equal(response.status,200);
    assert.equal(data.songs.length,accountId==='A'?1:0);
    assert.deepEqual(data.missing_ids,accountId==='A'?[]:[songId]);
    if(accountId==='A')assert.equal(data.songs[0].sourceUnavailable,true);
  }
});
