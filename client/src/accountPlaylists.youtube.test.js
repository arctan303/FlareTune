import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountPlaylistStore } from './accountPlaylists.js';
import { notifyMusicSourcesChanged } from './services/musicSources.js';
import { hydrateSong } from './utils.js';

const yt={id:'yt:QBtVFL0Qefs',source:'youtube',sourceId:'QBtVFL0Qefs',title:'YT song',artist:'A',
  audio_url:'/media/youtube/audio/QBtVFL0Qefs',cover_url:'/media/youtube/image?url=x',
  artists:[{id:'yt:artist:UCtest',name:'A'}],albumId:'yt:album:MPREb_a'};
const local={id:'local',title:'Local',audio_url:'/media/audio/local.mp3'};
const json=data=>Response.json({ok:true,data});

test('mixed personal playlist transport uses ids and retains readable/removable YT snapshots after disconnect', async () => {
  const writes=[];
  let detail={id:'p1',kind:'regular',name:'Mixed',revision:1,songs:[],songCount:0};
  const catalog=new Map([[local.id,local],[yt.id,yt]]);
  const store=createAccountPlaylistStore({apiBase:'',fetchImpl:async (url,init)=>{
    if(init.method==='POST') {
      const body=JSON.parse(init.body);writes.push({method:'POST',body});
      assert.deepEqual(Object.keys(body).sort(),['songIds','targets']);
      assert.deepEqual(body.songIds,['local',yt.id]);
      detail={...detail,songs:body.songIds.map(id=>catalog.get(id)),songCount:body.songIds.length,revision:detail.revision+1};
      return json({outcome:'added',results:[{playlistId:'p1',outcome:'added'}]});
    }
    if(init.method==='PUT') {
      const body=JSON.parse(init.body);writes.push({method:'PUT',body});
      assert.deepEqual(Object.keys(body).sort(),['expectedRevision','songIds']);
      detail={...detail,songs:body.songIds.map(id=>catalog.get(id)),songCount:body.songIds.length,revision:detail.revision+1};
      return json({playlist:detail});
    }
    if(init.method==='DELETE') {
      writes.push({method:'DELETE',url,body:JSON.parse(init.body)});
      const id=decodeURIComponent(url.split('/songs/')[1]);
      detail={...detail,songs:detail.songs.filter(song=>song.id!==id),songCount:detail.songCount-1,revision:detail.revision+1};
      return json({playlist:detail});
    }
    if(url==='/api/account/playlists') return json({playlists:[{...detail,songs:undefined}]});
    if(url==='/api/account/playlists/p1') return json({playlist:detail});
    throw new Error('Unexpected transport '+url);
  }});
  store.getState().setSubject('A');await store.getState().refreshLists();await store.getState().loadDetail('p1');
  await store.getState().addSongs([{playlistId:'p1',expectedRevision:1}],['local',yt.id]);
  const saved=store.getState().details.p1;
  assert.equal(saved.songCount,2);assert.equal(store.getState().playlists[0].songCount,2);
  const restored=hydrateSong(saved.songs[1]);
  assert.equal(restored.source,'youtube');assert.equal(restored.artists[0].id,'yt:artist:UCtest');
  assert.equal(restored.albumId,yt.albumId);assert.equal(restored.audio_url,yt.audio_url);assert.equal(restored.cover_url,yt.cover_url);
  notifyMusicSourcesChanged();
  assert.equal(store.getState().details.p1.songs.length,2);
  await store.getState().reorderSongs('p1',[yt.id,'local'],saved.revision);
  assert.deepEqual(store.getState().details.p1.songs.map(song=>song.id),[yt.id,'local']);
  await store.getState().removeSong('p1',yt.id,store.getState().details.p1.revision);
  assert.deepEqual(store.getState().details.p1.songs.map(song=>song.id),['local']);
  assert.equal(store.getState().playlists[0].songCount,1);
  assert.match(writes.at(-1).url,/yt%3AQBtVFL0Qefs/);
  store.getState().setSubject('B');assert.deepEqual(store.getState().details,{});
});
