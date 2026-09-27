import { Loader2, PanelBottom, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { useUIStore } from '../store/useUIStore.js';
import LazyImage from './LazyImage.jsx';

export default function SidebarMiniPlayer({ allowLayoutSwitch, isTransitioning = false, motionPhase = null, onLayoutSwitch }) {
  const { currentSong, isPlaying, isBuffering, togglePlay, playPrev, playNext } = usePlayerStore(useShallow((state) => ({
    currentSong: state.currentSong,
    isPlaying: state.isPlaying,
    isBuffering: state.isBuffering,
    togglePlay: state.togglePlay,
    playPrev: state.playPrev,
    playNext: state.playNext,
  })));
  const setIsFullScreen = useUIStore((state) => state.setIsFullScreen);
  const setCompactPlayerPlacement = useUIStore((state) => state.setCompactPlayerPlacement);

  if (!currentSong) return null;

  return (
    <section className={`sidebar-mini-player ${motionPhase ? `sidebar-mini-player--${motionPhase}` : ''}`} aria-label="侧边播放器" inert={isTransitioning ? '' : undefined}>
      <button
        type="button"
        className="sidebar-mini-player__cover"
        onClick={() => setIsFullScreen(true)}
        aria-label={`打开《${currentSong.title || '当前歌曲'}》的全屏播放器`}
      >
        <LazyImage src={currentSong.cover_url || '/placeholder-album.svg'} alt="" className="h-full w-full" eager />
      </button>
      <div className="sidebar-mini-player__body">
        <button type="button" className="sidebar-mini-player__track" onClick={() => setIsFullScreen(true)}>
          <strong title={currentSong.title || ''}>{currentSong.title || '正在播放'}</strong>
          <span title={currentSong.artist || ''}>{currentSong.artist || '未知歌手'}</span>
        </button>
        <div className="sidebar-mini-player__actions">
          <button type="button" onClick={playPrev} aria-label="上一首" title="上一首">
            <SkipBack size={17} />
          </button>
          <button type="button" onClick={togglePlay} aria-label={isPlaying ? '暂停' : '播放'} title={isPlaying ? '暂停' : '播放'}>
            {isBuffering && isPlaying ? <Loader2 size={17} className="animate-spin" /> : isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </button>
          <button type="button" onClick={playNext} aria-label="下一首" title="下一首">
            <SkipForward size={17} />
          </button>
          {allowLayoutSwitch && (
            <button type="button" className="sidebar-mini-player__layout" onClick={() => {
              setCompactPlayerPlacement('dock');
              onLayoutSwitch?.();
            }} disabled={isTransitioning} aria-label="切换到底部播放器" title="切换到底部播放器">
              <PanelBottom size={16} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
