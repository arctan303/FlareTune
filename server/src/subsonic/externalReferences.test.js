import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './test-support.js';
import { state } from './state.js';

const yt1='yt:12345678901',yt2='yt:ABCDEFGHIJK';
function seed(f) {
  const insert=f.sqlite.prepare(`INSERT INTO Member_External_Songs
    (account_id,song_id,source,source_id,metadata_json,updated_at) VALUES (?,?,'youtube',?,?,1)`);
  for(const id of [yt1,yt2]) insert.run(f.owner,id,id.slice(3),JSON.stringify({id,source:'youtube',sourceId:id.slice(3),
    title:'YT song',artist:'YT Artist',album:'YT Album',duration:211,
    cover_url:'/media/youtube/image?url='+encodeURIComponent('https://i.ytimg.com/vi/'+id.slice(3)+'/default.jpg')}));
  const playlist=f.sqlite.prepare(`INSERT INTO Member_Playlists(id,account_id,kind,name,revision,created_at,updated_at)
    VALUES (?, ?, ?, ?,0,1,1)`);
  playlist.run('mix',f.owner,'regular','Mixed');
  playlist.run('onlyYT',f.owner,'regular','Only YT');
  playlist.run('fav',f.owner,'favorite','Favorite');
  f.sqlite.exec(`INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at) VALUES
    ('mix','s1',0,1),('mix','s2',2,1),('fav','s1',1,1)`);
  const external=f.sqlite.prepare(`INSERT INTO Member_External_Playlist_Songs
    (playlist_id,account_id,song_id,sort_order,added_at) VALUES (?,?,?,?,1)`);
  for(const [playlistId,songId,order] of [['mix',yt1,1],['mix',yt2,3],['onlyYT',yt1,0],['fav',yt1,0]]) {
    external.run(playlistId,f.owner,songId,order);
  }
}
const params=values=>{
  const result=new URLSearchParams();
  for(const [key,value] of Object.entries(values)) for(const item of Array.isArray(value)?value:[value]) result.append(key,String(item));
  return result;
};
const invoke=(f,method,values={})=>state(method,params(values),f.db,{accountId:f.owner,username:'owner'});
const mixed=(f,id)=>f.sqlite.prepare(`SELECT song_id FROM Member_All_Playlist_Songs
  WHERE playlist_id=? ORDER BY sort_order,song_id`).all(id).map(row=>row.song_id);

test('Subsonic only exposes local entries and matching summary count, duration and covers', async t=>{
  const f=await fixture();t.after(f.close);seed(f);
  const summaries=(await invoke(f,'getPlaylists')).playlists.playlist;
  const mix=summaries.find(p=>p.id==='mix');
  assert.equal(mix.songCount,2);assert.equal(mix.duration,45);assert.equal(mix.coverArt,'cover_s1');
  const empty=summaries.find(p=>p.id==='onlyYT');
  assert.equal(empty.songCount,0);assert.equal(empty.duration,0);assert.equal(empty.coverArt,undefined);
  const detail=(await invoke(f,'getPlaylist',{id:'mix'})).playlist;
  assert.equal(detail.songCount,2);assert.equal(detail.duration,45);assert.deepEqual(detail.entry.map(s=>s.id),['s1','s2']);
  assert.deepEqual((await invoke(f,'getPlaylist2',{id:'onlyYT'})).playlist.entry,[]);
  assert.deepEqual((await invoke(f,'getStarred2')).starred2.song.map(s=>s.id),['s1']);
  await assert.rejects(state('getPlaylist',params({id:'mix'}),f.db,{accountId:'member',username:'member'}),{code:'PLAYLIST_NOT_FOUND'});
});

test('Subsonic replacing or editing its local projection preserves hidden YT references in relative order', async t=>{
  const f=await fixture();t.after(f.close);seed(f);
  await invoke(f,'updatePlaylist',{playlistId:'mix',songIndexToRemove:0,songIdToAdd:'s3',name:'Renamed'});
  assert.deepEqual(mixed(f,'mix'),['s2',yt1,'s3',yt2]);
  assert.deepEqual((await invoke(f,'getPlaylist',{id:'mix'})).playlist.entry.map(s=>s.id),['s2','s3']);
  const replaced=await invoke(f,'createPlaylist',{playlistId:'mix',songId:['s3']});
  assert.equal(replaced.playlist.songCount,1);assert.deepEqual(mixed(f,'mix'),['s3',yt1,yt2]);
  await invoke(f,'star',{id:'s2'});assert.deepEqual(mixed(f,'fav'),[yt1,'s1','s2']);
  await invoke(f,'unstar',{id:'s1'});assert.deepEqual(mixed(f,'fav'),[yt1,'s2']);
  assert.equal(f.sqlite.prepare("SELECT cached_song_count AS n FROM Member_Playlists WHERE id='mix'").get().n,3);
});

test('Subsonic refuses newly submitted external IDs without changing existing mixed memberships', async t=>{
  const f=await fixture();t.after(f.close);seed(f);
  const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM Member_All_Playlist_Songs ORDER BY playlist_id,sort_order').all());
  for(const [method,values] of [
    ['createPlaylist',{name:'New',songId:yt2}],
    ['createPlaylist',{playlistId:'mix',songId:yt2}],
    ['updatePlaylist',{playlistId:'mix',songIdToAdd:yt2}],
    ['star',{id:yt2}],['unstar',{id:yt1}],
  ]) await assert.rejects(invoke(f,method,values),error=>error.code===70);
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM Member_All_Playlist_Songs ORDER BY playlist_id,sort_order').all()),before);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE name='New'").get().n,0);
});

test('Subsonic detects a concurrent native edit after reading the hidden membership projection', async t=>{
  const f=await fixture();t.after(f.close);seed(f);
  const before=mixed(f,'mix');
  const prepare=f.db.prepare.bind(f.db);let injected=false;
  f.db.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.includes('SELECT song_id, source FROM Member_All_Playlist_Songs'))return statement;
    const all=statement.all.bind(statement);
    statement.all=async()=>{
      const result=await all();
      if(!injected){injected=true;f.sqlite.exec("UPDATE Member_Playlists SET revision=revision+1 WHERE id='mix'");}
      return result;
    };
    return statement;
  };
  await assert.rejects(invoke(f,'updatePlaylist',{playlistId:'mix',songIndexToRemove:0}),{code:'REVISION_CONFLICT'});
  assert.equal(injected,true);assert.deepEqual(mixed(f,'mix'),before);
});
