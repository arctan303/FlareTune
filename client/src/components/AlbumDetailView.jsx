import { useMusicSourcesRevision } from '../hooks/useMusicSourcesRevision.js';
import { getMusicSourcesRevision } from '../services/musicSources.js';
import { isYouTubeEntity } from '../utils/musicSource.js';
import { t } from '../i18n/index.js';
import React from 'react';
import { Play } from 'lucide-react';
import { readAlbum, peekCachedAlbum } from '../services/catalogRead.js';
import CollectionDetailSkeleton from './catalog/CollectionDetailSkeleton.jsx';
import { SettingsButton } from './SettingsControls.jsx';
import LazyImage from './LazyImage.jsx';
import TrackRow from './TrackRow.jsx';
import CollectionDetailPage from './catalog/CollectionDetailPage.jsx';
import PageBackButton from './PageBackButton.jsx';
import { resolveCoverUrl } from '../utils.js';

export default function AlbumDetailView({ id, onBack, currentSong, isPlaying, onPlaySong, onInsertNext, onAddToPlaylist, onToggleLiked, isSongLiked }) {
  const sourceRevision = useMusicSourcesRevision();
  const albumRevision = isYouTubeEntity(id) ? sourceRevision : 0;
  const cachedAlbum = peekCachedAlbum(id);
  const [retry, setRetry] = React.useState(0);
  const [state, setState] = React.useState(() => ({ id, sourceRevision: albumRevision, status: cachedAlbum ? 'ready' : 'loading', album: cachedAlbum, reveal: false }));
  React.useEffect(() => {
    const controller = new AbortController();
    const cached = peekCachedAlbum(id);
    setState(previous => {
      const available = cached || (previous.id === id && previous.sourceRevision === albumRevision ? previous.album : null);
      return { id, sourceRevision: albumRevision, status: available ? 'ready' : 'loading', album: available, refreshing: Boolean(available), reveal: false };
    });
    readAlbum(id, controller.signal)
      .then((album) => { if (!controller.signal.aborted && (!isYouTubeEntity(id) || albumRevision === getMusicSourcesRevision())) setState({ id, sourceRevision: albumRevision, status: 'ready', album, reveal: !cached }); })
      .catch((error) => { if (!controller.signal.aborted && error.name !== 'AbortError' && (!isYouTubeEntity(id) || albumRevision === getMusicSourcesRevision())) setState(previous => ({
        ...previous, id, sourceRevision: albumRevision, status: previous.album ? 'ready' : 'error', refreshing: false, error: true, reveal: false,
      })); });
    return () => controller.abort();
  }, [id, retry, albumRevision]);
  const current = state.id === id && state.sourceRevision === albumRevision ? state : { status: cachedAlbum ? 'ready' : 'loading', album: cachedAlbum, reveal: false };
  if (current.status === 'loading') return <CollectionDetailSkeleton onBack={onBack} />;
  if (current.status === 'error') return <div className="app-page state-panel" role="alert"><PageBackButton onClick={onBack} className="mb-4" /><p>{t("专辑暂时无法打开。")}</p><SettingsButton onClick={() => setRetry(value => value + 1)}>{t('重试')}</SettingsButton></div>;
  const album = current.album;
  const songs = (album.songs || []).map((song) => song.cover_url || song.coverUrl
    ? song
    : { ...song, cover_url: album.coverUrl });
  return (
    <CollectionDetailPage className={current.reveal ? 'catalog-results' : ''} kind={t("专辑")} title={album.title} subtitle={album.artist} onBack={onBack}
      cover={<LazyImage src={resolveCoverUrl(album.coverUrl)} fallback="/placeholder-album.svg" alt={t("{p0} 专辑封面", { p0: (album.title) })} className="h-full w-full object-cover" />}
      actions={songs.length > 0 && <button type="button" className="primary-button inline-flex items-center gap-2 px-5 py-2.5" onClick={() => onPlaySong(songs[0], songs)}><Play size={16} fill="currentColor" aria-hidden="true" />{t("播放全部")}</button>}>
      {current.refreshing && <p role="status" className="mb-4 text-sm text-[var(--muted)]">{t('刷新中…')}</p>}
      {current.error && <div className="app-inline-notice mb-4" role="alert"><span>{t("专辑暂时无法打开。")}</span><SettingsButton onClick={() => setRetry(value => value + 1)}>{t('重试')}</SettingsButton></div>}
      {songs.length > 0 ? <div className="track-list track-list--detail">
        {songs.map((song, index) => <TrackRow key={song.id} song={song} songs={songs} index={index} variant="detail"
          currentSong={currentSong} isPlaying={isPlaying} playSong={onPlaySong}
          isLiked={isSongLiked(song)} onToggleLiked={onToggleLiked} onInsertNext={onInsertNext} onAddToPlaylist={onAddToPlaylist} />)}
      </div> : <div className="theme-empty py-12">{t("暂无可播放歌曲")}</div>}
    </CollectionDetailPage>
  );
}
