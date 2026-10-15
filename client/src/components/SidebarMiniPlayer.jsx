import React from 'react';
import { localizeUnknownArtist, t } from '../i18n/index.js';
import { ListMusic, Loader2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { useUIStore } from '../store/useUIStore.js';
import LazyImage from './LazyImage.jsx';

export default function SidebarMiniPlayer({ isTransitioning = false, motionPhase = null }) {
  const { currentSong, isPlaying, isBuffering, togglePlay, playPrev, playNext } = usePlayerStore(useShallow((state) => ({
    currentSong: state.currentSong,
    isPlaying: state.isPlaying,
    isBuffering: state.isBuffering,
    togglePlay: state.togglePlay,
    playPrev: state.playPrev,
    playNext: state.playNext,
  })));
  const setIsFullScreen = useUIStore((state) => state.setIsFullScreen);
  const setIsPlaylistOpen = useUIStore((state) => state.setIsPlaylistOpen);
  const [playlistBouncing, setPlaylistBouncing] = React.useState(false);
  const bounceTimerRef = React.useRef(null);

  React.useEffect(() => {
    const handleBounce = () => {
      if (bounceTimerRef.current) clearTimeout(bounceTimerRef.current);
      setPlaylistBouncing(true);
      bounceTimerRef.current = setTimeout(() => setPlaylistBouncing(false), 550);
    };
    window.addEventListener('arc-insert-next-bounced', handleBounce);
    return () => {
      if (bounceTimerRef.current) clearTimeout(bounceTimerRef.current);
      window.removeEventListener('arc-insert-next-bounced', handleBounce);
    };
  }, []);

  if (!currentSong) return null;

  return (
    <section className={`sidebar-mini-player ${motionPhase ? `sidebar-mini-player--${motionPhase}` : ''}`} aria-label={t("侧边播放器")} inert={isTransitioning ? '' : undefined}>
      <button
        type="button"
        className="sidebar-mini-player__cover"
        onClick={() => setIsFullScreen(true)}
        aria-label={t("打开《{p0}》的全屏播放器", { p0: (currentSong.title || t("当前歌曲")) })}
      >
        <LazyImage src={currentSong.cover_url || '/placeholder-album.svg'} alt="" className="h-full w-full" eager />
      </button>
      <div className="sidebar-mini-player__body">
        <button type="button" className="sidebar-mini-player__track" onClick={() => setIsFullScreen(true)}>
          <strong title={currentSong.title || ''}>{currentSong.title || t("正在播放")}</strong>
          <span title={localizeUnknownArtist(currentSong.artist)}>{localizeUnknownArtist(currentSong.artist)}</span>
        </button>
        <div className="sidebar-mini-player__actions">
          <button type="button" onClick={playPrev} aria-label={t("上一首")} title={t("上一首")}>
            <SkipBack size={17} />
          </button>
          <button type="button" onClick={togglePlay} aria-label={isPlaying ? t("暂停") : t("播放")} title={isPlaying ? t("暂停") : t("播放")}>
            {isBuffering && isPlaying ? <Loader2 size={17} className="animate-spin" /> : isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </button>
          <button type="button" onClick={playNext} aria-label={t("下一首")} title={t("下一首")}>
            <SkipForward size={17} />
          </button>
          <button
            type="button"
            className={`sidebar-mini-player__queue ${playlistBouncing ? 'animate-playlist-bounce text-[var(--accent-strong)]' : ''}`}
            onClick={() => setIsPlaylistOpen(true)}
            aria-label={t("打开播放列表")}
            title={t("打开播放列表")}
          >
            <ListMusic size={17} />
          </button>
        </div>
      </div>
    </section>
  );
}
