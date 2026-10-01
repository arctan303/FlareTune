import { localizeUnknownArtist, t } from '../i18n/index.js';
import React from 'react';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { usePlayHistoryStore, formatRelativeTime } from '../store/usePlayHistoryStore.js';
import { showToast } from '../store/useUIStore.js';
import LazyImage from './LazyImage.jsx';
import SongActionsMenu from './catalog/SongActionsMenu.jsx';
import PageBackButton from './PageBackButton.jsx';

function HistorySongRow({ song, index, isActive, isLiked, onPlay, onToggleLiked, onInsertNext, onAddToPlaylist, onRemove }) {
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const [isPendingLiked, setIsPendingLiked] = React.useState(false);
  const moreButtonRef = React.useRef(null);

  const closeMenu = React.useCallback(() => {
    setIsMenuOpen(false);
    moreButtonRef.current?.focus();
  }, []);

  const toggleLiked = async (targetSong, event) => {
    if (isPendingLiked) return;
    setIsPendingLiked(true);
    try { await onToggleLiked(targetSong, event); }
    finally { setIsPendingLiked(false); }
  };

  return <li className={`play-history-page__row ${isActive ? 'is-active' : ''}`}>
    <span className="play-history-page__index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
    <button type="button" className="play-history-page__song" onClick={() => onPlay(song)} aria-label={t("播放 {p0}", { p0: (song.title) })}>
      <span className="play-history-page__cover">
        <LazyImage src={song.cover_url || '/placeholder-album.svg'} fallback="/placeholder-album.svg" alt="" />
      </span>
      <span className="play-history-page__song-copy">
        <strong>{song.title}</strong>
        <span>{localizeUnknownArtist(song.artist)}</span>
        <span className="play-history-page__song-time">{formatRelativeTime(song.playedAt)}</span>
      </span>
    </button>
    <button type="button" ref={moreButtonRef} className="play-history-page__more"
      onClick={() => setIsMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={isMenuOpen}
      aria-label={t("歌曲选项：{p0}", { p0: (song.title) })} title={t("歌曲选项")}>
      <MoreHorizontal size={20} aria-hidden="true" />
    </button>
    {isMenuOpen && <SongActionsMenu song={song} anchorRef={moreButtonRef} onClose={closeMenu}
      isLiked={isLiked} isLikePending={isPendingLiked} onToggleLiked={toggleLiked} onInsertNext={onInsertNext}
      onAddToPlaylist={onAddToPlaylist} onRemove={() => onRemove(song.id)}
      removeLabel={t("从历史移除")} autoFocusFirstItem />}
  </li>;
}

export default function PlayHistoryView({ onBack, likedSongIdSet = new Set(), onToggleLiked, onInsertNext, onAddToPlaylist }) {
  const listSpaceRef = React.useRef(null);
  const [listWidth, setListWidth] = React.useState(0);
  const history = usePlayHistoryStore((state) => state.history);
  const removeSong = usePlayHistoryStore((state) => state.removeSong);
  const clearHistory = usePlayHistoryStore((state) => state.clearHistory);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const playSong = usePlayerStore((state) => state.playSong);

  const playHistorySong = (song) => {
    playSong(song, [song]);
    showToast(t("正在播放《{p0}》", { p0: (song.title) }));
  };

  React.useLayoutEffect(() => {
    const element = listSpaceRef.current;
    if (!element) return undefined;
    const updateWidth = () => setListWidth(element.clientWidth);
    updateWidth();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateWidth);
    observer?.observe(element);
    if (!observer) window.addEventListener('resize', updateWidth);
    return () => {
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', updateWidth);
    };
  }, [history.length]);

  const widthColumns = Math.max(1, Math.min(3, Math.floor((listWidth + 24) / 424)));
  const songColumns = Math.max(1, Math.min(3, Math.ceil(history.length / 3)));
  const columns = Math.min(widthColumns, songColumns);
  const rows = Math.ceil(history.length / columns);

  return (
    <div className="app-page play-history-page">
      <PageBackButton className="mb-4" onClick={onBack} />
      <header className="app-page-heading play-history-page__heading">
        <h1>{t("播放历史")}</h1>
        <div className="play-history-page__heading-actions">
          <span className="play-history-page__count">{history.length}{' '}{t("首歌曲")}</span>
          {history.length > 0 && (
            <button type="button" className="play-history-page__clear" onClick={() => {
              clearHistory();
              showToast(t("已清空播放历史"));
            }}>
              <Trash2 size={17} aria-hidden="true" />{t("清空历史")}</button>
          )}
        </div>
      </header>
      {history.length === 0 ? (
        <div className="play-history-page__empty" role="status">
          <p>{t("暂无播放历史")}</p>
        </div>
      ) : (
        <div ref={listSpaceRef} className="play-history-page__list-space">
          <section className="play-history-page__section" aria-label={t("最近播放的歌曲")} style={{
            '--history-columns': columns,
            '--history-rows': rows,
            '--history-max-width': `${columns * 520 + (columns - 1) * 24}px`,
          }}>
            <ol className="play-history-page__list">
              {history.map((song, index) => (
                <HistorySongRow key={song.id} song={song} index={index}
                  isActive={String(currentSong?.id) === String(song.id)}
                  isLiked={likedSongIdSet.has(String(song.id))} onPlay={playHistorySong}
                  onToggleLiked={onToggleLiked} onInsertNext={onInsertNext}
                  onAddToPlaylist={onAddToPlaylist} onRemove={removeSong} />
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
