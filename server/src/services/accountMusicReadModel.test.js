import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalMusicReadRoute } from '../routes/localMusicRead.js';
import { localPersonalPlaylistsTool } from '../tools/localPersonalPlaylists.js';
import { localListeningStatsTool } from '../tools/localListeningStats.js';
import { readAccountPlaylistSongs } from './accountMusicReadModel.js';
import { handleDelete, handleDeletePreview } from './adminMusicDeletion.js';

const yt1 = 'yt:12345678901';
const yt2 = 'yt:ABCDEFGHIJK';
const metadata = (id, title) => ({ id, source: 'youtube', sourceId: id.slice(3), title,
  artist: 'YT Artist', artists: [{ id: 'yt:artist:UCartist', sourceId: 'UCartist', name: 'YT Artist' }],
  album: 'YT Album', albumId: 'yt:album:MPREb_album', duration: 211,
  audio_url: 'https://private.googlevideo.com/never-return-this',
  cover_url: '/media/youtube/image?url=' + encodeURIComponent('https://lh3.googleusercontent.com/cover=w120-h120') + '&size=1200' });

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0001_baseline.sql', '0002_expand_playlist_count.sql',
    '0013_hotpath_indexes_and_counts.sql', '0014_external_music_references.sql']) {
    sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/' + name, import.meta.url), 'utf8'));
  }
  sqlite.exec(`INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES
    ('A','user-a','admin',1,1),('B','user-b','member',1,1);
    INSERT INTO Songs(id,title,artist,album,duration,audio_url,language) VALUES
    ('l1','Local one','Local artist','Local album',10,'/media/audio/1.mp3','en'),
    ('l2','Local two','Local artist','Local album',20,'/media/audio/2.mp3','en'),
    ('l3','Local three','Local artist','Local album',30,'/media/audio/3.mp3','en');
    INSERT INTO Member_Playlists(id,account_id,kind,name,revision,created_at,updated_at) VALUES
    ('favA','A','favorite','Favorite',5,1,1),('mixA','A','regular','Mixed A',5,2,2),
    ('mixB','B','regular','Private B',5,2,2);
    INSERT INTO Member_Playlist_Songs(playlist_id,song_id,sort_order,added_at) VALUES
    ('favA','l1',1,1),('mixA','l1',0,1),('mixA','l2',2,1),('mixA','l3',4,1),('mixB','l2',1,1);
    INSERT INTO Member_Song_Plays(account_id,song_id,play_count,last_played_at) VALUES ('A','l1',3,100);`);
  const reference = sqlite.prepare(`INSERT INTO Member_External_Songs
    (account_id,song_id,source,source_id,metadata_json,updated_at) VALUES (?,?,'youtube',?,?,1)`);
  for (const [accountId, id, title] of [['A',yt1,'Private A YT'],['A',yt2,'Second A YT'],['B',yt1,'Private B YT']]) {
    reference.run(accountId,id,id.slice(3),JSON.stringify(metadata(id,title)));
  }
  sqlite.exec(`INSERT INTO Member_External_Playlist_Songs(playlist_id,account_id,song_id,sort_order,added_at) VALUES
    ('favA','A','${yt1}',0,1),('mixA','A','${yt1}',1,1),('mixA','A','${yt2}',3,1),('mixB','B','${yt1}',0,1);
    INSERT INTO Member_External_Song_Plays(account_id,song_id,play_count,last_played_at) VALUES
    ('A','${yt1}',5,200),('B','${yt1}',99,300);`);
  const db = { readOnly: false, prepare(sql) {
    if (db.readOnly) assert.match(sql.trimStart(), /^SELECT\b/i);
    const create = values => ({ bind: (...next) => create(next),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
    });
    return create([]);
  }, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result=[]; for (const item of statements) result.push(await item.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { db, sqlite };
}
async function read(db, path, accountId='A', options={}) {
  const request = new Request('https://tune.test'+path);
  const response = await handleLocalMusicReadRoute(request,new URL(request.url),db,{},accountId,options);
  return { status: response.status, ...(await response.json()) };
}

test('legacy account reads merge both sources in saved order without adding YT to the catalog', async t => {
  const { db,sqlite }=fixture(); t.after(()=>sqlite.close()); db.readOnly=true;
  for (const schemaVersion of [1,2]) {
    const init=await read(db,'/api/init','A',{schemaVersion});
    assert.deepEqual(init.data.default_playlist.songs.map(s=>s.id),[yt1,'l1']);
    assert.equal(init.data.other_playlists[0].songCount,5);
  }
  const list=await read(db,'/api/playlists/mixA');
  assert.deepEqual(list.data.songs.map(s=>s.id),['l1',yt1,'l2',yt2,'l3']);
  assert.equal(list.data.songs[1].title,'Private A YT');
  assert.equal(list.data.songs[1].audio_url,'/media/youtube/audio/12345678901');
  assert.equal((await read(db,'/api/playlists/mixB')).status,404);
  assert.equal((await read(db,'/api/playlists/mixB','B')).data.songs[0].title,'Private B YT');
  const catalog=await read(db,'/api/songs?language=en');
  assert.deepEqual(new Set(catalog.data.songs.map(s=>s.id)),new Set(['l1','l2','l3']));
  assert.equal((await read(db,'/api/songs/'+yt1)).status,404);
  assert.doesNotMatch(JSON.stringify(list),/private\.googlevideo|Private B YT/);
});

test('assistant remains SELECT-only and keeps mixed pagination, account isolation and source metadata', async t => {
  const { db,sqlite }=fixture(); t.after(()=>sqlite.close()); db.readOnly=true;
  const context={db,accountId:'A',user_sub:'B'};
  const lists=await localPersonalPlaylistsTool.execute({action:'list'},context);
  assert.deepEqual(lists.eventData.playlists.map(p=>[p.id,p.songCount]),[['favA',2],['mixA',5]]);
  const page=await localPersonalPlaylistsTool.execute({action:'read',playlist_id:'mixA',offset:1,limit:3},context);
  assert.equal(page.eventData.playlist.songCount,5);
  assert.deepEqual(page.eventData.songs.map(s=>s.id),[yt1,'l2',yt2]);
  assert.equal(page.eventData.songs[0].source,'youtube');
  assert.equal(page.eventData.songs[0].sourceId,yt1.slice(3));
  assert.equal(page.eventData.songs[0].albumId,'yt:album:MPREb_album');
  assert.equal(page.eventData.songs[0].artists[0].id,'yt:artist:UCartist');
  assert.equal((await localPersonalPlaylistsTool.execute({action:'read',playlist_id:'mixB'},context)).eventData.error.code,'playlist_not_found');
  const stats=await localListeningStatsTool.execute({},context);
  assert.equal(stats.eventData.ok,true);
  assert.deepEqual(stats.eventData.songs.map(s=>s.id),[yt1,'l1']);
  assert.equal(stats.eventData.songs[0].title,'Private A YT');
  assert.equal(stats.eventData.songs[0].source,'youtube');
  assert.equal(stats.eventData.total_plays,8);
  assert.equal(stats.eventData.total_unique_songs,2);
  assert.doesNotMatch(JSON.stringify(stats),/Private B|99/);
  const other=await localListeningStatsTool.execute({},{db,accountId:'B'});
  assert.equal(other.eventData.songs[0].title,'Private B YT');
  assert.equal(other.eventData.total_plays,99);
});

test('invalid stored YT snapshot reports storage failure instead of silently omitting songs', async t => {
  const { db,sqlite }=fixture(); t.after(()=>sqlite.close());
  sqlite.prepare('UPDATE Member_External_Songs SET metadata_json=? WHERE account_id=? AND song_id=?').run('{}','A',yt1);
  await assert.rejects(readAccountPlaylistSongs(db,'A','mixA'),{code:'EXTERNAL_SONG_INVALID'});
  const context={db,accountId:'A'};
  assert.equal((await localPersonalPlaylistsTool.execute({action:'read',playlist_id:'mixA'},context)).eventData.error.code,'database_query_failed');
  assert.equal((await localListeningStatsTool.execute({},context)).eventData.error.code,'database_query_failed');
});

test('local catalog deletion compacts a stable mixed ordering across both source tables and accounts', async t => {
  const { db,sqlite }=fixture(); t.after(()=>sqlite.close());
  const objects=new Map();let revision=0;
  const env={MEDIA_BUCKET:{
    async get(key){const item=objects.get(key);return item?{size:item.text.length,etag:item.etag,text:async()=>item.text}:null;},
    async put(key,text,options={}){
      const current=objects.get(key);
      if(options.onlyIf?.etagDoesNotMatch==='*'&&current)return null;
      if(options.onlyIf?.etagMatches&&current?.etag!==options.onlyIf.etagMatches)return null;
      const etag=String(++revision);objects.set(key,{text:String(text),etag});return {etag};
    },
    async delete(key){objects.delete(key);},
  }};
  const request=body=>new Request('https://tune.test/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const preview=await handleDeletePreview(request({ids:['l2']}),db,env,{});
  const digest=(await preview.json()).data.impact_digest;
  const deleted=await handleDelete(request({ids:['l2'],delete_media:false,impact_digest:digest}),db,env,{});
  assert.equal(deleted.status,200,JSON.stringify(await deleted.clone().json()));
  const mixed=id=>sqlite.prepare('SELECT song_id,sort_order FROM Member_All_Playlist_Songs WHERE playlist_id=? ORDER BY sort_order,song_id').all(id).map(r=>[r.song_id,r.sort_order]);
  assert.deepEqual(mixed('mixA'),[['l1',0],[yt1,1],[yt2,2],['l3',3]]);
  assert.deepEqual(mixed('mixB'),[[yt1,0]]);
  assert.equal(sqlite.prepare("SELECT revision FROM Member_Playlists WHERE id='mixA'").get().revision,6);
  assert.equal(sqlite.prepare("SELECT cached_song_count AS n FROM Member_Playlists WHERE id='mixA'").get().n,4);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM Member_External_Songs').get().n,3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM Songs WHERE id LIKE 'yt:%'").get().n,0);
});
