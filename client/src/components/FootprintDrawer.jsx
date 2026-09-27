import React, { useRef, useEffect, useState } from 'react';
import { X, Flame, Play, ListPlus, RefreshCw, Loader2 } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { usePlayStatsStore } from '../store/usePlayStatsStore.js';
import { hydrateSong } from '../utils.js';
import {
  fillSongMetadata,
  songHasValidLanguage,
  repairSongLanguages,
} from '../resolveSongs.js';
import { getApiBaseUrl } from '../services/apiBase.js';
import LazyImage from './LazyImage.jsx';
import DrawerFrame from './drawers/DrawerFrame.jsx';
import { useDrawerTransition } from './drawers/useDrawerTransition.js';
import { insertNextWithFeedback } from '../services/playerActions.js';
import { handleKeyboardActivation } from '../utils/keyboardActivation.js';

export default function FootprintDrawer() {
  const isFootprintDrawerOpen = useUIStore((s) => s.isFootprintDrawerOpen);
  const setIsFootprintDrawerOpen = useUIStore((s) => s.setIsFootprintDrawerOpen);
  const isFullScreen = useUIStore((s) => s.isFullScreen);

  const currentSong = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playSong = usePlayerStore((s) => s.playSong);

  const topSongs = usePlayStatsStore((s) => s.topSongs);
  const playCounts = usePlayStatsStore((s) => s.playCounts);
  const totalPlays = usePlayStatsStore((s) => s.totalPlays);
  const identityReady = usePlayStatsStore((s) => s.identityReady);

  const { mounted, visible, onPanelTransitionEnd } = useDrawerTransition(isFootprintDrawerOpen);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  const resolvedSongs = React.useMemo(() => {
    if (identityReady && Array.isArray(topSongs) && topSongs.length > 0) {
      const playerState = usePlayerStore.getState();
      const healedSongs = [];

      const list = topSongs.map((s) => {
        let hydrated = hydrateSong(s);
        if (!songHasValidLanguage(hydrated)) {
          const filled = fillSongMetadata(hydrated, { playerState });
          if (songHasValidLanguage(filled)) {
            hydrated = filled;
            healedSongs.push(filled);
          }
        }
        return {
          ...hydrated,
          play_count: s.play_count || playCounts[s.id] || 0,
        };
      });

      if (healedSongs.length > 0) {
        queueMicrotask(() => {
          usePlayStatsStore.getState().patchSongMetadata(healedSongs);
        });
      }

      return list;
    }
    return [];
  }, [identityReady, topSongs, playCounts]);

  const visibleTotalPlays = identityReady ? totalPlays : 0;

  useEffect(() => {
    if (!isFootprintDrawerOpen || resolvedSongs.length === 0) return undefined;
    const invalidSongs = resolvedSongs.filter((s) => !songHasValidLanguage(s));
    if (invalidSongs.length === 0) return undefined;

    let cancelled = false;
    repairSongLanguages(invalidSongs, { apiBase: getApiBaseUrl() })
      .then((result) => {
        if (!cancelled && result?.repairedSongIds?.length > 0) {
          const repaired = result.songs.filter(songHasValidLanguage);
          usePlayStatsStore.getState().patchSongMetadata(repaired);
        }
      })
      .catch((error) => {
        console.warn('后台补齐常听足迹语言失败:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [isFootprintDrawerOpen, resolvedSongs]);

  useEffect(() => {
    if (isFootprintDrawerOpen && mounted) {
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    } else if (!isFootprintDrawerOpen && previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [isFootprintDrawerOpen, mounted]);

  useEffect(() => {
    if (!isFootprintDrawerOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') setIsFootprintDrawerOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isFootprintDrawerOpen, setIsFootprintDrawerOpen]);

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleClose = () => setIsFootprintDrawerOpen(false);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    const isAuthenticated = Boolean(useUIStore.getState().authSession?.authenticated);
    if (!isAuthenticated) return;
    setIsRefreshing(true);
    try {
      const result = await usePlayStatsStore.getState().synchronizeAccountStats(50, { force: true });
      if (!result.ok) throw result.error || new Error(`同步失败：${result.stage || result.reason || 'unknown'}`);
      showToast('已更新最新云端记录');
    } catch {
      showToast('同步云端记录失败，请重试');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handlePlayAll = () => {
    if (resolvedSongs.length > 0) {
      playSong(resolvedSongs[0], resolvedSongs);
      showToast(`正在播放常听榜单 · 共 ${resolvedSongs.length} 首`);
    }
  };

  if (!mounted) return null;

  return (
    <DrawerFrame
      visible={visible}
      isFullScreen={isFullScreen}
      labelledBy="footprint-drawer-title"
      onClose={handleClose}
      onPanelTransitionEnd={onPanelTransitionEnd}
      panelClassName="sm:w-[380px]"
    >
      {/* 抽屉头部：统一标准抽屉规范 */}
      <div className="theme-drawer__header flex items-center justify-between px-5 py-4 border-b border-current/10">
        <div className="flex items-center gap-2">
          <Flame size={18} className="text-[var(--accent)]" aria-hidden="true" />
          <h3 id="footprint-drawer-title" className="text-base font-semibold text-[var(--ink)]">
            常听足迹
          </h3>
          <span className="text-[10px] font-mono text-[var(--muted)] opacity-70">TOP 榜单</span>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="关闭常听足迹抽屉"
          onClick={handleClose}
          className="theme-drawer__close flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      {/* 次级统计与操作栏 */}
      <div className="flex items-center justify-between px-5 py-2.5 text-xs text-[var(--muted)] border-b border-current/5">
        <span className="truncate pr-2">
          累计播放 <strong className="font-mono text-[var(--ink)] font-semibold">{visibleTotalPlays}</strong> 次 · 共 {resolvedSongs.length} 首
        </span>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="text-button text-xs flex items-center gap-1 text-[var(--muted)] hover:text-[var(--ink)] transition-colors cursor-pointer disabled:opacity-50"
            title="手动刷新最新云端记录"
            aria-label="刷新云端记录"
          >
            {isRefreshing ? (
              <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
            ) : (
              <RefreshCw size={12} />
            )}
            <span>{isRefreshing ? '刷新中…' : '刷新'}</span>
          </button>
          {resolvedSongs.length > 0 && (
            <button
              type="button"
              onClick={handlePlayAll}
              className="text-button text-xs flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-strong)] font-semibold transition-colors cursor-pointer"
              title="播放全部常听榜单"
            >
              <Play size={12} fill="currentColor" />
              <span>播放全部</span>
            </button>
          )}
        </div>
      </div>

      {/* 榜单曲目列表 */}
      <div className={`flex-1 overflow-y-auto custom-scrollbar p-3 transition-opacity duration-300 ${
        isRefreshing ? 'opacity-40 pointer-events-none' : 'opacity-100'
      }`}>
        {resolvedSongs.length === 0 ? (
          <div className="theme-empty text-center py-20">
            <Flame size={44} className="mx-auto mb-3 opacity-30 text-[var(--muted)]" strokeWidth={1} />
            <p className="text-sm font-medium text-[var(--ink)]">暂无常听记录</p>
            <p className="text-xs text-[var(--muted)] mt-1 max-w-[240px] mx-auto leading-relaxed">
              单曲播放满 30 秒后将自动沉淀到常听轨迹中
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {resolvedSongs.map((song, index) => {
              const isCurrentActive = currentSong?.id === song.id;
              const rank = index + 1;

              return (
                <div
                  key={song.id}
                  onClick={() => {
                    playSong(song, resolvedSongs);
                    showToast(`正在播放《${song.title}》`);
                  }}
                  onKeyDown={(event) => handleKeyboardActivation(event, () => {
                    playSong(song, resolvedSongs);
                    showToast(`正在播放《${song.title}》`);
                  })}
                  role="button"
                  tabIndex={0}
                  aria-label={`播放 ${song.title}`}
                  className={`queue-row group relative flex items-center gap-3 rounded-xl p-2 transition-all cursor-pointer ${
                    isCurrentActive ? 'is-active' : ''
                  }`}
                >
                  {/* 纯字体榜单排位 */}
                  <span
                    className={`w-6 text-center font-mono text-xs shrink-0 select-none ${
                      rank === 1
                        ? 'font-bold text-[var(--accent)] text-sm'
                        : rank === 2
                        ? 'font-bold text-[var(--ink)]'
                        : rank === 3
                        ? 'font-semibold text-[var(--ink)] opacity-80'
                        : 'font-normal text-[var(--muted)] opacity-50'
                    }`}
                  >
                    {String(rank).padStart(2, '0')}
                  </span>

                  {/* 封面与播放动效 */}
                  <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-current/10 queue-row__cover">
                    <LazyImage
                      src={song.cover_url || '/placeholder-album.svg'}
                      alt={song.title}
                      className="h-full w-full object-cover"
                    />
                    {isCurrentActive && isPlaying ? (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <div className="flex items-end gap-0.5 h-3">
                          <span className="w-0.5 bg-white rounded-full animate-bounce h-2" style={{ animationDuration: '0.6s' }} />
                          <span className="w-0.5 bg-white rounded-full animate-bounce h-3" style={{ animationDuration: '0.8s', animationDelay: '0.2s' }} />
                          <span className="w-0.5 bg-white rounded-full animate-bounce h-1.5" style={{ animationDuration: '0.7s', animationDelay: '0.4s' }} />
                        </div>
                      </div>
                    ) : (
                      <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <Play size={15} fill="white" className="text-white ml-0.5" />
                      </div>
                    )}
                  </div>

                  {/* 歌曲主信息 */}
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm font-medium ${
                        isCurrentActive ? 'text-[var(--accent)] font-semibold' : 'text-[var(--ink)]'
                      }`}
                    >
                      {song.title}
                    </p>
                    <p className="truncate text-xs text-[var(--muted)] mt-0.5">
                      {song.artist}
                    </p>
                  </div>

                  {/* 播放次数指标 */}
                  <div className="shrink-0 text-right">
                    <span
                      className={`font-mono text-xs tabular-nums transition-colors ${
                        isCurrentActive
                          ? 'text-[var(--accent)] font-semibold'
                          : 'text-[var(--muted)] font-medium group-hover:text-[var(--ink)]'
                      }`}
                    >
                      {song.play_count} 次
                    </span>
                  </div>

                  {/* 快捷插播按钮 */}
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        insertNextWithFeedback(song);
                      }}
                      className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/10 transition-colors"
                      title="插播为下一首"
                      aria-label={`将 ${song.title} 插播为下一首`}
                    >
                      <ListPlus size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DrawerFrame>
  );
}
