import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { notifyMusicSourcesChanged } from '../services/musicSources.js';

const yt={id:'yt:QBtVFL0Qefs',source:'youtube',sourceId:'QBtVFL0Qefs',title:'YT song',
  audio_url:'/media/youtube/audio/QBtVFL0Qefs',artists:[{id:'yt:artist:UCtest',name:'A'}],albumId:'yt:album:MPREb_a'};

test('favorite actions add only a YouTube id and can remove the saved reference after source retirement', async () => {
  const calls=[],messages=[];
  const state={playlists:[{id:'fav',kind:'favorite'}],details:{fav:{id:'fav',revision:3,songs:[]}}};
  const store={getState:()=>({
    addSongs:async (...args)=>{calls.push(['add',...args]);state.details.fav={...state.details.fav,revision:4,songs:[yt]};return {outcome:'added'};},
    removeSong:async (...args)=>{calls.push(['remove',...args]);state.details.fav={...state.details.fav,revision:5,songs:[]};},
  })};
  const fixture=createBackgroundModuleHarness({file:new URL('./useFavoriteSongAction.js',import.meta.url),exportName:'useFavoriteSongAction',
    modules:{
      '../i18n/index.js':{t:value=>value},
      '../accountPlaylists.js':{accountPlaylistsStore:store,isAccountPlaylistStaleError:()=>false,useAccountPlaylists:selector=>selector(state)},
      '../store/useUIStore.js':{showToast:message=>messages.push(message)},
    },globals:{},
  });
  let action=fixture.render();
  assert.equal(await action.toggleFavorite(yt),true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),['add',[{playlistId:'fav',expectedRevision:3}],['yt:QBtVFL0Qefs']]);
  action=fixture.render();assert.equal(action.isFavorite(yt),true);
  notifyMusicSourcesChanged();
  action=fixture.render();assert.equal(action.isFavorite(yt),true,'disconnect must not erase an account reference');
  assert.equal(await action.toggleFavorite(yt),true);
  assert.deepEqual(calls[1],['remove','fav','yt:QBtVFL0Qefs',4]);
  assert.equal(fixture.render().isFavorite(yt),false);
  assert.equal(messages.length,2);
  fixture.unmount();
});
