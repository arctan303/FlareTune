import assert from 'node:assert/strict';
import test from 'node:test';
import { useUIStore } from './playStatsTestSupport.js';

test('imperative account actions accept YouTube references while catalog editing remains local-only', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const before=useUIStore.getState();
  useUIStore.setState({authSession:{authenticated:true,user:{accountId:'A',role:'admin'}},
    quickSongEditId:null,isAddToPlaylistOpen:false,addToPlaylistSongs:[]});
  try {
    assert.equal(useUIStore.getState().openQuickSongEdit('yt:QBtVFL0Qefs'),false);
    assert.equal(useUIStore.getState().quickSongEditId,null);
    assert.equal(useUIStore.getState().openAddToPlaylist([{id:'local'},{id:'yt:QBtVFL0Qefs',source:'youtube'}]),true);
    assert.equal(useUIStore.getState().isAddToPlaylistOpen,true);
    assert.deepEqual(useUIStore.getState().addToPlaylistSongs.map(song=>song.id),['local','yt:QBtVFL0Qefs']);
    assert.equal(useUIStore.getState().openQuickSongEdit('local'),true);
    assert.equal(useUIStore.getState().quickSongEditId,'local');
    assert.equal(useUIStore.getState().openAddToPlaylist({id:'local'}),true);
    assert.equal(useUIStore.getState().addToPlaylistSongs[0].id,'local');
  } finally { useUIStore.setState(before); }
});
