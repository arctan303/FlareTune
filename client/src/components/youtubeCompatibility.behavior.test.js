import * as musicSources from '../services/musicSources.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const nodes=tree=>tree&&typeof tree==='object'?[tree,...(tree.props?.children||[]).flat(Infinity).flatMap(nodes)]:[];
const text=node=>typeof node==='string'?node:(node?.props?.children||[]).flat(Infinity).map(text).join('');
const ytSong={id:'yt:QBtVFL0Qefs',source:'youtube',title:'Same',artist:'Artist',audio_url:'/media/youtube/audio/QBtVFL0Qefs'};

test('YouTube song menus allow account library actions while catalog edits remain unavailable', () => {
  const calls=[];
  const fixture=createBackgroundModuleHarness({file:new URL('./catalog/SongActionsMenu.jsx',import.meta.url),
    modules:{
      '../../i18n/index.js':{t:value=>value},
      'lucide-react':{FolderPlus:'icon',ListPlus:'icon',Pencil:'icon',Puzzle:'icon',Star:'icon',Trash2:'icon'},
      '../../store/useUIStore.js':{useUIStore:selector=>selector({authSession:{user:{role:'admin'}},openQuickSongEdit:()=>calls.push('edit')})},
      './FloatingTrackMenu.jsx':'menu',
      '../../hooks/usePluginMenu.js':{usePluginMenu:()=>({entries:[],selection:null})},
      '../PluginActionDialog.jsx':'dialog',
    },globals:{window:{addEventListener(){},removeEventListener(){}}},
  });
  const props={song:ytSong,anchorRef:{current:{focus(){}}},onClose(){},onToggleLiked:()=>calls.push('favorite'),
    onInsertNext:()=>calls.push('next'),onAddToPlaylist:()=>calls.push('playlist')};
  let menu=fixture.render(props);
  const buttons=nodes(menu).filter(node=>node.type==='button');
  assert.deepEqual(buttons.map(text),['加入我的收藏','插播到下一首','加入歌单']);
  assert.equal(buttons.map(text).includes('编辑歌曲信息'),false);
  buttons[1].props.onClick({stopPropagation(){}});
  assert.deepEqual(calls,['next']);
  menu=fixture.render({...props,song:{id:'local',title:'Same'}});
  const labels=nodes(menu).filter(node=>node.type==='button').map(text);
  assert.equal(labels.includes('加入我的收藏'),true);
  assert.equal(labels.includes('加入歌单'),true);
  assert.equal(labels.includes('编辑歌曲信息'),true);
  fixture.unmount();
});

function artistFixture() {
  const requests=[],catalogCalls=[],photos=[],navigations=[];
  const fixture=createBackgroundModuleHarness({file:new URL('./ArtistDetailView.jsx',import.meta.url),
    modules:{
      '../services/musicSources.js':musicSources,
      '../i18n/index.js':{t:value=>value},
      'lucide-react':{Play:'icon',Pause:'icon',ListPlus:'icon'},
      './LazyImage.jsx':'image','./TrackRow.jsx':'track','./catalog/SongColumnShelf.jsx':'shelf',
      './catalog/AlbumPreviewGrid.jsx':'albums','./catalog/CatalogSkeleton.jsx':'skeleton',
      './catalog/SectionHeading.jsx':'heading','./PageBackButton.jsx':'back',
      '../utils.js':{hydrateSong:song=>song},
      '../hooks/useArtistPhotos.js':{getArtistPhotoApiBase:()=>'',ARTIST_PHOTO_CACHE:new Map(),preloadAndDecodeImage:async()=>{}},
      '../store/useUIStore.js':{showToast(){},useUIStore:{getState:()=>({openArtistDrawer:artist=>navigations.push(artist)})}},
      '../store/usePlayerStore.js':{usePlayerStore:{getState:()=>({appendSongs:songs=>songs.length})}},
      '../services/authenticatedFetch.js':{authenticatedFetch:async url=>{photos.push(url);return {json:async()=>({})};}},
      '../services/catalogRead.js':{readArtist:(key,options)=>new Promise(resolve=>requests.push({key,options,resolve}))},
      '../hooks/useCatalogPage.js':{useCatalogPage:(type,options)=>{catalogCalls.push({type,options});return {items:[],status:'idle',hasMore:false};}},
      '../hooks/usePrivateMediaSource.js':{usePrivateMediaImage:src=>({url:src,onError(){}})},
      '../utils/navigation.js':{formatPath:route=>JSON.stringify(route),returnToParentRoute:()=>'',syncBrowserHistory:url=>navigations.push(url)},
    },globals:{AbortController,window:{addEventListener(){},removeEventListener(){},scrollY:0}},
  });
  return {...fixture,requests,catalogCalls,photos,navigations};
}

test('YouTube artist deep links load their browse identity and render upstream name, songs and albums', async () => {
  const fixture=artistFixture();
  const props={artist:{id:'yt:artist:UCone',name:'yt:artist:UCone',source:'youtube'},onPlaySong(){},onBack(){}};
  fixture.render(props);
  assert.equal(fixture.requests[0].key,'yt:artist:UCone');
  assert.equal(fixture.catalogCalls[0].options.enabled,false);
  fixture.requests[0].resolve({name:'Actual Artist',songs:[ytSong],albums:[{id:'yt:album:MPREb_a',title:'Album'}],coverUrl:'/media/youtube/image?url=x',hasMore:false,total:1});
  await flushBackgroundAsync();
  const view=fixture.render();
  assert.match(text(view),/Actual Artist/);
  assert.equal(nodes(view).find(node=>node.type==='track').props.song.id,ytSong.id);
  assert.equal(nodes(view).find(node=>node.type==='albums').props.albums[0].id,'yt:album:MPREb_a');
  assert.deepEqual(fixture.photos,[],'YT avatar does not query a same-name local artist');
  fixture.unmount();
});

test('a late YouTube artist response cannot overwrite the next artist page', async () => {
  const fixture=artistFixture();
  fixture.render({artist:{id:'yt:artist:UCold',name:'Old',source:'youtube'}});
  fixture.render({artist:{id:'yt:artist:UCnew',name:'New',source:'youtube'}});
  fixture.requests[1].resolve({name:'Newest Artist',songs:[{...ytSong,title:'Newest'}],albums:[],hasMore:false,total:1});
  await flushBackgroundAsync(); fixture.render();
  fixture.requests[0].resolve({name:'Wrong Artist',songs:[{...ytSong,title:'Wrong'}],albums:[],hasMore:false,total:1});
  await flushBackgroundAsync(); const view=fixture.render();
  assert.match(text(view),/Newest Artist/); assert.doesNotMatch(text(view),/Wrong Artist/);
  assert.equal(nodes(view).find(node=>node.type==='track').props.song.title,'Newest');
  fixture.unmount();
});


test('source disconnect retires the visible YouTube artist data and prevents old responses from restoring it', async () => {
  const fixture=artistFixture();
  fixture.render({artist:{id:'yt:artist:UCbinding',name:'Artist',source:'youtube'}});
  fixture.requests[0].resolve({name:'Bound Artist',songs:[ytSong],albums:[],hasMore:false,total:1});
  await flushBackgroundAsync();assert.equal(nodes(fixture.render()).filter(node=>node.type==='track').length,1);
  musicSources.notifyMusicSourcesChanged();
  const view=fixture.render();
  assert.equal(nodes(view).filter(node=>node.type==='track').length,0);
  assert.equal(fixture.requests.length,2);
  fixture.requests[1].resolve({name:'Disconnected',songs:[],albums:[],hasMore:false,total:0});
  await flushBackgroundAsync();assert.equal(nodes(fixture.render()).filter(node=>node.type==='track').length,0);
  fixture.unmount();
});
