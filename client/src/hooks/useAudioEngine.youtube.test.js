import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { usePlayStatsStore, resetStats, resetSyncBackoff } from '../store/playStatsTestSupport.js';

function engine(song,duration=200) {
  const audio={currentTime:0,duration,paused:false,playbackRate:1};
  const state={currentSong:song,duration,shouldAutoPlay:false,lyrics:[],lyricSyncMode:'none',currentLyricIndex:0,
    setProgress(){},setIsBuffering(){},setIsPlaying(){},setShouldAutoPlay(){},playNext(){},tryPlay(){}};
  const player=selector=>selector(state);player.getState=()=>state;player.subscribe=()=>()=>{};
  const fixture=createBackgroundModuleHarness({file:new URL('./useAudioEngine.js',import.meta.url),exportName:'useAudioEngine',
    modules:{
      '../i18n/index.js':{t:value=>value},'zustand/react/shallow':{useShallow:value=>value},
      '../store/usePlayerStore.js':{usePlayerStore:player},
      '../store/usePlayStatsStore.js':{usePlayStatsStore},
      '../store/usePlayHistoryStore.js':{usePlayHistoryStore:{getState:()=>({addSong(){}})}},
      '../store/useUIStore.js':{useUIStore:{getState:()=>({authSession:{authenticated:true}})},showToast(){}},
      '../components/fullscreen/audioAnalyserResource.js':{invalidateAudioAnalyser(){},markAudioAnalyserPlaying(){}},
      '../services/lyricPlaybackClock.js':{lyricPlaybackClock:{attach(){},detach(){},sample(){},subscribe:()=>()=>{}}},
    },globals:{navigator:{},HTMLMediaElement:{HAVE_CURRENT_DATA:2},setTimeout,clearTimeout},
  });
  const props={audioRef:{current:audio},claimPlayback(){},persistPosition(){},persistPositionThrottled(){},persistSeekPosition(){},restorePosition(){}};
  const {audioHandlers}=fixture.render(props);
  return {...fixture,audio,state,tick(time){audio.currentTime=time;audioHandlers.onTimeUpdate();}};
}

test('YT playback counts only qualified listening, ignoring seeks/paused progress and preserving one event per play', () => {
  resetStats({ownerSubject:'A',identityReady:true});
  const song={id:'yt:QBtVFL0Qefs',source:'youtube',title:'YT',audio_url:'/media/youtube/audio/QBtVFL0Qefs'};
  const fixture=engine(song);
  try {
    fixture.tick(0);fixture.tick(120);fixture.tick(0);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length,0,'seeking is not listening');
    fixture.audio.paused=true;for(let second=1;second<=20;second++)fixture.tick(second);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length,0,'paused time is not listening');
    fixture.audio.paused=false;for(let second=21;second<50;second++)fixture.tick(second);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length,0,'less than thirty seconds does not qualify');
    fixture.tick(50);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length,1);
    assert.equal(usePlayStatsStore.getState().pendingQueue[0].song_id,song.id);
    for(let second=51;second<=70;second++)fixture.tick(second);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length,1);
  }finally{fixture.unmount();resetSyncBackoff();}
});

for(const song of [{id:'local-short',audio_url:'/media/audio/local.mp3'},
  {id:'yt:4D7u5KF7SP8',source:'youtube',audio_url:'/media/youtube/audio/4D7u5KF7SP8'}]) {
  test(`${song.id} retains the short-track half-duration qualification`,()=>{
    resetStats({ownerSubject:'A',identityReady:true});const fixture=engine(song,40);
    try {
      for(let second=0;second<20;second++)fixture.tick(second);
      assert.equal(usePlayStatsStore.getState().pendingQueue.length,0);
      fixture.tick(20);assert.equal(usePlayStatsStore.getState().pendingQueue.length,1);
    }finally{fixture.unmount();resetSyncBackoff();}
  });
}
