import React, { useRef, useEffect, useState, useMemo } from 'react';
import { X, User, Play, ListPlus, Music, Loader2, Sparkles, Star, FolderPlus } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore.js';
import { usePlayerStore } from '../store/usePlayerStore.js';
import { hydrateSong } from '../utils.js';
import LazyImage from './LazyImage.jsx';
import DrawerFrame from './drawers/DrawerFrame.jsx';
import { useDrawerTransition } from './drawers/useDrawerTransition.js';
import { insertNextWithFeedback } from '../services/playerActions.js';
import { useFavoriteSongAction } from '../hooks/useFavoriteSongAction.js';
import { planQueueEdit } from '../store/playerQueue.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import {
  getArtistPhotoApiBase,
  ARTIST_PHOTO_CACHE,
  preloadAndDecodeImage,
} from '../hooks/useArtistPhotos.js';
import { useMediaQuery } from './fullscreen/useMediaQuery.js';
import { usePrivateMediaSource } from '../hooks/usePrivateMediaSource.js';
import { handleKeyboardActivation } from '../utils/keyboardActivation.js';
import {
  ARTIST_HEADER_MAX_HEIGHT,
  ARTIST_HEADER_MIN_HEIGHT,
  getArtistDrawerMotion,
} from './drawers/artistDrawerMotion.js';

export default function ArtistDrawer() {
  const isArtistDrawerOpen = useUIStore((s) => s.isArtistDrawerOpen);
  const setIsArtistDrawerOpen = useUIStore((s) => s.setIsArtistDrawerOpen);
  const activeArtistData = useUIStore((s) => s.activeArtistData);
  const isFullScreen = useUIStore((s) => s.isFullScreen);
  const openAddToPlaylist = useUIStore((s) => s.openAddToPlaylist);

  const { isFavorite, pendingSongIds, toggleFavorite } = useFavoriteSongAction();

  const currentSong = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playSong = usePlayerStore((s) => s.playSong);

  const { mounted, visible, onPanelTransitionEnd } = useDrawerTransition(isArtistDrawerOpen);
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  // 滚动缩放与视差驱动 refs
  const scrollContainerRef = useRef(null);
  const headerRef = useRef(null);
  const avatarRef = useRef(null);
  const titleRef = useRef(null);
  const badgeRef = useRef(null);
  const metaRef = useRef(null);
  const photoBgRef = useRef(null);

  const [artistPhoto, setArtistPhoto] = useState(null);
  const [isPhotoLoading, setIsPhotoLoading] = useState(false);

  const artistName = activeArtistData?.name || '';
  const fallbackCover = activeArtistData?.coverUrl || '';

  const resolvedSongs = useMemo(() => {
    if (Array.isArray(activeArtistData?.songs) && activeArtistData.songs.length > 0) {
      return activeArtistData.songs.map((s) => hydrateSong(s));
    }
    return [];
  }, [activeArtistData]);

  // 写真获取与预载
  useEffect(() => {
    if (!isArtistDrawerOpen || !artistName.trim()) {
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
        console.warn('Failed to fetch artist photo for drawer:', err);
      })
      .finally(() => {
        if (!isCancelled) setIsPhotoLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [isArtistDrawerOpen, artistName]);

  const applyHeaderMotion = React.useCallback((scrollTop) => {
    const motion = getArtistDrawerMotion(scrollTop, prefersReducedMotion);
    if (headerRef.current) headerRef.current.style.height = `${motion.headerHeight}px`;
    if (avatarRef.current) avatarRef.current.style.transform = `scale(${motion.avatarScale})`;
    if (badgeRef.current) {
      badgeRef.current.style.opacity = `${motion.badgeOpacity}`;
      badgeRef.current.style.transform = `translateY(${motion.badgeTranslateY}px)`;
      badgeRef.current.style.maxHeight = motion.badgeOpacity === 0 ? '0px' : '20px';
    }
    if (titleRef.current) titleRef.current.style.transform = `scale(${motion.titleScale})`;
    if (metaRef.current) metaRef.current.style.transform = `translateY(${motion.metaTranslateY}px)`;
    if (photoBgRef.current) photoBgRef.current.style.transform = motion.photoTransform;
  }, [prefersReducedMotion]);

  // 重置滚动位置与 Header 展开态；减少动态效果时固定为紧凑态
  useEffect(() => {
    if (isArtistDrawerOpen && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
      applyHeaderMotion(0);
    }
  }, [applyHeaderMotion, isArtistDrawerOpen, artistName]);

  // 焦点管理与 a11y
  useEffect(() => {
    if (isArtistDrawerOpen && mounted) {
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    } else if (!isArtistDrawerOpen && previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [isArtistDrawerOpen, mounted]);

  // Escape 按键监听
  useEffect(() => {
    if (!isArtistDrawerOpen) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') setIsArtistDrawerOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isArtistDrawerOpen, setIsArtistDrawerOpen]);

  // 核心：滚动时流畅压缩 Header 与视差联动（60/120fps 原生无卡顿）
  const handleScroll = (e) => {
    applyHeaderMotion(e.currentTarget.scrollTop);
  };

  const handleClose = () => setIsArtistDrawerOpen(false);

  const handlePlayAll = () => {
    if (resolvedSongs.length > 0) {
      playSong(resolvedSongs[0], resolvedSongs);
      showToast(`正在播放 ${artistName} 全部歌曲 · 共 ${resolvedSongs.length} 首`);
    }
  };

  const handleQueueAll = () => {
    if (resolvedSongs.length > 0) {
      const { playlist, currentSong, setPlaylist, playSong } = usePlayerStore.getState();
      if (!currentSong) {
        playSong(resolvedSongs[0], resolvedSongs);
        showToast(`已开始播放 ${artistName} 全部歌曲 · 共 ${resolvedSongs.length} 首`);
        return;
      }
      const plan = planQueueEdit(playlist, currentSong, resolvedSongs, 'insert_next');
      if (plan.action === 'update' || plan.playlist) {
        setPlaylist(plan.playlist);
      }
      showToast(`已将 ${resolvedSongs.length} 首歌曲加入稍后播放`);
    }
  };

  const displayAvatar = artistPhoto || fallbackCover || (resolvedSongs[0]?.cover_url) || '';
  const resolvedAvatar = usePrivateMediaSource(displayAvatar);

  if (!mounted) return null;

  return (
    <DrawerFrame
      visible={visible}
      isFullScreen={isFullScreen}
      labelledBy="artist-drawer-title"
      onClose={handleClose}
      onPanelTransitionEnd={onPanelTransitionEnd}
      panelClassName="sm:w-[410px]"
    >
      <div className="relative flex-1 flex flex-col h-full overflow-hidden bg-[var(--surface-raised)]">
        {/* 顶部伸缩 Hero 写真 Banner（初始上半部分大图，滚动时平滑压缩至吸顶条） */}
        <div
          ref={headerRef}
          style={{ height: `${prefersReducedMotion ? ARTIST_HEADER_MIN_HEIGHT : ARTIST_HEADER_MAX_HEIGHT}px` }}
          className="absolute top-0 left-0 right-0 z-20 overflow-hidden bg-neutral-900 select-none pointer-events-none will-change-[height]"
        >
          {/* 背景写真图片 */}
          <div ref={photoBgRef} className="absolute inset-0 w-full h-full will-change-transform origin-top">
            {artistPhoto && resolvedAvatar ? (
              <img
                src={resolvedAvatar}
                alt=""
                className="w-full h-full object-cover object-top filter brightness-[0.8] transition-opacity duration-500"
                loading="lazy"
              />
            ) : fallbackCover && resolvedAvatar ? (
              <img
                src={resolvedAvatar}
                alt=""
                className="w-full h-full object-cover object-center filter blur-md brightness-50 opacity-60"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-neutral-800 via-neutral-900 to-black" />
            )}
          </div>

          {/* 渐变遮罩层：保证顶部按钮清晰与底部文字高对比度 */}
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--surface-raised)] via-[var(--surface-raised)]/65 via-35% to-black/35 pointer-events-none" />

          {/* 关闭按钮（独立开启 pointer-events-auto） */}
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="关闭焦点音乐人抽屉"
            onClick={handleClose}
            className="theme-drawer__close pointer-events-auto absolute top-3.5 right-3.5 z-30 w-8 h-8 rounded-full bg-black/45 hover:bg-black/70 text-white/80 hover:text-white flex items-center justify-center transition-all backdrop-blur-sm cursor-pointer shadow-md"
          >
            <X size={16} strokeWidth={2.2} />
          </button>

          {/* 音乐人核心主体信息（定位在 Banner 底部） */}
          <div className="absolute bottom-0 left-0 right-0 z-10 px-5 pb-3.5 flex items-end gap-3.5">
            {/* 圆形高清头像 */}
            <div
              ref={avatarRef}
              className="relative w-[72px] h-[72px] sm:w-20 sm:h-20 rounded-full overflow-hidden bg-neutral-950 border-2 border-white/20 shadow-xl flex items-center justify-center shrink-0 origin-bottom-left will-change-transform"
            >
              {resolvedAvatar ? (
                <img
                  src={resolvedAvatar}
                  alt={artistName}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <User size={30} className="text-white/60" />
              )}
              {isPhotoLoading && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <Loader2 size={16} className="animate-spin text-white" />
                </div>
              )}
            </div>

            {/* 名字与收录指标 */}
            <div className="min-w-0 flex-1 pb-0.5">
              <div ref={badgeRef} className="flex items-center gap-1.5 will-change-transform origin-left overflow-hidden transition-[max-height]">
                <Sparkles size={13} className="text-[var(--accent)]" aria-hidden="true" />
                <span className="text-[10px] font-mono tracking-widest text-[var(--accent)] font-semibold uppercase">
                  ARTIST SPOTLIGHT
                </span>
              </div>
              <h3
                id="artist-drawer-title"
                ref={titleRef}
                className="text-xl sm:text-2xl font-bold text-[var(--ink)] truncate mt-0.5 origin-bottom-left will-change-transform"
                title={artistName}
              >
                {artistName || '焦点音乐人'}
              </h3>
              <p ref={metaRef} className="text-xs text-[var(--muted)] mt-0.5 will-change-transform origin-bottom-left">
                馆藏收录 <strong className="text-[var(--ink)] font-semibold">{resolvedSongs.length}</strong> 首作品
              </p>
            </div>
          </div>
        </div>

        {/* 真正可滚动的列表容器 */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto custom-scrollbar relative z-10"
        >
          {/* 顶部占位 Spacer，高度严格等于 MAX_HEADER_HEIGHT */}
          <div style={{ height: `${prefersReducedMotion ? ARTIST_HEADER_MIN_HEIGHT : ARTIST_HEADER_MAX_HEIGHT}px` }} className="shrink-0 pointer-events-none" />

          {/* 粘性操作工具栏（吸附于 MIN_HEADER_HEIGHT 下方） */}
          <div
            style={{ top: `${ARTIST_HEADER_MIN_HEIGHT}px` }}
            className="sticky z-10 flex items-center justify-between px-5 py-2.5 bg-[var(--surface-raised)]/95 backdrop-blur-md border-b border-[var(--line)] shadow-xs"
          >
            <span className="text-xs font-medium text-[var(--muted)]">
              歌曲列表
            </span>
            <div className="flex items-center gap-2">
              {resolvedSongs.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleQueueAll}
                    className="text-button text-xs flex items-center gap-1 text-[var(--muted)] hover:text-[var(--ink)] px-2 py-1 rounded-lg hover:bg-current/5 transition-colors cursor-pointer"
                    title="将全部歌曲加入稍后播放"
                    aria-label="将全部歌曲加入稍后播放"
                  >
                    <ListPlus size={13} />
                    <span>稍后播放</span>
                  </button>
                  <button
                    type="button"
                    onClick={handlePlayAll}
                    className="text-button text-xs flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-strong)] font-semibold px-2 py-1 rounded-lg hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] transition-colors cursor-pointer"
                    title={`播放 ${artistName} 全部作品`}
                    aria-label="播放全部作品"
                  >
                    <Play size={12} fill="currentColor" />
                    <span>播放全部</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 作品列表区 */}
          <div className="p-3 min-h-[calc(100vh-220px)]">
            {resolvedSongs.length === 0 ? (
              <div className="theme-empty text-center py-20">
                <Music size={40} className="mx-auto mb-3 opacity-30 text-[var(--muted)]" strokeWidth={1.2} />
                <p className="text-sm font-medium text-[var(--ink)]">暂无该歌手作品</p>
                <p className="text-xs text-[var(--muted)] mt-1 max-w-[220px] mx-auto leading-relaxed">
                  曲库中尚未收录更多关联单曲
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {resolvedSongs.map((song, index) => {
                  const isCurrentActive = currentSong?.id === song.id;
                  const rank = index + 1;

                  return (
                    <div
                      key={song.id || index}
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
                      className={`queue-row group relative flex items-center gap-3 rounded-xl p-2.5 border border-transparent hover:border-[var(--line)] transition-all cursor-pointer ${
                        isCurrentActive ? 'is-active' : ''
                      }`}
                    >
                      {/* 序号 */}
                      <span
                        className={`w-6 text-center font-mono text-xs shrink-0 select-none ${
                          isCurrentActive
                            ? 'font-bold text-[var(--accent)] text-sm'
                            : 'font-normal text-[var(--muted)] opacity-50'
                        }`}
                      >
                        {String(rank).padStart(2, '0')}
                      </span>

                      {/* 封面与播放态 */}
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

                      {/* 歌曲信息 */}
                      <div className="min-w-0 flex-1">
                        <p
                          className={`truncate text-sm font-medium ${
                            isCurrentActive ? 'text-[var(--accent)] font-semibold' : 'text-[var(--ink)]'
                          }`}
                        >
                          {song.title}
                        </p>
                        <p className="truncate text-xs text-[var(--muted)] mt-0.5">
                          {song.album || song.artist || artistName}
                        </p>
                      </div>

                      {/* 快捷操作栏：我的收藏 + 加入歌单 + 插播 */}
                      <div className="flex items-center gap-0.5 shrink-0 opacity-80 sm:opacity-0 sm:group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={(e) => toggleFavorite(song, e)}
                          disabled={pendingSongIds.has(String(song.id))}
                          className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                            isFavorite(song)
                              ? 'text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]'
                              : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/10'
                          }`}
                          title={isFavorite(song) ? '移出我的收藏' : '加入我的收藏'}
                          aria-label={`${isFavorite(song) ? '移出' : '加入'}我的收藏：${song.title}`}
                        >
                          <Star size={15} fill={isFavorite(song) ? 'currentColor' : 'none'} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAddToPlaylist(song);
                          }}
                          className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/10 transition-colors cursor-pointer"
                          title="加入歌单"
                          aria-label={`将 ${song.title} 加入歌单`}
                        >
                          <FolderPlus size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            insertNextWithFeedback(song);
                          }}
                          className="p-1.5 rounded-lg text-[var(--muted)] hover:text-[var(--ink)] hover:bg-current/10 transition-colors cursor-pointer"
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
        </div>
      </div>
    </DrawerFrame>
  );
}
