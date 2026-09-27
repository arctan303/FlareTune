import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Play, Pause, ListPlus } from 'lucide-react';
import LazyImage from './LazyImage.jsx';
import TrackRow from './TrackRow.jsx';
import { hydrateSong } from '../utils.js';
import {
  getArtistPhotoApiBase,
  ARTIST_PHOTO_CACHE,
  preloadAndDecodeImage,
} from '../hooks/useArtistPhotos.js';
import { showToast, useUIStore } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import { readArtist } from '../services/catalogRead.js';
import { useCatalogPage } from '../hooks/useCatalogPage.js';
import SongColumnShelf from './catalog/SongColumnShelf.jsx';
import AlbumPreviewGrid from './catalog/AlbumPreviewGrid.jsx';
import SectionHeading from './catalog/SectionHeading.jsx';
import { hasPreviewOverflow } from './catalog/previewVisibility.js';
import PageBackButton from './PageBackButton.jsx';
import { formatPath, returnToParentRoute, syncBrowserHistory } from '../utils/navigation.js';

export default function ArtistDetailView({
  artist,
  onBack,
  currentSong,
  isPlaying,
  onPlaySong,
  onInsertNext,
  onAddToPlaylist,
  onToggleLiked,
  isSongLiked,
  isAuthenticated,
}) {
  const containerRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [songScrollOverflow, setSongScrollOverflow] = useState(false);
  const [albumVisibleCount, setAlbumVisibleCount] = useState(0);

  const currentSubView = artist?.view || 'overview';

  const navigateSubView = (targetView) => {
    if (targetView === 'overview') {
      const overviewUrl = formatPath({ type: 'artist', name: artist?.name, view: 'overview' });
      if (returnToParentRoute(overviewUrl) === 'replace') {
        useUIStore.getState().openArtistDrawer({ ...artist, view: 'overview' });
      }
      return;
    }
    syncBrowserHistory(formatPath({ type: 'artist', name: artist?.name, view: targetView }));
    useUIStore.getState().openArtistDrawer({ ...artist, view: targetView });
  };

  // 监听祖先滚动容器的滚动进度，实现 Apple Music 视差虚化与元素蜕变
  useEffect(() => {
    const scrollEl = containerRef.current?.closest('.collection-scroll') || window;
    const handleScroll = () => {
      const top = scrollEl === window ? window.scrollY : scrollEl.scrollTop;
      setScrollTop(top || 0);
    };
    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, []);

  const artistName = artist?.name || '';
  const fallbackCover = artist?.coverUrl || '';
  const [artistPhoto, setArtistPhoto] = useState(null);
  const [isPhotoLoading, setIsPhotoLoading] = useState(false);

  const [fetchedSongs, setFetchedSongs] = useState([]);
  const [songsStatus, setSongsStatus] = useState('loading');
  const [artistPage, setArtistPage] = useState({ hasMore: false, total: 0, loadingMore: false });
  const albumResults = useCatalogPage('albums', { artist: artistName, limit: currentSubView === 'albums' ? 50 : 10 });

  // Use the artist endpoint so the full view is not capped by the first search page.
  useEffect(() => {
    const name = artistName.trim();
    if (!name) return;
    const controller = new AbortController();
    setFetchedSongs([]);
    setSongsStatus('loading');
    readArtist(name, { signal: controller.signal })
      .then((data) => { setFetchedSongs(data.songs); setArtistPage({ hasMore: data.hasMore, total: data.total, loadingMore: false }); setSongsStatus('ready'); })
      .catch((error) => { if (error.name !== 'AbortError') { console.warn('获取歌手歌曲失败:', error); setSongsStatus('error'); } });
    return () => controller.abort();
  }, [artistName]);

  const loadMoreArtistSongs = async () => {
    if (!artistPage.hasMore || artistPage.loadingMore) return;
    setArtistPage((previous) => ({ ...previous, loadingMore: true }));
    try {
      const data = await readArtist(artistName, { offset: fetchedSongs.length });
      setFetchedSongs((previous) => [...previous, ...data.songs]);
      setArtistPage({ hasMore: data.hasMore, total: data.total, loadingMore: false });
    } catch {
      setArtistPage((previous) => ({ ...previous, loadingMore: false }));
    }
  };

  // 解析并格式化歌曲列表
  const songs = useMemo(() => {
    if (fetchedSongs.length > 0) {
      return fetchedSongs.map((s) => hydrateSong(s));
    }
    if (Array.isArray(artist?.songs) && artist.songs.length > 0) {
      return artist.songs.map((s) => hydrateSong(s));
    }
    return [];
  }, [artist?.songs, fetchedSongs]);

  const albums = albumResults.items;
  const openAlbum = (album) => syncBrowserHistory(formatPath({ type: 'album', id: album.id }));

  // 获取歌手高清写真
  useEffect(() => {
    if (!artistName.trim()) {
      setArtistPhoto(null);
      return;
    }

    const trimmed = artistName.trim();
    if (ARTIST_PHOTO_CACHE.has(trimmed)) {
      const cached = ARTIST_PHOTO_CACHE.get(trimmed);
      if (Array.isArray(cached) && cached.length > 0 && cached[0]?.url) {
        setArtistPhoto(cached[0].url);
        preloadAndDecodeImage(cached[0].url);
        return;
      }
    }

    let isCancelled = false;
    setIsPhotoLoading(true);

    const apiBase = getArtistPhotoApiBase();
    authenticatedFetch(`${apiBase}/api/artist-photo?name=${encodeURIComponent(trimmed)}`, { credentials: 'include' })
      .then((res) => res.json())
      .then(async (data) => {
        if (isCancelled) return;
        const photos = data?.data?.photos || [];
        ARTIST_PHOTO_CACHE.set(trimmed, photos);
        if (photos.length > 0 && photos[0]?.url) {
          const photoUrl = photos[0].url;
          await preloadAndDecodeImage(photoUrl);
          if (!isCancelled) {
            setArtistPhoto(photoUrl);
          }
        }
      })
      .catch((err) => {
        console.warn('Failed to fetch artist photo for view:', err);
      })
      .finally(() => {
        if (!isCancelled) setIsPhotoLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [artistName]);

  // 视觉大片兜底：写真优先 -> 外部传入封面 -> 第一首歌曲专辑封面
  const firstSongCover = songs.length > 0 ? (songs[0].cover_url || songs[0].coverUrl) : '';
  const displayAvatar = artistPhoto || fallbackCover || firstSongCover;

  // 播放全部
  const handlePlayAll = () => {
    if (songs.length > 0 && onPlaySong) {
      onPlaySong(songs[0], songs);
      showToast(`已开始播放 ${artistName} 的全部歌曲`);
    }
  };

  // 全部添加至队尾
  const handleQueueAll = () => {
    if (songs.length > 0) {
      const player = usePlayerStore.getState();
      const count = player.appendSongs(songs);
      showToast(count > 0 ? `已将 ${count} 首歌曲添加至播放列表` : '歌曲已在播放列表中');
    }
  };

  const isCurrentArtistPlaying = isPlaying && currentSong && (
    (currentSong.artist || '').toLowerCase() === artistName.toLowerCase() ||
    (currentSong.artist_name || '').toLowerCase() === artistName.toLowerCase()
  );

  const isScrolled = scrollTop > 240;
  const parallaxOffset = Math.round(scrollTop * 0.22);
  const heroContentOpacity = Math.max(0, 1 - scrollTop / 260).toFixed(3);
  const heroContentTranslateY = Math.round(-scrollTop * 0.18);

  const scrollToTop = () => {
    const scrollEl = containerRef.current?.closest('.collection-scroll') || window;
    if (scrollEl.scrollTo) {
      scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // =========================================================================
  // 二级视图 1: 全部歌曲列表页 (/artist/:name/songs) - 清爽白独立页面
  // =========================================================================
  if (currentSubView === 'songs') {
    return (
      <div ref={containerRef} className="app-page artist-detail-page !pt-0 !mt-0 relative min-h-screen pb-24 overflow-x-hidden">
        <div className="artist-subview-page">
          {/* 面包屑返回条 */}
          <div className="flex items-center justify-between mb-8">
            <PageBackButton onClick={() => navigateSubView('overview')} />
          </div>

          {/* 页面主标题与快捷控制栏 */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-8 mb-6 border-b border-[var(--line)]">
            <div>
              <h1 className="text-3xl sm:text-4xl font-extrabold text-[var(--ink)] tracking-tight">
                歌曲
              </h1>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={isCurrentArtistPlaying ? () => usePlayerStore.getState().togglePlay() : handlePlayAll}
                disabled={songs.length === 0}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-sm font-semibold shadow-sm hover:scale-103 active:scale-95 transition-all cursor-pointer disabled:opacity-40"
              >
                {isCurrentArtistPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
                <span>{isCurrentArtistPlaying ? '暂停' : '播放全部'}</span>
              </button>

              <button
                type="button"
                onClick={handleQueueAll}
                disabled={songs.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full border border-[var(--line)] bg-[var(--surface)] hover:bg-[color-mix(in_srgb,var(--ink)_6%,var(--surface))] text-[var(--ink)] text-sm font-semibold transition-all cursor-pointer disabled:opacity-30 active:scale-95"
                title="添加至队尾"
              >
                <ListPlus size={16} />
                <span>加到队尾</span>
              </button>
            </div>
          </div>

          {/* 全量歌曲列表 */}
          {songs.length > 0 ? (
            <div className="full-song-grid">
              {songs.map((song) => (
                <TrackRow
                  key={song.id}
                  song={song}
                  songs={songs}
                  currentSong={currentSong}
                  isPlaying={isPlaying}
                  playSong={onPlaySong}
                  isLiked={isSongLiked?.(song)}
                  onToggleLiked={onToggleLiked}
                  onInsertNext={onInsertNext}
                  onAddToPlaylist={onAddToPlaylist}
                />
              ))}
              {artistPage.hasMore && <button type="button" className="secondary-button col-span-full mx-auto mt-6 px-4 py-2" onClick={loadMoreArtistSongs} disabled={artistPage.loadingMore}>{artistPage.loadingMore ? '加载中…' : '加载更多'}</button>}
            </div>
          ) : songsStatus === 'loading' ? (
            <p role="status" className="py-10 text-center text-sm text-[var(--muted)]">正在加载歌曲…</p>
          ) : songsStatus === 'error' ? (
            <p role="alert" className="py-10 text-center text-sm text-[var(--muted)]">歌曲加载失败</p>
          ) : (
            <div className="theme-empty text-xs py-14 rounded-2xl border-0 bg-[var(--surface)] text-[var(--muted)] flex flex-col items-center justify-center gap-2 shadow-xs">
              <span>该歌手暂无可播放歌曲</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // 二级视图 2: 全部专辑网格页 (/artist/:name/albums) - 清爽白独立页面
  // =========================================================================
  if (currentSubView === 'albums') {
    return (
      <div ref={containerRef} className="app-page artist-detail-page !pt-0 !mt-0 relative min-h-screen pb-24 overflow-x-hidden">
        <div className="artist-subview-page">
          {/* 面包屑返回条 */}
          <div className="flex items-center justify-between mb-8">
            <PageBackButton onClick={() => navigateSubView('overview')} />
          </div>

          {/* 页面主标题 */}
          <div className="pb-8 mb-6 border-b border-[var(--line)]">
            <h1 className="text-3xl sm:text-4xl font-extrabold text-[var(--ink)] tracking-tight">
              专辑
            </h1>
          </div>

          {/* 全量专辑网格 */}
          {albums.length > 0 ? (
            <>
              <AlbumPreviewGrid albums={albums} maxRows={Infinity} onOpen={openAlbum} />
              {albumResults.hasMore && <button type="button" className="secondary-button mt-6 px-4 py-2" onClick={albumResults.loadMore} disabled={albumResults.loadingMore}>{albumResults.loadingMore ? '加载中…' : '加载更多'}</button>}
            </>
          ) : albumResults.status === 'loading' ? (
            <p role="status" className="py-10 text-center text-sm text-[var(--muted)]">正在加载专辑…</p>
          ) : albumResults.status === 'error' ? (
            <p role="alert" className="py-10 text-center text-sm text-[var(--muted)]">专辑加载失败</p>
          ) : (
            <div className="theme-empty text-xs py-14 rounded-2xl border-0 bg-[var(--surface)] text-[var(--muted)] flex flex-col items-center justify-center gap-2 shadow-xs">
              <span>该歌手暂无收录专辑</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // 主视图: 歌手橱窗页 (/artist/:name) - 歌曲最多展示 20 首，专辑最多展示 10 张
  // =========================================================================
  const visibleSongs = songs.slice(0, 20);
  const visibleAlbums = albums.slice(0, 10);

  return (
    <div ref={containerRef} className="app-page artist-detail-page !pt-0 !mt-0 relative min-h-screen pb-24 overflow-x-hidden">
      {/* 1. 顶部 Apple Music 风格吸顶毛玻璃导航条 (滚动超过 240px 时展开呈现 mini 控制台) */}
      <header
        className={`artist-sticky-bar ${isScrolled ? 'artist-sticky-bar--scrolled' : ''}`}
        aria-label="歌手页面导航"
      >
        <PageBackButton onClick={onBack} onHero className="pointer-events-auto" />

        {/* 中间：迷你歌手信息 (仅滚动后淡入，点击可平滑置顶) */}
        <div
          onClick={scrollToTop}
          className={`pointer-events-auto flex items-center gap-2.5 transition-all duration-300 cursor-pointer select-none ${
            isScrolled ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 -translate-y-2 scale-95 pointer-events-none'
          }`}
          title="点击返回顶部"
        >
          {displayAvatar && (
            <img
              src={displayAvatar}
              alt=""
              className="w-7 h-7 rounded-full object-cover shadow-xs border border-white/30"
            />
          )}
          <span className="text-sm font-bold text-[var(--ink)] truncate max-w-[200px] sm:max-w-[320px]">
            {artistName}
          </span>
        </div>

        {/* 右侧：迷你播放控制钮 (仅滚动后淡入) */}
        <div
          className={`pointer-events-auto flex items-center gap-2 transition-all duration-300 ${
            isScrolled ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none'
          }`}
        >
          <button
            type="button"
            onClick={isCurrentArtistPlaying ? () => usePlayerStore.getState().togglePlay() : handlePlayAll}
            disabled={songs.length === 0}
            className="w-8 h-8 rounded-full bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white flex items-center justify-center shadow-md hover:scale-105 active:scale-95 transition-transform cursor-pointer disabled:opacity-40"
            title={isCurrentArtistPlaying ? '暂停' : '播放全部'}
            aria-label={isCurrentArtistPlaying ? '暂停' : '播放全部'}
          >
            {isCurrentArtistPlaying ? (
              <Pause size={14} fill="currentColor" />
            ) : (
              <Play size={14} fill="currentColor" className="ml-0.5" />
            )}
          </button>
        </div>
      </header>

      {/* 2. Apple Music 全宽沉浸式写真巨幕 (顶格无白缝、微视差下沉、平滑消融底) */}
      <section
        aria-label="歌手视觉大图"
        className="relative w-full h-[460px] sm:h-[520px] md:h-[560px] -mt-[58px] overflow-hidden select-none z-0"
      >
        {displayAvatar ? (
          <div
            className="absolute inset-0 w-full h-full will-change-transform"
            style={{
              transform: `translate3d(0, ${parallaxOffset}px, 0)`,
            }}
          >
            {/* 写真两侧镜像延展相邻边缘，主体保持原比例与清晰度。 */}
            <div className="artist-hero-photo-row absolute inset-0 overflow-hidden">
              <div className="artist-hero-edge" aria-hidden="true">
                <img src={displayAvatar} alt="" />
              </div>
              <img src={displayAvatar} alt={artistName} className="artist-hero-main-photo" />
              <div className="artist-hero-edge" aria-hidden="true">
                <img src={displayAvatar} alt="" />
              </div>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 bg-neutral-900" />
        )}

        {/* 顶部微弱暗角：保证未滚动时的返回按钮随时高对比度可读 */}
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/35 via-black/10 to-transparent pointer-events-none z-10" />

        {/* 底部自然环境消融羽化：精准融入当前主题的 --page 底色，彻底告别死黑与脏色断层 */}
        <div className="absolute inset-x-0 bottom-0 h-44 sm:h-56 artist-hero-bottom-fade pointer-events-none z-10" />

        {/* 居中艺人名与核心控制器 (悬浮在海报底部，随滚动优雅淡出) */}
        <div
          className="absolute inset-x-0 bottom-6 sm:bottom-10 z-20 flex flex-col items-center justify-center text-center px-4 will-change-transform pointer-events-auto"
          style={{
            transform: `translate3d(0, ${heroContentTranslateY}px, 0)`,
            opacity: heroContentOpacity,
            pointerEvents: isScrolled ? 'none' : 'auto',
          }}
        >
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-black tracking-tight text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.85)] mb-6">
            {artistName}
          </h1>

          {/* Apple Music 标志性操控圆钮组 */}
          <div className="flex items-center gap-4">
            {/* 1. 超大纯白主播放圆钮 (首要动作) */}
            <button
              type="button"
              onClick={isCurrentArtistPlaying ? () => usePlayerStore.getState().togglePlay() : handlePlayAll}
              disabled={songs.length === 0}
              className="w-[60px] h-[60px] sm:w-16 sm:h-16 shrink-0 rounded-full bg-white text-neutral-950 flex items-center justify-center shadow-[0_8px_30px_rgba(0,0,0,0.35)] hover:scale-[1.08] active:scale-95 transition-transform cursor-pointer disabled:opacity-40"
              title={isCurrentArtistPlaying ? '暂停' : '播放全部'}
              aria-label={isCurrentArtistPlaying ? '暂停' : '播放全部'}
            >
              {isCurrentArtistPlaying ? (
                <Pause size={24} fill="currentColor" />
              ) : (
                <Play size={24} fill="currentColor" className="ml-1" />
              )}
            </button>

            {/* 2. 添加至队尾 (次要动作) */}
            <button
              type="button"
              onClick={handleQueueAll}
              disabled={songs.length === 0}
              className="w-11 h-11 rounded-full bg-white/20 hover:bg-white/35 text-white backdrop-blur-xl border border-white/25 flex items-center justify-center shadow-lg hover:scale-[1.08] active:scale-95 transition-all cursor-pointer disabled:opacity-30"
              title="添加至队尾"
              aria-label="添加至队尾"
            >
              <ListPlus size={18} />
            </button>
          </div>
        </div>
      </section>

      {/* 3. 下方内容主体 (清爽通透，在当前主题背景上舒展呈现，不再有死黑长条挤压) */}
      <div className="relative z-20 w-full mx-auto px-6 sm:px-10 lg:px-12 space-y-12 pt-6">
        {/* 歌曲预览按列排列，超过 20 首可进入完整列表。 */}
        <section aria-labelledby="artist-tracks-title" className="space-y-4">
          <div className="flex items-center justify-between pb-1">
            <SectionHeading id="artist-tracks-title" title="歌曲"
              className="text-xl sm:text-2xl font-bold text-[var(--ink)] tracking-tight"
              onViewAll={hasPreviewOverflow({ renderedCount: visibleSongs.length,
                visibleCount: visibleSongs.length, totalCount: artistPage.total || songs.length,
                hasMore: artistPage.hasMore, scrollOverflow: songScrollOverflow,
              }) ? () => navigateSubView('songs') : null} />
          </div>

          {visibleSongs.length > 0 ? (
            <SongColumnShelf key={artistName} label="歌曲" onOverflowChange={setSongScrollOverflow}>
              {visibleSongs.map((song) => (
                <TrackRow
                  key={song.id}
                  song={song}
                  songs={songs}
                  currentSong={currentSong}
                  isPlaying={isPlaying}
                  playSong={onPlaySong}
                  isLiked={isSongLiked?.(song)}
                  onToggleLiked={onToggleLiked}
                  onInsertNext={onInsertNext}
                  onAddToPlaylist={onAddToPlaylist}
                />
              ))}
            </SongColumnShelf>
          ) : songsStatus === 'loading' ? (
            <p role="status" className="py-10 text-center text-sm text-[var(--muted)]">正在加载歌曲…</p>
          ) : songsStatus === 'error' ? (
            <p role="alert" className="py-10 text-center text-sm text-[var(--muted)]">歌曲加载失败</p>
          ) : (
            <div className="theme-empty text-xs py-14 rounded-2xl border-0 bg-[var(--surface)] text-[var(--muted)] flex flex-col items-center justify-center gap-2 shadow-xs">
              <span>该歌手暂无可播放歌曲</span>
            </div>
          )}
        </section>

        {/* 专辑预览最多两排，标题可进入完整列表。 */}
        {albums.length > 0 && (
          <section aria-labelledby="artist-albums-title" className="space-y-4 pt-2">
            <div className="flex items-center justify-between pb-1">
              <SectionHeading id="artist-albums-title" title="专辑"
                className="text-xl sm:text-2xl font-bold text-[var(--ink)] tracking-tight"
                onViewAll={hasPreviewOverflow({ renderedCount: visibleAlbums.length,
                  visibleCount: albumVisibleCount, totalCount: albumResults.total ?? albums.length,
                  hasMore: albumResults.hasMore,
                }) ? () => navigateSubView('albums') : null} />
            </div>

            <AlbumPreviewGrid albums={visibleAlbums} onOpen={openAlbum}
              onVisibleCountChange={setAlbumVisibleCount} />
          </section>
        )}
      </div>
    </div>
  );
}
