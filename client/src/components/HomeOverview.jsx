import React from 'react';
import { ArrowRight, Pause, Play } from 'lucide-react';
import LazyImage from './LazyImage.jsx';
import HistoryCoverStack from './HistoryCoverStack.jsx';
import TrackRow from './TrackRow.jsx';
import ArtistPreviewRow from './catalog/ArtistPreviewRow.jsx';
import SectionHeading from './catalog/SectionHeading.jsx';
import SongColumnShelf from './catalog/SongColumnShelf.jsx';
import HorizontalScrollButtons from './catalog/HorizontalScrollButtons.jsx';
import { horizontalScrollState, moveHorizontalScroll } from './catalog/horizontalScroll.js';
import AlbumPreviewGrid from './catalog/AlbumPreviewGrid.jsx';
import { hasPreviewOverflow } from './catalog/previewVisibility.js';
import { hydrateSong } from '../utils.js';
import { deriveTopArtists } from '../utils/topArtists.js';
import { getPlaylistCoverUrls } from '../utils/playlistCover.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { usePlayHistoryStore, formatRelativeTime } from '../store/usePlayHistoryStore.js';
import editorialArtBg from '../assets/editorial-art-bg.jpg';

function shuffleList(list, offset = 1) {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i--) {
    const j = (i * 7 + offset * 11) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function FeaturedCardShelf({ children }) {
  const viewportRef = React.useRef(null);
  const [canScroll, setCanScroll] = React.useState({ left: false, right: false });

  const updateScroll = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setCanScroll((previous) => {
      const { left, right } = horizontalScrollState(viewport);
      const next = { left, right };
      return previous.left === next.left && previous.right === next.right ? previous : next;
    });
  }, []);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    updateScroll();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScroll);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [updateScroll]);

  const move = (direction) => {
    const viewport = viewportRef.current;
    const card = viewport?.querySelector('.editorial-card');
    if (!card) return;
    const gap = parseFloat(getComputedStyle(viewport).gap) || 0;
    const pitch = card.getBoundingClientRect().width + gap;
    moveHorizontalScroll(viewport, direction, pitch);
  };

  return <section className="editorial-grid" aria-label="精选内容">
    <div ref={viewportRef} className="editorial-grid__viewport" onScroll={updateScroll}
      tabIndex={0} role="region" aria-label="精选内容，横向滚动查看更多">
      {children}
    </div>
    <HorizontalScrollButtons canScroll={canScroll} onMove={move} label="精选卡片" />
  </section>;
}

export default function HomeOverview({
  playlists = [],
  songsMap = {},
  favoritePlaylist,
  favoriteDetail,
  likedSongs = [],
  randomSongs = [],
  resolvedTopSongs = [],
  topAlbums = [],
  currentSong,
  isPlaying,
  playSong,
  openPlaylist,
  onOpenHistory,
  onNavigateRoam,
  onOpenArtist,
  onOpenTopSongs,
  onOpenTopAlbums,
  onOpenTopArtists,
  onOpenAlbum,
  onToggleRoam,
  randomRoam,
  likedSongIdSet = new Set(),
  toggleLikedWithFeedback,
  insertNextWithFeedback,
  openAddToPlaylist,
  accountStatus,
  accountError,
  onRetryAccount,
}) {
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const history = usePlayHistoryStore((s) => s.history);
  const [artistVisibleCount, setArtistVisibleCount] = React.useState(0);
  const [albumVisibleCount, setAlbumVisibleCount] = React.useState(0);
  const [songScrollOverflow, setSongScrollOverflow] = React.useState(false);

  const displayFootprints = resolvedTopSongs.slice(0, 20);

  // 聚合常听歌手（Top 4）
  const topArtists = React.useMemo(() => deriveTopArtists(resolvedTopSongs), [resolvedTopSongs]);

  // 解析我的收藏歌曲（确保封面与音频流完整 hydrate）
  const leadPlaylist = React.useMemo(() => favoritePlaylist
    ? { ...favoritePlaylist, source: 'member' }
    : playlists[0] || null, [favoritePlaylist, playlists]);
  const leadPlaylistSongs = React.useMemo(() => {
    const rawList = favoriteDetail?.songs || likedSongs || [];
    return rawList.map(hydrateSong).filter(Boolean);
  }, [favoriteDetail?.songs, likedSongs]);

  const leadPlaylistTitle = React.useMemo(() => {
    if (!leadPlaylist) return '我的收藏';
    if (leadPlaylist.kind === 'favorite' || ['我的收藏', '我喜欢'].includes(leadPlaylist.name)) {
      return '我的收藏';
    }
    return leadPlaylist.name || '我的收藏';
  }, [leadPlaylist]);

  const leadPlaylistCover = getPlaylistCoverUrls({ ...leadPlaylist, songs: leadPlaylistSongs }, songsMap)[0];

  // 提取用于卡片 A 照片墙流的多张去重有效封面（多级真实封面蓄水池，坚决绝迹 placeholder）
  const leadPlaylistCovers = React.useMemo(() => {
    const urls = [];
    const seen = new Set();
    const isValidCover = (url) => (
      url &&
      typeof url === 'string' &&
      url !== '/placeholder-album.svg' &&
      !url.includes('placeholder') &&
      !seen.has(url)
    );

    const addCover = (url) => {
      if (isValidCover(url)) {
        seen.add(url);
        urls.push(url);
      }
    };

    // 1. 首选：主打歌单（我喜欢）内歌曲封面
    for (const song of leadPlaylistSongs) {
      addCover(song?.cover_url);
      if (urls.length >= 10) break;
    }

    // 2. 次选：若不足 8 张，从常听单曲 topSongs 中补充真实封面
    if (urls.length < 8) {
      for (const song of resolvedTopSongs) {
        addCover(song?.cover_url);
        if (urls.length >= 10) break;
      }
    }

    // 3. 三级补充：若仍不足 8 张，从曲库 randomSongs 补充真实封面
    if (urls.length < 8) {
      for (const song of randomSongs) {
        addCover(song?.cover_url);
        if (urls.length >= 10) break;
      }
    }

    // 4. 补充歌单自身预览封面
    const preview = leadPlaylist?.previewCovers || leadPlaylist?.preview_covers;
    if (Array.isArray(preview)) {
      for (const url of preview) {
        addCover(url);
        if (urls.length >= 10) break;
      }
    }

    return urls;
  }, [leadPlaylistSongs, leadPlaylist, resolvedTopSongs, randomSongs]);

  // 构建用于无限循环跑马灯的双排封面队列（去重后至少 3 张才启用跑马灯）
  const marqueeRows = React.useMemo(() => {
    if (leadPlaylistCovers.length < 3) return null;
    const pool = leadPlaylistCovers.slice(0, 10);
    let base = [...pool];
    while (base.length < 6) {
      base = base.concat(pool);
    }
    const r1 = shuffleList(base, 3);
    const r2 = shuffleList(base, 7);
    return {
      row1: [...r1, ...r1],
      row2: [...r2, ...r2],
    };
  }, [leadPlaylistCovers]);

  // 焦点单曲推荐
  const featuredSongs = React.useMemo(() => {
    const pool = randomSongs?.length ? randomSongs : likedSongs;
    return pool.map(hydrateSong).filter(Boolean).slice(0, 8);
  }, [randomSongs, likedSongs]);
  const leadSong = featuredSongs[0] || null;

  // 提取用于卡片 B 3D 折叠扇（Fan-out）的前 3 首封面与单曲
  const fanoutSongs = React.useMemo(() => {
    const list = [];
    const seen = new Set();
    for (const song of featuredSongs) {
      const url = song?.cover_url;
      if (url && url !== '/placeholder-album.svg' && !seen.has(url)) {
        seen.add(url);
        list.push(song);
      }
      if (list.length >= 3) break;
    }
    return list;
  }, [featuredSongs]);

  // 打开完整的今日精选歌曲界面
  const handleOpenDailyRecommend = (e) => {
    if (!featuredSongs.length) return;
    if (typeof openPlaylist === 'function') {
      openPlaylist({
        id: 'daily-recommend',
        name: '今日精选',
        cover_url: leadSong?.cover_url,
        preloadedSongs: featuredSongs,
        description: `每日精选 ${featuredSongs.length} 首灵感推荐`,
      }, e);
    }
  };

  // 播放状态感知
  const isLeadPlaylistActive = Boolean(currentSong && leadPlaylistSongs.some((s) => String(s.id) === String(currentSong?.id)));
  const isLeadPlaylistPlaying = isLeadPlaylistActive && isPlaying;

  const isLeadSongActive = Boolean(currentSong && leadSong && String(currentSong?.id) === String(leadSong?.id));
  const isLeadSongPlaying = isLeadSongActive && isPlaying;

  const handleLeadPlaylistPlay = (e) => {
    e.stopPropagation();
    if (!leadPlaylist) return;
    if (isLeadPlaylistPlaying) {
      togglePlay();
      return;
    }
    if (isLeadPlaylistActive) {
      togglePlay();
      return;
    }
    if (leadPlaylistSongs.length > 0) {
      playSong(leadPlaylistSongs[0], leadPlaylistSongs);
    } else {
      openPlaylist(leadPlaylist);
    }
  };

  const handleLeadSongPlay = (e) => {
    e.stopPropagation();
    if (!leadSong) return;
    if (isLeadSongPlaying) {
      togglePlay();
      return;
    }
    if (isLeadSongActive) {
      togglePlay();
      return;
    }
    playSong(leadSong, featuredSongs);
  };

  return (
    <div className="app-page home-overview">
      <header className="app-page-heading">
        <h1>主页</h1>
      </header>

      {/* 焦点内容 */}
      <FeaturedCardShelf>
        {/* 卡片 A：我的收藏 */}
        <button
          type="button"
          className={`editorial-card editorial-card--library ${isLeadPlaylistPlaying ? 'is-playing' : ''}`}
          onClick={(event) => leadPlaylist && openPlaylist(leadPlaylist, event)}
          data-playlist-id={leadPlaylist?.id}
          disabled={!leadPlaylist}
        >
          {marqueeRows ? (
            <div className="editorial-card__marquee" aria-hidden="true">
              <div className="editorial-card__marquee-track">
                <div className="editorial-card__marquee-row editorial-card__marquee-row--left">
                  {marqueeRows.row1.map((url, idx) => (
                    <div key={`mq1-${idx}-${url}`} className="editorial-card__marquee-item">
                      <LazyImage src={url} fallback="/placeholder-album.svg" alt="" />
                    </div>
                  ))}
                </div>
                <div className="editorial-card__marquee-row editorial-card__marquee-row--right">
                  {marqueeRows.row2.map((url, idx) => (
                    <div key={`mq2-${idx}-${url}`} className="editorial-card__marquee-item">
                      <LazyImage src={url} fallback="/placeholder-album.svg" alt="" />
                    </div>
                  ))}
                </div>
              </div>
              <span className="editorial-card__scrim editorial-card__scrim--marquee" />
            </div>
          ) : (
            <>
              <div className="editorial-card__art-backdrop" aria-hidden="true">
                <img src={editorialArtBg} alt="" />
              </div>
              {leadPlaylistCover && leadPlaylistCover !== '/placeholder-album.svg' ? (
                <LazyImage src={leadPlaylistCover} fallback="/placeholder-album.svg" alt="" className="editorial-card__image" />
              ) : null}
              <span className="editorial-card__scrim" />
            </>
          )}
          <span className="editorial-card__copy">
            <strong>{leadPlaylistTitle}</strong>
            <span>
              {leadPlaylistSongs.length > 0
                ? `${leadPlaylistSongs.length} 首歌曲`
                : (leadPlaylist ? `${leadPlaylist.songCount || 0} 首歌曲` : '曲库准备好后会出现在这里')}
            </span>
          </span>
          {leadPlaylist && (
            <span
              className={`editorial-card__play ${isLeadPlaylistPlaying ? 'is-active' : ''}`}
              role="button"
              aria-label={`${isLeadPlaylistPlaying ? '暂停' : '播放'} ${leadPlaylistTitle}`}
              onClick={handleLeadPlaylistPlay}
            >
              {isLeadPlaylistPlaying ? (
                <Pause size={18} fill="currentColor" aria-hidden="true" />
              ) : (
                <Play size={18} fill="currentColor" aria-hidden="true" />
              )}
            </span>
          )}
        </button>

        {/* 卡片 B：今日精选灵感曲目 */}
        <button
          type="button"
          className={`editorial-card editorial-card--song ${isLeadSongPlaying ? 'is-playing' : ''}`}
          onClick={(event) => leadSong && handleOpenDailyRecommend(event)}
          disabled={!leadSong}
        >
          {fanoutSongs.length >= 2 ? (
            <>
              <div className="editorial-card__art-backdrop" aria-hidden="true">
                <img src={editorialArtBg} alt="" />
              </div>
              <div className="editorial-card__ambient-blur" aria-hidden="true">
                <LazyImage
                  src={(fanoutSongs[1]?.cover_url && fanoutSongs[1].cover_url !== '/placeholder-album.svg') ? fanoutSongs[1].cover_url : leadSong?.cover_url || '/placeholder-album.svg'}
                  fallback="/placeholder-album.svg"
                  alt=""
                />
              </div>
              <span className="editorial-card__scrim editorial-card__scrim--ambient" />
              <div className="editorial-card__fanout-container" aria-hidden="true">
                {fanoutSongs.map((song, idx) => (
                  <div key={`fan-${song.id || idx}`} className="editorial-card__fanout-card">
                    <LazyImage src={song.cover_url || '/placeholder-album.svg'} fallback="/placeholder-album.svg" alt="" />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="editorial-card__art-backdrop" aria-hidden="true">
                <img src={editorialArtBg} alt="" />
              </div>
              <LazyImage src={leadSong?.cover_url || '/placeholder-album.svg'} fallback="/placeholder-album.svg" alt="" className="editorial-card__image" />
              <span className="editorial-card__scrim" />
            </>
          )}
          <span className="editorial-card__copy">
            <span className="editorial-card__kicker">
              {isLeadSongPlaying ? (
                <span className="editorial-card__playing-indicator" aria-label="正在播放">
                  <span />
                  <span />
                  <span />
                </span>
              ) : null}
              <span>今日精选</span>
            </span>
            <strong>{leadSong?.title || '等待新的旋律'}</strong>
            <span>{leadSong?.artist || '探索更多曲目'}</span>
          </span>
          {leadSong && (
            <span
              className={`editorial-card__play ${isLeadSongPlaying ? 'is-active' : ''}`}
              role="button"
              aria-label={isLeadSongPlaying ? `暂停 ${leadSong.title}` : `播放 ${leadSong.title}`}
              onClick={handleLeadSongPlay}
            >
              {isLeadSongPlaying ? (
                <Pause size={18} fill="currentColor" aria-hidden="true" />
              ) : (
                <Play size={18} fill="currentColor" aria-hidden="true" />
              )}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`editorial-card editorial-card--history ${history.length ? 'has-history' : 'is-empty'}`}
          onClick={onOpenHistory}
          aria-label={`打开播放历史，共 ${history.length} 首记录`}
        >
          <HistoryCoverStack history={history} />
          <span className="editorial-card__scrim editorial-card__scrim--history" />
          <span className="editorial-card__copy">
            <strong>播放历史</strong>
            <span>{history.length > 0
              ? `${history.length} 首歌曲 · ${formatRelativeTime(history[0].playedAt)}听过`
              : '播放过的歌曲会出现在这里'}</span>
          </span>
          <span className="editorial-card__play" aria-hidden="true"><ArrowRight size={19} strokeWidth={2.3} /></span>
        </button>
      </FeaturedCardShelf>

      {accountStatus === 'error' && (
        <div className="app-inline-notice" role="alert">
          <span>{accountError?.message || '个人歌单暂时不可用。'}</span>
          <button type="button" className="app-section-link" onClick={onRetryAccount}>重试</button>
        </div>
      )}

      {/* 专区一：常听单曲 (Top Tracks) */}
      <section className="app-content-section" aria-labelledby="home-footprints-title">
        <div className="app-section-heading">
          <div>
            <SectionHeading id="home-footprints-title" title="常听单曲"
              className="text-[clamp(22px,2vw,27px)] font-bold text-[var(--ink)]"
              onViewAll={hasPreviewOverflow({ renderedCount: displayFootprints.length,
                visibleCount: displayFootprints.length, totalCount: resolvedTopSongs.length,
                scrollOverflow: songScrollOverflow }) ? onOpenTopSongs : null} />
          </div>
          {displayFootprints.length > 0 && (
            <button
              type="button"
              className="app-section-link"
              onClick={() => playSong(displayFootprints[0], displayFootprints)}
            >
              <Play size={14} fill="currentColor" aria-hidden="true" />
              <span>播放全部</span>
            </button>
          )}
        </div>
        {displayFootprints.length > 0 ? (
          <SongColumnShelf label="常听单曲" onOverflowChange={setSongScrollOverflow}>
            {displayFootprints.map((song) => (
              <TrackRow
                key={`footprint-${song.id}`}
                song={song}
                songs={displayFootprints}
                currentSong={currentSong}
                isPlaying={isPlaying}
                playSong={playSong}
                isLiked={likedSongIdSet.has(String(song.id))}
                onToggleLiked={toggleLikedWithFeedback}
                onInsertNext={insertNextWithFeedback}
                onAddToPlaylist={(selectedSong, event) => openAddToPlaylist(selectedSong, event)}
              />
            ))}
          </SongColumnShelf>
        ) : (
          <div className="home-empty-footprints">
            <div className="home-empty-footprints__text">
              <h4>暂无常听单曲</h4>
            </div>
            {onToggleRoam && (
              <button
                type="button"
                onClick={onToggleRoam}
                className="home-empty-footprints__btn"
              >
                <Play size={12} fill="currentColor" />
                <span>开启随心漫游</span>
              </button>
            )}
          </div>
        )}
      </section>

      {topAlbums.length > 0 && (
        <section className="app-content-section" aria-labelledby="home-albums-title">
          <div className="app-section-heading">
            <div>
              <SectionHeading id="home-albums-title" title="常听专辑"
                className="text-[clamp(22px,2vw,27px)] font-bold text-[var(--ink)]"
                onViewAll={hasPreviewOverflow({ renderedCount: Math.min(topAlbums.length, 10),
                  visibleCount: albumVisibleCount, totalCount: topAlbums.length }) ? onOpenTopAlbums : null} />
            </div>
          </div>
          <AlbumPreviewGrid albums={topAlbums.slice(0, 10)} onOpen={onOpenAlbum}
            onVisibleCountChange={setAlbumVisibleCount} />
        </section>
      )}

      {/* 专区二：常听歌手 (Favorite Artists) */}
      {topArtists.length > 0 && (
        <section className="app-content-section" aria-labelledby="home-artists-title">
          <div className="app-section-heading">
            <div>
              <SectionHeading id="home-artists-title" title="常听歌手"
                className="text-[clamp(22px,2vw,27px)] font-bold text-[var(--ink)]"
                onViewAll={hasPreviewOverflow({ renderedCount: topArtists.length,
                  visibleCount: artistVisibleCount }) ? onOpenTopArtists : null} />
            </div>
          </div>
          <ArtistPreviewRow artists={topArtists} onOpen={onOpenArtist}
            onVisibleCountChange={setArtistVisibleCount} />
        </section>
      )}
    </div>
  );
}
