import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoData, DEMO_KEY, songs } from './localData.js';
import { createLyricsResultFromResponse } from '../client/src/hooks/useLyricsFetcher.js';
const storage = () => {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
};
const request = async (data, path, method = 'GET', body) => {
  const r = await data.handle(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, ...await r.json() };
};

test('retired demo language preferences use English and are no longer selectable', async () => {
  for (const uiLanguage of ['es', 'fr', 'de', 'pt-BR']) {
    const disk = storage();
    disk.setItem(DEMO_KEY, JSON.stringify({ version: 1, uiLanguage, playlists: [] }));
    const demo = createDemoData({ storage: () => disk });
    assert.equal(demo.read().uiLanguage, 'en');
    const bootstrap = await request(demo, '/api/ai/bootstrap');
    assert.match(bootstrap.assistant.welcomeMessage, /^This is a fixed demo reply/);
    assert.equal((await request(demo, '/api/account/ui-language', 'PATCH', { uiLanguage })).status, 400);
  }
});
test('licensed vocal lyrics use the real player canonical response and bounded line timing', async () => {
  const demo = createDemoData({storage:()=>storage()});
  const response = await demo.handle('/api/lyrics?songId=demo-24');
  const lyrics = createLyricsResultFromResponse(await response.json(),response.status);
  assert.equal(lyrics.syncMode,'line');assert.equal(lyrics.status,'ready');
  assert.equal(lyrics.lyrics.length,16);
  assert.match(lyrics.lyrics[0].text,/Amazing grace/);
  assert.ok(lyrics.lyrics.every((line,index,lines)=>line.time>=0 && line.time<songs.at(-1).duration && (index===0 || line.time>lines[index-1].time)));
});
test('demo favorites and playlists persist per browser and protect revisions', async () => {
  const disk = storage(), first = createDemoData({ storage: () => disk });
  const fresh = await request(first,'/api/account/playlists');
  assert.equal(fresh.data.playlists[0].songCount,0);
  const added = await request(first,'/api/account/playlist-songs','POST',{ targets: [{ playlistId:'fav_demo', expectedRevision:1 }], songIds:[songs[0].id] });
  assert.equal(added.status,200);
  const same = createDemoData({ storage: () => disk }), other = createDemoData({ storage: () => storage() });
  assert.equal(same.read().playlists[0].songIds[0],songs[0].id);
  assert.equal(other.read().playlists[0].songIds.length,0);
  assert.equal((await request(same,'/api/account/playlist-songs','POST',{ targets:[{playlistId:'fav_demo',expectedRevision:1}],songIds:[songs[1].id] })).status,409);
  assert.equal((await request(same,'/api/account/playlists/fav_demo','DELETE',{expectedRevision:2})).status,403);
});
test('demo supports local playlist create, rename, reorder, remove and delete', async () => {
  const disk = storage(), data = createDemoData({storage:()=>disk});
  const created = (await request(data,'/api/account/playlists','POST',{name:'A'})).data.playlist;
  const path = `/api/account/playlists/${created.id}`;
  assert.equal((await request(data,path,'PUT',{name:'B',expectedRevision:1})).data.playlist.name,'B');
  await request(data,`${path}/songs`,'PUT',{songIds:[songs[1].id,songs[0].id],expectedRevision:2});
  assert.deepEqual((await request(data,path)).data.playlist.songIds,[songs[1].id,songs[0].id]);
  await request(data,`${path}/songs/${songs[1].id}`,'DELETE',{expectedRevision:3});
  assert.equal((await request(data,path)).data.playlist.songCount,1);
  assert.equal((await request(data,path,'DELETE',{expectedRevision:4})).status,200);
  assert.equal((await request(data,path)).status,404);
});
test('storage unavailable or quota exceeded retains temporary working state', async () => {
  for (const disk of [null,{getItem:()=>null,setItem:()=>{throw Error('quota');}}]) {
    const data = createDemoData({storage:()=>disk});
    await request(data,'/api/account/playlists','POST',{name:'Temporary'});
    assert.equal(data.isTemporary(),true);
    assert.equal(data.read().playlists.at(-1).name,'Temporary');
    assert.equal((await request(data,'/api/songs/random')).data.songs.length,20);
  }
});
test('corrupted and outdated references recover without leaking another origin', () => {
  const disk = storage(); disk.setItem(DEMO_KEY,JSON.stringify({version:1,uiLanguage:'bad',playlists:[
    null,{id:'a',name:'A',kind:'regular',songIds:['removed',songs[0].id,songs[0].id]},
    {id:'a',name:'duplicate',kind:'regular',songIds:[]},{id:'fav_demo',name:'F',songIds:['removed']}],shelf:{items:[{id:'unknown'},{id:'a'},{id:'a'}]}}));
  const state = createDemoData({storage:()=>disk}).read();
  assert.equal(state.playlists[0].id,'fav_demo');
  assert.deepEqual(state.playlists[1].songIds,[songs[0].id]);
  assert.deepEqual(state.shelf.items.map(i=>i.id),['a','fav_demo']);
  assert.equal(state.uiLanguage,'auto');
  disk.setItem(DEMO_KEY,JSON.stringify({version:1,playlists:[],thread:{revision:-1,messages:[null,{role:'system',content:'bad'}]}}));
  assert.deepEqual(createDemoData({storage:()=>disk}).read().thread,{revision:0,messages:[]});
  disk.setItem(DEMO_KEY,'{bad');
  assert.equal(createDemoData({storage:()=>disk}).read().playlists[0].songIds.length,0);
});
test('local queries honor language, exclude, pagination, albums and roam exhaustion', async () => {
  const data = createDemoData({storage:()=>storage()});
  assert.equal((await request(data,'/api/songs?language=zh')).data.total,0);
  assert.equal((await request(data,'/api/songs/search?q=Carefree')).data.songs[0].title,'Carefree');
  assert.equal((await request(data,'/api/songs/random?limit=20')).data.songs.length,20);
  assert.equal((await request(data,'/api/songs/roam','POST',{language:'en',queuedSongIds:[]})).data.songs.length,1);
  const exhausted = (await request(data,'/api/songs/roam','POST',{language:'en',queuedSongIds:[songs.at(-1).id]})).data;
  assert.equal(exhausted.songs.length,0); assert.equal(exhausted.exhausted,true);
  assert.ok((await request(data,'/api/albums')).data.albums.length > 1);
});
test('play events deduplicate within and across batches; reset owns only demo key', async () => {
  const disk=storage(), data=createDemoData({storage:()=>disk});
  disk.setItem('unrelated','keep');
  const e={song_id:songs[0].id,event_id:'test',played_at:100};
  assert.equal((await request(data,'/api/account/play-stats','POST',{events:[e,e]})).data.recorded,1);
  assert.equal((await request(data,'/api/account/play-stats','POST',{events:[e]})).data.recorded,0);
  assert.equal((await request(data,'/api/account/play-stats')).data.totalPlays,1);
  data.reset(); assert.equal(disk.getItem('unrelated'),'keep'); assert.equal(data.read().stats.length,0);
});
test('unknown and shared/admin/auth writes fail locally without network', async () => {
  const original=globalThis.fetch; globalThis.fetch=()=>{throw Error('network must not be called');};
  try {
    const data=createDemoData({storage:()=>storage()});
    for (const path of ['/auth/login','/api/upload','/rest/ping.view']) {
      for (const method of ['GET','POST','PUT','DELETE']) assert.equal((await request(data,path,method,{})).status,403,path);
    }
    for (const path of ['/api/admin/settings','/api/admin/accounts','/api/admin/google','/api/admin/ai/providers','/api/account/subsonic','/api/account/google','/api/lyrics/workspace/demo-24']) {
      assert.equal((await request(data,path)).status,200,path);
      for (const method of ['POST','PUT','DELETE','PATCH']) assert.equal((await request(data,path,method,{})).status,403,path);
    }
    const controller=new AbortController(); controller.abort();
    await assert.rejects(data.handle('/api/songs',{signal:controller.signal}),{name:'AbortError'});
  } finally {globalThis.fetch=original;}
});

test('demo session is an administrator and complete configuration fixtures remain immutable', async () => {
  const data = createDemoData({ storage: () => storage() });
  assert.equal((await request(data,'/api/auth/session')).user.role,'admin');
  const settings = await request(data,'/api/admin/settings');
  assert.equal(settings.settings['instance.name'].value,'FlareTune · Demo');
  settings.settings['instance.name'].value='changed';
  assert.equal((await request(data,'/api/admin/settings')).settings['instance.name'].value,'FlareTune · Demo');
  assert.equal((await request(data,'/api/admin/accounts')).accounts.length,2);
  assert.equal((await request(data,'/api/admin/catalog/songs')).data.songs.length,24);
});

test('real assistant SSE contract returns a fixed reply and keeps conversation only in browser storage', async () => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw Error('no backend'); };
  try {
    const disk = storage(), data = createDemoData({ storage: () => disk });
    await request(data,'/api/account/ui-language','PATCH',{ uiLanguage: 'en' });
    const turn = async (message, revision) => {
      const response = await data.handle('/api/ai/chat',{ method:'POST', body:JSON.stringify({message,revision,client_message_id:crypto.randomUUID()}) });
      assert.equal(response.headers.get('Content-Type'),'text/event-stream');
      const events=(await response.text()).trim().split('\n\n').map(line=>JSON.parse(line.slice(6)));
      assert.equal(events.at(-1).type,'done');
      return events;
    };
    const first=await turn('Hello',0), second=await turn('Play music',1);
    assert.match(first[0].content,/fixed demo reply/);
    assert.equal(first[0].content,second[0].content);
    const persisted=await request(createDemoData({ storage:()=>disk }),'/api/ai/thread');
    assert.equal(persisted.thread.messages.length,4);
    assert.equal((await request(createDemoData({ storage:()=>storage() }),'/api/ai/thread')).thread.messages.length,0);
    assert.equal((await request(data,'/api/ai/chat','POST',{message:'stale',revision:0})).status,409);
    assert.equal((await request(data,'/api/ai/thread','DELETE',{revision:2})).thread.messages.length,0);
    assert.equal((await request(createDemoData({storage:()=>disk}),'/api/ai/thread')).thread.messages.length,0);
  } finally { globalThis.fetch=original; }
});
