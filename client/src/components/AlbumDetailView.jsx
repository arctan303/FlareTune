import React from 'react';
import { Play } from 'lucide-react';
import { readAlbum } from '../services/catalogRead.js';
import LazyImage from './LazyImage.jsx';
import TrackRow from './TrackRow.jsx';
import CollectionDetailPage from './catalog/CollectionDetailPage.jsx';
import PageBackButton from './PageBackButton.jsx';
import { resolveCoverUrl } from '../utils.js';

export default function AlbumDetailView({ id, onBack, currentSong, isPlaying, onPlaySong, onInsertNext, onAddToPlaylist, onToggleLiked, isSongLiked }) {
  const [state, setState] = React.useState({ status: 'loading', album: null });
  React.useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', album: null });
    readAlbum(id, controller.signal)
      .then((album) => setState({ status: 'ready', album }))
      .catch((error) => { if (error.name !== 'AbortError') setState({ status: 'error', album: null }); });
    return () => controller.abort();
  }, [id]);
  if (state.status === 'loading') return <div className="app-page" role="status">正在加载专辑…</div>;
  if (state.status === 'error') return <div className="app-page state-panel" role="alert"><PageBackButton onClick={onBack} className="mb-4" /><p>专辑暂时无法打开。</p></div>;
  const album = state.album;
  const songs = (album.songs || []).map((song) => song.cover_url || song.coverUrl
    ? song
    : { ...song, cover_url: album.coverUrl });
  return (
    <CollectionDetailPage kind="专辑" title={album.title} subtitle={album.artist} onBack={onBack}
      cover={<LazyImage src={resolveCoverUrl(album.coverUrl)} fallback="/placeholder-album.svg" alt={`${album.title} 专辑封面`} className="h-full w-full object-cover" />}
      actions={songs.length > 0 && <button type="button" className="primary-button inline-flex items-center gap-2 px-5 py-2.5" onClick={() => onPlaySong(songs[0], songs)}><Play size={16} fill="currentColor" aria-hidden="true" />播放全部</button>}>
      {songs.length > 0 ? <div className="track-list track-list--detail">
        {songs.map((song, index) => <TrackRow key={song.id} song={song} songs={songs} index={index} variant="detail"
          currentSong={currentSong} isPlaying={isPlaying} playSong={onPlaySong}
          isLiked={isSongLiked(song)} onToggleLiked={onToggleLiked} onInsertNext={onInsertNext} onAddToPlaylist={onAddToPlaylist} />)}
      </div> : <div className="theme-empty py-12">暂无可播放歌曲</div>}
    </CollectionDetailPage>
  );
}
