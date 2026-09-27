import React from 'react';
import {
  Calendar,
  ChevronRight,
  Compass,
  Disc,
  Headphones,
  Flame,
  Loader2,
  Play,
  RefreshCw,
  SlidersHorizontal,
  User,
} from 'lucide-react';
import TrackRow from './TrackRow.jsx';
import LazyImage from './LazyImage.jsx';
import { usePlayStatsStore } from '../store/usePlayStatsStore.js';
import { useUIStore } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { useSpotlightArtist } from '../hooks/useSpotlightArtist.js';
import { hydrateSong } from '../utils.js';
import {
  fillSongMetadata,
  songHasValidLanguage,
} from '../resolveSongs.js';

function RandomPicksColumn({
  dateHeaderTag,
  dateZhTag,
  songs,
  loading,
  refreshing,
  coolingDown,
  error,
  currentSong,
  isPlaying,
  likedSongIdSet,
  onRefresh,
  onPlay,
  onOpenPlaylist,
  onToggleLiked,
  onInsertNext,
  onAddToPlaylist,
}) {
  const handleOpenFullPlaylist = () => {
    if (typeof onOpenPlaylist === 'function' && songs.length > 0) {
      onOpenPlaylist({
        id: 'daily-recommend',
        name: `今日推荐 · ${dateZhTag}`,
        cover_url: songs[0]?.cover_url,
        preloadedSongs: songs,
        description: `每日随机精选 ${songs.length} 首灵感曲目`,
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        className="sound-escape-header-bar group relative select-none"
        title={dateZhTag ? `今日精选 · ${dateZhTag}（查看完整推荐列表）` : '查看完整推荐列表'}
      >
        <button
          type="button"
          className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
          onClick={handleOpenFullPlaylist}
          disabled={songs.length === 0}
          aria-label="打开完整随机推荐列表"
        />
        {/* 左侧：极简单行 日历图标 + 今日精选 */}
        <div className="relative z-10 pointer-events-none flex items-center gap-2 min-w-0 pr-2">
          <Calendar size={14} className="text-[var(--accent)] shrink-0" aria-hidden="true" />
          <h4 className="text-sm font-semibold tracking-wide text-[var(--ink)] group-hover:text-[var(--accent)] transition-colors truncate">
            今日精选
          </h4>
        </div>

        {/* 右侧：刷新、播放以及打开完整随机列表的简单箭头 */}
        <div className="relative z-10 flex items-center gap-1 sm:gap-1.5 shrink-0 flex-nowrap">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            disabled={refreshing || loading || coolingDown}
            className={`inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5 px-2 py-1.5 rounded-lg transition-colors border-0 ${
              refreshing || loading || coolingDown ? 'opacity-50 cursor-default' : 'cursor-pointer'
            }`}
            title="刷新推荐"
            aria-label="刷新推荐"
          >
            {refreshing ? (
              <Loader2 size={13} className="animate-spin text-[var(--accent)]" aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            <span>刷新</span>
          </button>

          {songs.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPlay(songs[0], songs);
              }}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent)] hover:text-[var(--accent-strong)] hover:bg-current/5 px-2 py-1.5 rounded-lg transition-colors border-0 shrink-0 cursor-pointer"
              title="播放推荐曲目"
            >
              <Play size={13} fill="currentColor" className="ml-0.5" aria-hidden="true" />
              <span>播放</span>
            </button>
          )}

          {songs.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleOpenFullPlaylist();
              }}
              className="p-1.5 text-[var(--muted)] group-hover:text-[var(--ink)] hover:text-[var(--ink)] hover:bg-current/5 rounded-lg transition-colors cursor-pointer shrink-0 flex items-center justify-center border-0"
              title="打开完整随机列表"
              aria-label="打开完整随机列表"
            >
              <ChevronRight size={17} strokeWidth={2.2} className="transition-transform group-hover:translate-x-0.5" />
            </button>
          )}
        </div>
      </div>

      <div className="sound-escape-tracks-panel flex-1">
        {loading && (!songs || songs.length === 0) ? (
          <div className="flex flex-col gap-2.5 sm:gap-3" aria-busy="true" aria-label="正在加载推荐曲目">
            {[0, 1, 2].map((slotIdx) => (
              <div
                key={`random-skeleton-slot-${slotIdx}`}
                className="h-14 rounded-2xl bg-[var(--surface-sunken)]/50 border border-[var(--line)] flex items-center px-3 gap-3.5 animate-pulse select-none"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--surface-raised)] shrink-0" />
                <div className="flex-1 space-y-2 min-w-0">
                  <div className="h-3.5 w-2/5 rounded bg-[var(--surface-raised)]" />
                  <div className="h-2.5 w-1/4 rounded bg-[var(--surface-raised)]" />
                </div>
              </div>
            ))}
          </div>
        ) : songs && songs.length > 0 ? (
          <div
            className={`flex flex-col gap-2.5 sm:gap-3 transition-opacity duration-300 ease-out ${
              refreshing ? 'opacity-65' : 'opacity-100'
            }`}
          >
            {songs.slice(0, 3).map((song, index) => (
              <TrackRow
                key={`random-slot-${index}`}
                song={song}
                songs={songs}
                currentSong={currentSong}
                isPlaying={isPlaying}
                playSong={onPlay}
                isLiked={likedSongIdSet.has(String(song.id))}
                onToggleLiked={onToggleLiked}
                onInsertNext={onInsertNext}
                onAddToPlaylist={onAddToPlaylist}
              />
            ))}
          </div>
        ) : error ? (
          <div className="theme-empty text-xs py-6" role="alert">{error}，点击右上角刷新重试</div>
        ) : (
          <div className="theme-empty text-xs py-6">暂无随机推荐，点击刷新试试</div>
        )}
      </div>
    </div>
  );
}

function RandomRoamColumn({
  randomRoam,
  onOpenSettings,
  onToggle,
  currentSong,
  isPlaying,
  likedSongIdSet,
  onPlay,
  onOpenPlaylist,
  onToggleLiked,
  onInsertNext,
  onAddToPlaylist,
  songsMap,
  likedSongs,
}) {
  const topSongs = usePlayStatsStore((s) => s.topSongs);
  const playCounts = usePlayStatsStore((s) => s.playCounts);
  const totalPlays = usePlayStatsStore((s) => s.totalPlays);

  // 弱更新保障（Stale-While-Revalidate）：优先展示本地/内存已有的有效数据，并在异步重构期间使用上一份缓存保底，彻底避免空状态闪烁跳变
  const lastResolvedSongsRef = React.useRef([]);
  const resolvedTopSongs = React.useMemo(() => {
    if (Array.isArray(topSongs) && topSongs.length > 0) {
      const playerState = usePlayerStore.getState();
      const hydrated = topSongs.map((s) => {
        let song = hydrateSong(s);
        if (!songHasValidLanguage(song)) {
          song = fillSongMetadata(song, { knownSongsMap: songsMap, playerState });
        }
        return song;
      });
      lastResolvedSongsRef.current = hydrated;
      return hydrated;
    }
    if (lastResolvedSongsRef.current.length > 0) {
      return lastResolvedSongsRef.current;
    }
    return [];
  }, [topSongs]);

  const lastTotalPlaysRef = React.useRef(0);
  const visibleTotalPlays = React.useMemo(() => {
    if (totalPlays > 0) {
      lastTotalPlaysRef.current = totalPlays;
      return totalPlays;
    }
    return lastTotalPlaysRef.current || 0;
  }, [totalPlays]);

  // 计算累计收听时长
  const totalDurationSeconds = React.useMemo(() => {
    if (!resolvedTopSongs.length) return 0;
    return resolvedTopSongs.reduce((sum, song) => {
      const plays = song.play_count || playCounts[song.id] || 1;
      const dur = Number(song.duration) || 210;
      return sum + (dur * plays);
    }, 0);
  }, [resolvedTopSongs, playCounts]);

  const { durationDisplay, durationUnit } = React.useMemo(() => {
    if (totalDurationSeconds < 60) {
      return { durationDisplay: '<1', durationUnit: 'm' };
    }
    const totalMinutes = Math.round(totalDurationSeconds / 60);
    if (totalMinutes < 60) {
      return { durationDisplay: `${totalMinutes}`, durationUnit: 'm' };
    }
    const hours = (totalDurationSeconds / 3600).toFixed(1);
    return { durationDisplay: `${hours}`, durationUnit: 'h' };
  }, [totalDurationSeconds]);

  // 从曲库中聚合计算保底备用歌手列表（兼容 Map/Array/Object）
  const fallbackSongs = React.useMemo(() => {
    const resolveSongList = (source) => {
      if (!source) return [];
      if (Array.isArray(source)) return source;
      if (source instanceof Map || typeof source.values === 'function') {
        return Array.from(source.values());
      }
      if (typeof source === 'object') {
        return Object.values(source);
      }
      return [];
    };

    const rawList = resolveSongList(songsMap);
    return rawList.length > 0
      ? rawList
      : (Array.isArray(likedSongs) && likedSongs.length > 0 ? likedSongs : resolvedTopSongs);
  }, [songsMap, likedSongs, resolvedTopSongs]);

  // 全曲库随机歌手与换一位交互接入
  const {
    spotlightArtist,
    spotlightSongs,
    spotlightCover,
    spotlightPhoto,
    spotlightCount,
    isRefreshing: isArtistRefreshing,
    isSwitching: isArtistSwitching,
    refresh: refreshSpotlightArtist,
  } = useSpotlightArtist(true, fallbackSongs);

  const featuredArtist = spotlightArtist;
  const featuredArtistSongs = spotlightSongs;
  const featuredArtistCover = spotlightPhoto || spotlightCover;

  const setIsFootprintDrawerOpen = useUIStore((s) => s.setIsFootprintDrawerOpen);

  const handleOpenFootprint = () => {
    setIsFootprintDrawerOpen(true);
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* 顶部独立 Header 条：与左侧等高、等边框、等材质 */}
      <div className="sound-escape-header-bar flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <h4 className="text-sm font-semibold tracking-wide text-[var(--ink)] truncate">
            随机漫游
          </h4>
          <span className="flex items-center gap-1.5 text-[11px] font-medium shrink-0 ml-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${randomRoam.enabled ? 'bg-[var(--accent)] animate-pulse' : 'bg-[var(--muted)] opacity-40'}`} />
            <span className={randomRoam.enabled ? 'text-[var(--accent)] font-semibold' : 'text-[var(--muted)]'}>
              {randomRoam.enabled ? '续播中' : '已暂停'}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5 px-2 py-1.5 rounded-lg transition-colors border-0 cursor-pointer"
            title="漫游设置（多选语种与范围）"
            aria-label="漫游设置"
          >
            <SlidersHorizontal size={13} className="text-[var(--accent)]" />
            <span>设置</span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={randomRoam.enabled}
            aria-pressed={randomRoam.enabled}
            onClick={onToggle}
            title={randomRoam.enabled ? '点击关闭随机漫游' : '点击开启随机漫游'}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${randomRoam.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line)]'}`}
          >
            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-xs ring-0 transition duration-200 ease-in-out ${randomRoam.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
      </div>

      {/* 下部解体出来的两个独立卡片！并列为两列，撑满剩余空间 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 items-stretch">
        {/* 左半区：常听足迹 (TOP 3 极简饱满三联画) */}
        {resolvedTopSongs.length > 0 ? (
          <button
            type="button"
            onClick={handleOpenFootprint}
            className="sound-escape-subcard group text-left h-full flex flex-col justify-between p-3.5 sm:p-4 rounded-2xl bg-[var(--surface-raised)] border border-[var(--line)] hover:border-[var(--line-strong)] hover:shadow-xs transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            title="打开常听足迹分析抽屉"
          >
            <div className="flex items-center justify-between w-full pb-2 border-b border-[var(--line)]">
              <div className="flex items-center gap-1.5">
                <Headphones size={13} className="text-[var(--accent)] shrink-0" aria-hidden="true" />
                <h5 className="text-xs sm:text-sm font-bold text-[var(--ink)]">常听足迹</h5>
              </div>
              <span className="sound-escape-subcard__badge text-[10px] font-mono text-[var(--muted)] bg-[var(--surface)] px-1.5 py-0.5 rounded border border-[var(--line)] shrink-0">
                TOP {Math.min(3, resolvedTopSongs.length)}
              </span>
            </div>

            {/* 中间：前 3 首极简常听单曲条目 */}
            <div className="flex flex-col gap-2 my-auto py-2 w-full">
              {resolvedTopSongs.slice(0, 3).map((song, idx) => {
                const plays = song.play_count || playCounts[song.id] || 1;
                return (
                  <div key={song.id || idx} className="flex items-center gap-2.5 min-w-0 w-full">
                    <span className="font-mono text-[10px] text-[var(--muted)] w-3 shrink-0 text-center font-bold">
                      {idx + 1}
                    </span>
                    <div className="relative w-8 h-8 rounded-lg overflow-hidden bg-[var(--surface-sunken)] border border-[var(--line)] shrink-0 shadow-xs">
                      {song.cover_url ? (
                        <LazyImage src={song.cover_url} alt={song.title} className="w-full h-full object-cover" />
                      ) : (
                        <Disc size={14} className="text-[var(--muted)] m-auto" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-[var(--ink)] truncate group-hover:text-[var(--accent)] transition-colors">
                        {song.title}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-[var(--muted)] shrink-0">
                      {plays}次
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between text-[11px] text-[var(--muted)] group-hover:text-[var(--ink)] transition-colors w-full pt-2 border-t border-[var(--line)]">
              <span className="text-[10px] font-mono text-[var(--muted)]">累计 {visibleTotalPlays}次 · {durationDisplay}{durationUnit}</span>
              <ChevronRight size={13} className="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </div>
          </button>
        ) : (
          <div className="sound-escape-subcard h-full flex flex-col items-center justify-center p-4 text-center rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface-sunken)]/40">
            <div className="w-8 h-8 rounded-full bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] flex items-center justify-center text-[var(--accent)] mb-1.5">
              <Headphones size={15} />
            </div>
            <p className="text-xs font-semibold text-[var(--ink)]">暂无常听数据</p>
            <p className="text-[10px] text-[var(--muted)] mt-0.5 leading-snug">
              单曲满 30 秒自动记录
            </p>
          </div>
        )}

        {/* 右半区：焦点音乐人 (写真 + 馆藏精选作品 + 换一位刷新) */}
        {featuredArtist ? (
          <div
            className="sound-escape-subcard relative group text-left h-full flex flex-col justify-between p-3.5 sm:p-4 rounded-2xl bg-[var(--surface-raised)] border border-[var(--line)] hover:border-[var(--line-strong)] hover:shadow-xs transition-all select-none"
            title={`探索 ${featuredArtist} 全部歌曲`}
          >
            {/* 底层透明热区：整卡点击打开歌手专区抽屉 */}
            <button
              type="button"
              onClick={() => {
                if (featuredArtistSongs.length > 0) {
                  useUIStore.getState().openArtistDrawer({
                    name: featuredArtist,
                    songs: featuredArtistSongs,
                    coverUrl: featuredArtistCover,
                  });
                }
              }}
              className="absolute inset-0 z-0 rounded-[inherit] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] border-0 bg-transparent p-0"
              aria-label={`探索 ${featuredArtist} 全部歌曲`}
            />

            <div className="relative z-10 flex items-center justify-between w-full pb-2 border-b border-[var(--line)] pointer-events-none">
              <div className="flex items-center gap-1.5">
                <User size={13} className="text-[var(--accent)] shrink-0" aria-hidden="true" />
                <h5 className="text-xs sm:text-sm font-bold text-[var(--ink)]">焦点音乐人</h5>
              </div>
              <div className="flex items-center pointer-events-auto">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    refreshSpotlightArtist();
                  }}
                  disabled={isArtistRefreshing}
                  className={`inline-flex items-center gap-1 text-[11px] font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/5 px-1.5 py-0.5 rounded transition-colors border-0 whitespace-nowrap ${
                    isArtistRefreshing ? 'opacity-50 cursor-default' : 'cursor-pointer'
                  }`}
                  title="换一位歌手"
                  aria-label="换一位歌手"
                >
                  <RefreshCw
                    size={11}
                    className={isArtistRefreshing ? 'animate-spin text-[var(--accent)]' : ''}
                    aria-hidden="true"
                  />
                  <span className="whitespace-nowrap">换一位</span>
                </button>
              </div>
            </div>

            {/* 歌手个人写真与代表作 (居中呈现) */}
            <div
              className={`relative z-10 pointer-events-none flex flex-col items-center justify-center my-auto py-2 w-full text-center transition-all duration-300 ease-out ${
                isArtistSwitching ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
              }`}
            >
              <div className="relative w-14 h-14 sm:w-16 sm:h-16 rounded-full overflow-hidden bg-[var(--surface-sunken)] border-2 border-[var(--line)] shadow-sm flex items-center justify-center shrink-0 group-hover:scale-105 group-hover:border-[var(--accent)] transition-all duration-300">
                {featuredArtistCover ? (
                  <LazyImage src={featuredArtistCover} alt={featuredArtist} className="w-full h-full object-cover" />
                ) : (
                  <User size={24} className="text-[var(--muted)] m-auto" />
                )}
              </div>
              <p
                className="text-xs sm:text-sm font-bold text-[var(--ink)] mt-2.5 max-w-[90%] truncate group-hover:text-[var(--accent)] transition-colors"
                title={featuredArtist}
              >
                {featuredArtist}
              </p>
              {featuredArtistSongs[0] && (
                <div className="mt-2 flex items-center justify-center gap-1.5 max-w-[92%] px-3 py-1 rounded-full bg-[var(--surface-sunken)] border border-[var(--line)] text-xs text-[var(--muted)] group-hover:text-[var(--ink)] group-hover:border-[var(--line-strong)] transition-all">
                  <Disc size={12} className="text-[var(--accent)] shrink-0" aria-hidden="true" />
                  <span className="truncate">{featuredArtistSongs[0].title}</span>
                </div>
              )}
            </div>

            <div className="relative z-10 pointer-events-none flex items-center justify-between text-[11px] text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors w-full pt-2 border-t border-[var(--line)]">
              <span className="text-[10px] text-[var(--muted)]">探索全部作品</span>
              <ChevronRight size={13} className="transition-transform group-hover:translate-x-0.5 text-[var(--muted)] group-hover:text-[var(--ink)]" aria-hidden="true" />
            </div>
          </div>
        ) : (
          <div className="sound-escape-subcard h-full flex flex-col items-center justify-center p-4 text-center rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface-sunken)]/40">
            <div className="w-8 h-8 rounded-full bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] flex items-center justify-center text-[var(--accent)] mb-1.5">
              <User size={15} />
            </div>
            <p className="text-xs font-semibold text-[var(--ink)]">音乐人馆藏</p>
            <p className="text-[10px] text-[var(--muted)] mt-0.5 leading-snug">
              探索曲库中收录的多元歌手
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function HomeFeaturedSection(props) {
  const {
    likedSongs, currentSong, isPlaying, playSong, openPlaylist,
    insertNextWithFeedback, randomSongs, isRandomLoading, isRandomRefreshing,
    isRandomCoolingDown, randomError, dateHeaderTag, dateZhTag, likedSongIdSet,
    toggleLikedWithFeedback, openAddToPlaylist, handleRefreshRandomSongs,
    randomRoam, setIsRoamSettingsOpen, handleStartRandomRoam, songsMap,
  } = props;

  return (
    <section className="collection-section" aria-labelledby="featured-title">
      <div className="collection-section__header mb-4">
        <p className="collection-section__index whitespace-nowrap">01 / INSPIRATION & ROAM</p>
        <div className="flex items-center justify-between gap-3">
          <h3 id="featured-title">灵感漫游</h3>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5 text-[var(--ink)]">
        <RandomPicksColumn
          dateHeaderTag={dateHeaderTag}
          dateZhTag={dateZhTag}
          songs={randomSongs}
          loading={isRandomLoading}
          refreshing={isRandomRefreshing}
          coolingDown={isRandomCoolingDown}
          error={randomError}
          currentSong={currentSong}
          isPlaying={isPlaying}
          likedSongIdSet={likedSongIdSet}
          onRefresh={handleRefreshRandomSongs}
          onPlay={playSong}
          onOpenPlaylist={openPlaylist}
          onToggleLiked={toggleLikedWithFeedback}
          onInsertNext={insertNextWithFeedback}
          onAddToPlaylist={(song, event) => {
            event?.stopPropagation();
            openAddToPlaylist(song);
          }}
        />
        <RandomRoamColumn
          randomRoam={randomRoam}
          onOpenSettings={() => setIsRoamSettingsOpen(true)}
          onToggle={handleStartRandomRoam}
          currentSong={currentSong}
          isPlaying={isPlaying}
          likedSongIdSet={likedSongIdSet}
          onPlay={playSong}
          onOpenPlaylist={openPlaylist}
          onToggleLiked={toggleLikedWithFeedback}
          onInsertNext={insertNextWithFeedback}
          onAddToPlaylist={(song, event) => {
            event?.stopPropagation();
            openAddToPlaylist(song);
          }}
          songsMap={songsMap}
          likedSongs={likedSongs}
        />
      </div>
    </section>
  );
}
