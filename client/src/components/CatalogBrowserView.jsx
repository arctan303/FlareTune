import React from 'react';
import { EXPLORE_PRESETS } from '../constants/explore.js';
import { useCatalogPage } from '../hooks/useCatalogPage.js';
import { useUIStore } from '../store/useUIStore.js';
import { formatPath, returnToParentRoute, syncBrowserHistory } from '../utils/navigation.js';
import TrackRow from './TrackRow.jsx';
import ArtistCard from './catalog/ArtistCard.jsx';
import ArtistPreviewRow from './catalog/ArtistPreviewRow.jsx';
import SectionHeading from './catalog/SectionHeading.jsx';
import SongColumnShelf from './catalog/SongColumnShelf.jsx';
import AlbumPreviewGrid from './catalog/AlbumPreviewGrid.jsx';
import { hasPreviewOverflow } from './catalog/previewVisibility.js';
import PageBackButton from './PageBackButton.jsx';

const TYPES = [
  { key: 'songs', label: '歌曲' },
  { key: 'artists', label: '歌手' },
  { key: 'albums', label: '专辑' },
];

export default function CatalogBrowserView({ route, onBack, currentSong, isPlaying, onPlaySong, onInsertNext, onAddToPlaylist, onToggleLiked, isSongLiked }) {
  const [artistVisibleCount, setArtistVisibleCount] = React.useState(0);
  const [albumVisibleCount, setAlbumVisibleCount] = React.useState(0);
  const [songScrollOverflow, setSongScrollOverflow] = React.useState(false);
  const language = route.language;
  const view = route.view || 'overview';
  const selected = TYPES.some((type) => type.key === view) ? view : 'overview';
  const songs = useCatalogPage('songs', { language, limit: 20, enabled: selected === 'overview' || selected === 'songs' });
  const artists = useCatalogPage('artists', { language, limit: selected === 'artists' ? 20 : 7, enabled: selected === 'overview' || selected === 'artists' });
  const albums = useCatalogPage('albums', { language, limit: selected === 'albums' ? 20 : 10, enabled: selected === 'overview' || selected === 'albums' });
  const datasets = { songs, artists, albums };
  const navigate = (target) => {
    const url = formatPath({ type: 'explore', language, view: target });
    if (target === 'overview') returnToParentRoute(url);
    else syncBrowserHistory(url);
  };
  const openArtist = (artist) => useUIStore.getState().openArtistDrawer({ name: artist.name, coverUrl: artist.photoUrl || artist.coverUrl });
  const openAlbum = (album) => syncBrowserHistory(formatPath({ type: 'album', id: album.id }));
  const label = EXPLORE_PRESETS[language]?.subtitle || EXPLORE_PRESETS[language]?.label || '曲库';
  const renderItems = (type, items) => {
    if (type === 'songs') return selected === 'overview' ? <SongColumnShelf key={language} label="歌曲" onOverflowChange={setSongScrollOverflow}>{items.map((song) => <TrackRow key={song.id} song={song} songs={items}
      currentSong={currentSong} isPlaying={isPlaying} playSong={onPlaySong} isLiked={isSongLiked(song)}
      onToggleLiked={onToggleLiked} onInsertNext={onInsertNext} onAddToPlaylist={onAddToPlaylist} />)}</SongColumnShelf>
      : <div className="home-track-grid">{items.map((song) => <TrackRow key={song.id} song={song} songs={items}
      currentSong={currentSong} isPlaying={isPlaying} playSong={onPlaySong} isLiked={isSongLiked(song)}
      onToggleLiked={onToggleLiked} onInsertNext={onInsertNext} onAddToPlaylist={onAddToPlaylist} />)}</div>;
    if (type === 'artists') return selected === 'overview'
      ? <ArtistPreviewRow artists={items} onOpen={openArtist} onVisibleCountChange={setArtistVisibleCount} />
      : <div className="artist-full-grid">{items.map((artist) => <ArtistCard key={artist.name} artist={artist} onOpen={openArtist} />)}</div>;
    if (selected === 'overview') return <AlbumPreviewGrid albums={items} onOpen={openAlbum}
      onVisibleCountChange={setAlbumVisibleCount} />;
    return <AlbumPreviewGrid albums={items} maxRows={Infinity} onOpen={openAlbum} />;
  };
  return <div className="app-page catalog-browser-page pb-24">
    <PageBackButton onClick={selected === 'overview' ? onBack : () => navigate('overview')} className="mb-5" />
    <h1 className="text-3xl sm:text-4xl font-bold mb-8 text-[var(--ink)]">{selected === 'overview' ? label : TYPES.find((type) => type.key === selected).label}</h1>
    <div className="space-y-12">{TYPES.filter((type) => selected === 'overview' || type.key === selected).map(({ key, label: title }) => {
      const data = datasets[key];
      const previewLimit = key === 'songs' ? 20 : key === 'albums' ? 10 : 6;
      const items = selected === 'overview' ? data.items.slice(0, previewLimit) : data.items;
      return <section key={key} className="space-y-4" aria-label={title}>
        {selected === 'overview' && <SectionHeading title={title} onViewAll={hasPreviewOverflow({
          renderedCount: items.length,
          visibleCount: key === 'artists' ? artistVisibleCount : key === 'albums' ? albumVisibleCount : items.length,
          totalCount: data.total ?? data.items.length, hasMore: data.hasMore,
          scrollOverflow: key === 'songs' && songScrollOverflow,
        }) ? () => navigate(key) : null} />}
        {data.status === 'loading' ? <p role="status" className="text-sm text-[var(--muted)]">正在加载…</p>
          : data.status === 'error' ? <p role="alert" className="text-sm text-[var(--muted)]">{title}加载失败</p>
            : items.length ? renderItems(key, items) : <p className="text-sm text-[var(--muted)]">暂无{title}</p>}
        {selected !== 'overview' && data.hasMore && <button type="button" className="secondary-button px-4 py-2" onClick={data.loadMore} disabled={data.loadingMore}>{data.loadingMore ? '加载中…' : '加载更多'}</button>}
      </section>;
    })}</div>
  </div>;
}
