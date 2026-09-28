import React, { useEffect, useRef, useState } from 'react';
import { Search, Play, ListPlus, Loader2, X, FolderPlus, MoreHorizontal, History, Disc, User, Music, Trash2, ChevronRight, Sparkles } from 'lucide-react';
import { useUIStore, showToast } from '../store/useUIStore';
import { usePlayerStore } from '../store/usePlayerStore';
import { useShallow } from 'zustand/react/shallow';
import LazyImage from './LazyImage';
import { hydratePlayableSong } from '../utils.js';
import {
  loadRecentSearchEntities,
  saveRecentSearchEntity,
  removeRecentSearchEntity,
  clearRecentSearchEntities,
} from '../utils/searchHistory.js';
import { resolveSongLanguage } from '../utils/songType.js';
import { getLanguageShortLabel } from '../constants/language.js';
import { getApiBaseUrl } from '../services/apiBase.js';
import { authenticatedFetch } from '../services/authenticatedFetch.js';
import { useCatalogPage } from '../hooks/useCatalogPage.js';
import { formatPath, returnToParentRoute, syncBrowserHistory } from '../utils/navigation.js';
import PageBackButton from './PageBackButton.jsx';
import ArtistCard from './catalog/ArtistCard.jsx';
import ArtistPreviewRow from './catalog/ArtistPreviewRow.jsx';
import SectionHeading from './catalog/SectionHeading.jsx';
import SongColumnShelf from './catalog/SongColumnShelf.jsx';
import AlbumPreviewGrid from './catalog/AlbumPreviewGrid.jsx';
import { hasPreviewOverflow } from './catalog/previewVisibility.js';
import { useFavoriteSongAction } from '../hooks/useFavoriteSongAction.js';
import { insertNextWithFeedback } from '../services/playerActions.js';
import {
  getArtistPhotoApiBase,
  ARTIST_PHOTO_CACHE,
  preloadAndDecodeImage,
} from '../hooks/useArtistPhotos.js';

import { HighlightText } from './search/HighlightText.jsx';
import { SearchTrackRow } from './search/SearchTrackRow.jsx';
import {
  MAX_SEARCH_BULK_SELECTION,
  resolveSelectedSearchSongs,
  toggleSearchBulkSelection,
} from './search/searchBulkSelection.js';

export { HighlightText };

const SEARCH_DEBOUNCE_MS = 700;
const PAGE_SIZE = 20;

const getSearchApiBase = () => getApiBaseUrl();

function RecentSearchCard({ item, onPlaySong, onOpenArtist, onRemove }) {
  const [photoUrl, setPhotoUrl] = useState(null);

  useEffect(() => {
    if (item.type !== 'artist' || !item.name) return;
    const trimmed = item.name.trim();
    if (ARTIST_PHOTO_CACHE.has(trimmed)) {
      const cached = ARTIST_PHOTO_CACHE.get(trimmed);
      if (Array.isArray(cached) && cached.length > 0 && cached[0]?.url) {
        setPhotoUrl(cached[0].url);
        return;
      }
    }
    let cancelled = false;
    const apiBase = getArtistPhotoApiBase();
    authenticatedFetch(`${apiBase}/api/artist-photo?name=${encodeURIComponent(trimmed)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const photos = data?.data?.photos || [];
        ARTIST_PHOTO_CACHE.set(trimmed, photos);
        if (photos.length > 0 && photos[0]?.url) {
          setPhotoUrl(photos[0].url);
          preloadAndDecodeImage(photos[0].url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [item.type, item.name]);

  const displayAvatar = photoUrl || item.coverUrl;

  const handleClick = () => {
    if (item.type === 'artist') {
      onOpenArtist?.({
        name: item.name,
        coverUrl: displayAvatar,
      });
    } else if (item.type === 'song') {
      onPlaySong?.(item.song || item);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className="search-recent-card search-tag-chip group relative flex items-center gap-3 p-2.5 rounded-xl bg-[var(--surface)] transition-all cursor-pointer select-none text-left min-w-0"
      title={item.type === 'artist' ? `进入 ${item.name} 歌手专区` : `播放 ${item.title}`}
    >
      <div className="relative shrink-0 flex items-center justify-center">
        {item.type === 'artist' ? (
          <div className="w-12 h-12 rounded-full overflow-hidden bg-neutral-800 shadow-xs flex items-center justify-center transition-transform group-hover:scale-105">
            {displayAvatar ? (
              <LazyImage src={displayAvatar} alt="" className="w-full h-full object-cover" />
            ) : (
              <User size={20} className="text-[var(--muted)]" />
            )}
          </div>
        ) : (
          <div className="w-12 h-12 rounded-lg overflow-hidden bg-neutral-800 shadow-xs flex items-center justify-center transition-transform group-hover:scale-105">
            {item.coverUrl ? (
              <LazyImage src={item.coverUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <Disc size={20} className="text-[var(--muted)]" />
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 pr-6">
        <h4 className="text-sm font-semibold text-[var(--ink)] truncate group-hover:text-[var(--accent)] transition-colors">
          {item.type === 'artist' ? item.name : item.title}
        </h4>
        <p className="text-xs text-[var(--muted)] truncate mt-0.5">
          {item.type === 'artist' ? '歌手' : `歌曲 · ${item.artist || '未知歌手'}`}
        </p>
      </div>

      <button
        type="button"
        onClick={(e) => onRemove(item, e)}
        className="search-recent-card__delete search-tag-chip__delete absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-[var(--muted)] hover:text-[var(--danger)] hover:bg-[var(--line)] transition-all opacity-70 group-hover:opacity-100"
        aria-label={`删除历史记录 ${item.type === 'artist' ? item.name : item.title}`}
        title="移除此记录"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default function SearchView({ route, onBack, songsMap }) {
  const [artistVisibleCount, setArtistVisibleCount] = useState(0);
  const [albumVisibleCount, setAlbumVisibleCount] = useState(0);
  const [songScrollOverflow, setSongScrollOverflow] = useState(false);
  const isAuthenticated = useUIStore((s) => Boolean(s.authSession.authenticated));
  const openAddToPlaylist = useUIStore((s) => s.openAddToPlaylist);
  const { playSong, currentSong, isPlaying } = usePlayerStore(useShallow((s) => ({
    playSong: s.playSong,
    currentSong: s.currentSong,
    isPlaying: s.isPlaying,
  })));
  const {
    favoriteSongIds: likedIds,
    pendingSongIds: pendingLikedIds,
    justAddedSongIds: animatingLikedIds,
    toggleFavorite: toggleLiked,
    clearAddedAnimation,
  } = useFavoriteSongAction();

  const [query, setQuery] = useState(route?.query || '');
  const [catalogQuery, setCatalogQuery] = useState(route?.query || '');
  const [songs, setSongs] = useState([]);
  useEffect(() => {
    const handleSongUpdated = (event) => {
      const updated = event.detail;
      if (!updated?.id) return;
      setSongs((current) => current.map((song) => song.id === updated.id ? { ...song, ...updated } : song));
      for (const [key, page] of searchCacheRef.current) {
        searchCacheRef.current.set(key, {
          ...page,
          songs: page.songs.map((song) => song.id === updated.id ? { ...song, ...updated } : song),
        });
      }
    };
    window.addEventListener('flaretune:catalog-song-updated', handleSongUpdated);
    return () => window.removeEventListener('flaretune:catalog-song-updated', handleSongUpdated);
  }, []);
  const [status, setStatus] = useState('idle');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [openMenuSongId, setOpenMenuSongId] = useState(null);
  const [isBulkSelecting, setIsBulkSelecting] = useState(false);
  const [selectedSongIds, setSelectedSongIds] = useState([]);
  const [subView, setSubView] = useState(route?.view || 'overview');

  // 语种筛选：'all' | 'zh' | 'en' | 'ja' | 'ko' | 'instrumental' | 'other'
  const [songSubCategory, setSongSubCategory] = useState(route?.language || 'all');
  const [isFiltering, setIsFiltering] = useState(false);

  const [recentEntities, setRecentEntities] = useState(() => loadRecentSearchEntities());
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef(null);
  const searchGenerationRef = useRef(0);
  const loadMoreControllerRef = useRef(null);
  const searchCacheRef = useRef(new Map());
  const prevQueryRef = useRef('');
  const prevSubCategoryRef = useRef('all');

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  const recordRecentEntity = (entity) => {
    setRecentEntities(saveRecentSearchEntity(entity));
  };

  const handleRemoveRecentEntity = (entity, e) => {
    e?.stopPropagation();
    setRecentEntities(removeRecentSearchEntity(entity));
  };

  const handleClearRecentEntities = () => {
    setRecentEntities(clearRecentSearchEntities());
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setQuery(route?.query || '');
    setSubView(route?.view || 'overview');
    setSongSubCategory(route?.language || 'all');
  }, [route?.query, route?.view, route?.language]);

  useEffect(() => {
    const timer = setTimeout(() => {
      syncBrowserHistory(formatPath({ type: 'page', page: 'search', query, view: subView, language: songSubCategory }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, songSubCategory, subView]);

  useEffect(() => {
    const timer = setTimeout(() => setCatalogQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const navigateResults = (view) => {
    const url = formatPath({ type: 'page', page: 'search', query, view, language: songSubCategory });
    if (view === 'overview') {
      returnToParentRoute(url);
      return;
    }
    setSubView(view);
    syncBrowserHistory(url);
  };

  const hasCatalogQuery = Boolean(catalogQuery.trim());
  const artistResults = useCatalogPage('artists', { query: catalogQuery, language: songSubCategory, limit: 7,
    enabled: hasCatalogQuery && subView === 'overview' });
  const albumResults = useCatalogPage('albums', { query: catalogQuery, language: songSubCategory, limit: 10,
    enabled: hasCatalogQuery && subView === 'overview' });
  const fullArtistResults = useCatalogPage('artists', { query: catalogQuery, language: songSubCategory, limit: 20, enabled: hasCatalogQuery && subView === 'artists' });
  const fullAlbumResults = useCatalogPage('albums', { query: catalogQuery, language: songSubCategory, limit: 20, enabled: hasCatalogQuery && subView === 'albums' });

  useEffect(() => {
    const generation = searchGenerationRef.current + 1;
    searchGenerationRef.current = generation;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setLoadingMore(false);
    if (!isAuthenticated) {
      setStatus('unauthorized');
      setSongs([]);
      setHasMore(false);
      setIsFiltering(false);
      searchCacheRef.current.clear();
      prevQueryRef.current = '';
      return undefined;
    }
    const q = query.trim();
    if (!q) {
      setSongs([]);
      setStatus('idle');
      setHasMore(false);
      setIsFiltering(false);
      searchCacheRef.current.clear();
      prevQueryRef.current = '';
      return undefined;
    }

    // Full artist/album views have their own paged query. Song rows are only
    // needed by the overview and the full song view.
    if (subView === 'artists' || subView === 'albums') {
      setSongs([]);
      setStatus('ready');
      setHasMore(false);
      setIsFiltering(false);
      return undefined;
    }

    const queryChanged = prevQueryRef.current !== q;
    prevSubCategoryRef.current = songSubCategory;

    if (queryChanged) {
      prevQueryRef.current = q;
      searchCacheRef.current.clear();
    }

    const cacheKey = `${q}::${songSubCategory}`;
    if (searchCacheRef.current.has(cacheKey)) {
      const cached = searchCacheRef.current.get(cacheKey);
      setSongs(cached.songs);
      setHasMore(cached.hasMore);
      setStatus('ready');
      setIsFiltering(false);
      return undefined;
    }

    const isInitialSearch = queryChanged || status !== 'ready' || songs.length === 0;
    if (isInitialSearch) {
      setStatus('loading');
      setSongs([]);
      setHasMore(false);
      setIsFiltering(false);
    } else {
      setIsFiltering(true);
    }

    const controller = new AbortController();
    const debounceMs = queryChanged ? SEARCH_DEBOUNCE_MS : 0;

    const timer = setTimeout(async () => {
      try {
        const languageParam = songSubCategory === 'all'
          ? ''
          : `&language=${encodeURIComponent(songSubCategory)}`;
        const res = await authenticatedFetch(`${getSearchApiBase()}/api/songs/search?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=0${languageParam}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (res.status === 401) {
          if (generation !== searchGenerationRef.current) return;
          setStatus('unauthorized');
          setIsFiltering(false);
          return;
        }
        if (!res.ok) {
          if (generation !== searchGenerationRef.current) return;
          setStatus('error');
          setIsFiltering(false);
          return;
        }
        const data = await res.json();
        if (generation !== searchGenerationRef.current) return;
        const batch = (data?.data?.songs || []).map(hydratePlayableSong).filter(Boolean);
        const hasMoreBatch = batch.length === PAGE_SIZE;

        searchCacheRef.current.set(cacheKey, { songs: batch, hasMore: hasMoreBatch });

        setSongs(batch);
        setHasMore(hasMoreBatch);
        setStatus('ready');
        setIsFiltering(false);
      } catch (error) {
        if (error?.name !== 'AbortError' && generation === searchGenerationRef.current) {
          setStatus('error');
          setIsFiltering(false);
        }
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isAuthenticated, songSubCategory, subView]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [query, songSubCategory]);

  useEffect(() => {
    setIsBulkSelecting(false);
    setSelectedSongIds([]);
  }, [isAuthenticated, query, songSubCategory]);

  const goHome = () => {
    onBack?.();
  };

  const matchedArtists = artistResults.items;

  const subFilterOptions = [
    { key: 'all', label: '全部' },
    { key: 'zh', label: '中文' },
    { key: 'en', label: '英语' },
    { key: 'ja', label: '日语' },
    { key: 'ko', label: '韩语' },
    { key: 'instrumental', label: '纯音乐' },
    { key: 'other', label: '其他' },
  ];

  const filteredSongs = songs;

  const loadMore = async () => {
    if (loadingMore || status !== 'ready' || !hasMore || isFiltering) return;
    const q = query.trim();
    if (!q) return;
    const generation = searchGenerationRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    try {
      const languageParam = songSubCategory === 'all' ? '' : `&language=${encodeURIComponent(songSubCategory)}`;
      const res = await authenticatedFetch(`${getSearchApiBase()}/api/songs/search?q=${encodeURIComponent(q)}&limit=${PAGE_SIZE}&offset=${songs.length}${languageParam}`, {
        credentials: 'include',
        signal: controller.signal,
      });
      if (generation !== searchGenerationRef.current) return;
      if (!res.ok) {
        showToast('加载更多失败，请稍后重试');
        return;
      }
      const data = await res.json();
      if (generation !== searchGenerationRef.current) return;
      const batch = (data?.data?.songs || []).map(hydratePlayableSong).filter(Boolean);
      setSongs((prev) => {
        const next = [...prev, ...batch];
        const cacheKey = `${q}::${songSubCategory}`;
        searchCacheRef.current.set(cacheKey, { songs: next, hasMore: batch.length === PAGE_SIZE });
        return next;
      });
      setHasMore(batch.length === PAGE_SIZE);
    } catch (error) {
      if (error?.name !== 'AbortError' && generation === searchGenerationRef.current) {
        showToast('加载更多失败，请稍后重试');
      }
    } finally {
      if (loadMoreControllerRef.current === controller) loadMoreControllerRef.current = null;
      if (generation === searchGenerationRef.current) setLoadingMore(false);
    }
  };

  const handleInputKeyDown = (e) => {
    if (status !== 'ready' || filteredSongs.length === 0) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (query) setQuery('');
        else goHome();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < filteredSongs.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : filteredSongs.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = (activeIndex >= 0 && activeIndex < filteredSongs.length) ? filteredSongs[activeIndex] : filteredSongs[0];
      if (target) {
        if (e.shiftKey) {
          insertNextWithFeedback(target);
        } else {
          recordRecentEntity({
            type: 'song',
            id: target.id,
            title: target.title,
            artist: target.artist,
            coverUrl: target.cover_url,
            song: target,
          });
          playSong(target, filteredSongs);
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (subView !== 'overview') {
        setSubView('overview');
      } else if (query) {
        setQuery('');
      } else {
        goHome();
      }
    }
  };

  const handlePlayAll = () => {
    if (!filteredSongs.length) return;
    recordRecentEntity({
      type: 'song',
      id: filteredSongs[0].id,
      title: filteredSongs[0].title,
      artist: filteredSongs[0].artist,
      coverUrl: filteredSongs[0].cover_url,
      song: filteredSongs[0],
    });
    playSong(filteredSongs[0], filteredSongs);
    showToast(`已开始播放全部 ${filteredSongs.length} 首歌曲`);
  };

  const handleInsertAllNext = () => {
    if (!filteredSongs.length) return;
    const currentList = usePlayerStore.getState().playlist || [];
    const current = usePlayerStore.getState().currentSong;
    if (!current) {
      recordRecentEntity({
        type: 'song',
        id: filteredSongs[0].id,
        title: filteredSongs[0].title,
        artist: filteredSongs[0].artist,
        coverUrl: filteredSongs[0].cover_url,
        song: filteredSongs[0],
      });
      playSong(filteredSongs[0], filteredSongs);
      showToast(`已开始播放全部 ${filteredSongs.length} 首歌曲`);
      return;
    }
    const currentIdx = currentList.findIndex((s) => s.id === current.id);
    const nextList = [...currentList];
    const insertIdx = currentIdx !== -1 ? currentIdx + 1 : nextList.length;
    nextList.splice(insertIdx, 0, ...filteredSongs);
    usePlayerStore.getState().setPlaylist(nextList);
    showToast(`已将 ${filteredSongs.length} 首歌曲加入下一首播放`);
  };

  const toggleBulkSong = (song, event) => {
    event?.stopPropagation();
    setSelectedSongIds((current) => {
      const result = toggleSearchBulkSelection(current, song.id);
      if (result.limitReached) showToast(`一次最多选择 ${MAX_SEARCH_BULK_SELECTION} 首歌曲`);
      return result.selectedIds;
    });
  };

  const closeBulkSelection = () => {
    setIsBulkSelecting(false);
    setSelectedSongIds([]);
  };

  const addBulkSelectionToPlaylist = () => {
    const selectedSongs = resolveSelectedSearchSongs(filteredSongs, selectedSongIds);
    if (selectedSongs.length === 0) return;
    openAddToPlaylist(selectedSongs);
    closeBulkSelection();
  };

  return (
    <div className="app-page search-page">
      <div className="w-full pt-2 sm:pt-4">
        <div className="search-bar-wrap search-page__bar mx-auto flex w-full max-w-[560px] items-center gap-3 rounded-full px-5 py-3.5 mb-10">
          <Search size={18} className="shrink-0 text-[var(--muted)] transition-colors" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSubView('overview'); }}
            onKeyDown={handleInputKeyDown}
            placeholder="搜索歌曲、歌手或专辑…"
            aria-label="搜索曲库"
            className="w-full min-w-0 bg-transparent text-sm font-medium text-[var(--ink)] placeholder:text-[var(--muted)] outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              className="shrink-0 rounded-full p-1 text-[var(--muted)] transition-colors hover:bg-[var(--line)] hover:text-[var(--ink)] cursor-pointer"
            >
              <X size={15} />
            </button>
          ) : (
            <kbd className="search-kbd hidden sm:inline-flex text-[11px] px-1.5 py-0.5 rounded-md" title="快捷键唤起搜索">
              {isMac ? '⌘K' : 'Ctrl K'}
            </kbd>
          )}
          {(status === 'loading' || isFiltering) && <Loader2 size={16} className="shrink-0 animate-spin text-[var(--accent)]" aria-hidden="true" />}
        </div>

        {status === 'error' && (
          <div className="theme-empty mx-auto max-w-2xl rounded-2xl p-6 text-center text-sm">搜索失败，请稍后重试。</div>
        )}

        {status === 'loading' && (
          <div className="w-full flex flex-col gap-2.5 animate-pulse" aria-label="正在加载搜索结果">
            {[1, 2, 3, 4, 5].map((idx) => (
              <div key={idx} className="flex items-center gap-4 rounded-xl p-3 bg-[var(--surface)]/70 border border-[var(--line)]">
                <div className="h-12 w-12 rounded-lg bg-[var(--line)]/50 shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="h-4 w-3/5 rounded bg-[var(--line)]/60" />
                  <div className="h-3 w-2/5 rounded bg-[var(--line)]/40" />
                </div>
                <div className="flex items-center gap-2 pr-2">
                  <div className="h-7 w-7 rounded-full bg-[var(--line)]/30" />
                  <div className="h-7 w-7 rounded-full bg-[var(--line)]/30" />
                </div>
              </div>
            ))}
          </div>
        )}

        {status === 'idle' && (
          <div className="w-full">
            {recentEntities.length > 0 ? (
              <div className="mb-8">
                <div className="mb-3.5 flex items-center justify-between">
                  <span className="text-base font-bold text-[var(--ink)] tracking-tight select-none">
                    最近搜索
                  </span>
                  <button
                    type="button"
                    onClick={handleClearRecentEntities}
                    className="text-base font-medium text-[var(--muted)] transition-colors hover:text-[var(--danger)] cursor-pointer"
                    aria-label="清空最近搜索历史"
                  >
                    清空
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {recentEntities.map((item) => (
                    <RecentSearchCard
                      key={item.type === 'song' ? `song-${item.id}` : `artist-${item.name}`}
                      item={item}
                      onPlaySong={(s) => {
                        playSong(s, [s]);
                        showToast(`已开始播放 ${s.title}`);
                      }}
                      onOpenArtist={(a) => {
                        useUIStore.getState().openArtistDrawer({
                          name: a.name,
                          coverUrl: a.coverUrl,
                        });
                      }}
                      onRemove={handleRemoveRecentEntity}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="py-16 text-center select-none">
                <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-[var(--surface-raised)] border border-[var(--line)] flex items-center justify-center text-[var(--muted)] shadow-xs">
                  <Search size={20} />
                </div>
                <h3 className="text-sm font-bold text-[var(--ink)] mb-1">探索曲库</h3>
                <p className="text-xs text-[var(--muted)] max-w-xs mx-auto leading-relaxed">
                  在上方输入歌名、歌手或专辑，即刻检索并畅享旋律。
                </p>
              </div>
            )}
          </div>
        )}

        {subView === 'overview' && status === 'ready' && songs.length === 0 && matchedArtists.length === 0 && albumResults.items.length === 0 && artistResults.status !== 'loading' && albumResults.status !== 'loading' && songSubCategory === 'all' && (
          <div className="theme-empty mx-auto max-w-2xl rounded-2xl p-8 text-center text-sm">
            没有找到与“{query.trim()}”匹配的内容。
          </div>
        )}

        {status === 'ready' && (subView !== 'overview' || songs.length > 0 || matchedArtists.length > 0 || albumResults.items.length > 0 || songSubCategory !== 'all') && (
          <div className="w-full">
            {subView === 'overview' && filteredSongs.length === 0 && matchedArtists.length === 0 && albumResults.items.length === 0 && (
              <div className="theme-empty mx-auto my-6 rounded-2xl p-8 text-center text-sm">
                <p className="mb-3 text-[var(--muted)]">当前筛选下没有与“{query.trim()}”匹配的内容。</p>
                {songSubCategory !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setSongSubCategory('all')}
                    className="secondary-button inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold"
                  >
                    重置筛选
                  </button>
                )}
              </div>
            )}

            {/* 概览模式 (Search Overview) */}
            <div hidden={subView !== 'overview'} style={subView === 'overview' ? undefined : { display: 'none' }}>
                {/* 歌手 */}
                {matchedArtists.length > 0 && (
                  <div className="mb-8">
                    <div className="mb-3 px-1 flex items-center justify-between">
                      <SectionHeading title="歌手" onViewAll={hasPreviewOverflow({
                        renderedCount: Math.min(matchedArtists.length, 6), visibleCount: artistVisibleCount,
                        totalCount: artistResults.total ?? matchedArtists.length, hasMore: artistResults.hasMore,
                      }) ? () => navigateResults('artists') : null} />
                    </div>
                    <ArtistPreviewRow artists={matchedArtists.slice(0, 6)} onVisibleCountChange={setArtistVisibleCount}
                      onOpen={(artist) => {
                        recordRecentEntity({ type: 'artist', name: artist.name, coverUrl: artist.photoUrl || artist.coverUrl });
                        useUIStore.getState().openArtistDrawer({ name: artist.name, coverUrl: artist.photoUrl || artist.coverUrl });
                      }} />
                  </div>
                )}

                {/* 3. 单曲紧凑预览 (Songs Preview) */}
                {songs.length > 0 && (
                  <div className="mb-8">
                    <div className="mb-3.5 flex items-center justify-between px-1">
                      <SectionHeading title="单曲" onViewAll={hasPreviewOverflow({
                        renderedCount: Math.min(filteredSongs.length, 20),
                        visibleCount: Math.min(filteredSongs.length, 20), totalCount: songs.length,
                        hasMore, scrollOverflow: songScrollOverflow,
                      }) ? () => navigateResults('songs') : null} />
                      <button
                        type="button"
                        onClick={handlePlayAll}
                        disabled={filteredSongs.length === 0}
                        className="search-action-btn"
                        title="播放当前列表全部歌曲"
                      >
                        <Play size={12} fill="currentColor" /> 播放全部
                      </button>
                    </div>

                    <SongColumnShelf key={`${query}:${songSubCategory}`} label="单曲"
                      onOverflowChange={setSongScrollOverflow}>
                      {filteredSongs.slice(0, 20).map((song, idx) => {
                        const liked = likedIds.has(String(song.id));
                        const isMenuOpen = openMenuSongId === song.id;
                        const isActiveNav = activeIndex === idx;
                        return (
                          <SearchTrackRow
                            key={song.id}
                            song={song}
                            songs={filteredSongs}
                            query={query}
                            currentSong={currentSong}
                            isPlaying={isPlaying}
                            isActiveNav={isActiveNav} /* is-active-nav */
                            liked={liked}
                            isPendingLiked={pendingLikedIds.has(String(song.id))}
                            isPopAnimating={animatingLikedIds.has(String(song.id))}
                            isMenuOpen={isMenuOpen}
                            isBulkSelecting={false}
                            isBulkSelected={false}
                            onPlay={(targetSong, songList) => {
                              recordRecentEntity({
                                type: 'song',
                                id: targetSong.id,
                                title: targetSong.title,
                                artist: targetSong.artist,
                                coverUrl: targetSong.cover_url,
                                song: targetSong,
                              });
                              playSong(targetSong, songList);
                            }}
                            onToggleLiked={toggleLiked}
                            onAnimationEnd={clearAddedAnimation}
                            onAddToPlaylist={(selectedSong, event) => {
                              event?.stopPropagation();
                              openAddToPlaylist(selectedSong);
                            }}
                            onToggleBulkSelection={() => {}}
                            onInsertNext={insertNextWithFeedback}
                            onToggleMenu={(songId) => setOpenMenuSongId((prev) => (prev === songId ? null : songId))}
                            onCloseMenu={() => setOpenMenuSongId(null)}
                            onFilterArtist={(artist) => {
                              const artistSongs = songs.filter(s => (s.artist || '').toLowerCase() === (artist || '').toLowerCase());
                              recordRecentEntity({
                                type: 'artist',
                                name: artist,
                                coverUrl: song.cover_url,
                              });
                              useUIStore.getState().openArtistDrawer({
                                name: artist,
                                songs: artistSongs.length > 0 ? artistSongs : [song],
                                coverUrl: song.cover_url,
                              });
                            }}
                          />
                        );
                      })}
                    </SongColumnShelf>
                  </div>
                )}

                {albumResults.items.length > 0 && (
                  <div className="mb-8">
                    <div className="mb-3 px-1"><SectionHeading title="专辑" onViewAll={hasPreviewOverflow({
                      renderedCount: Math.min(albumResults.items.length, 10), visibleCount: albumVisibleCount,
                      totalCount: albumResults.total ?? albumResults.items.length, hasMore: albumResults.hasMore,
                    }) ? () => navigateResults('albums') : null} /></div>
                    <AlbumPreviewGrid albums={albumResults.items.slice(0, 10)}
                      onVisibleCountChange={setAlbumVisibleCount}
                      onOpen={(album) => syncBrowserHistory(formatPath({ type: 'album', id: album.id }))} />
                  </div>
                )}
            </div>

            {/* 专注单曲下钻模式 (Dedicated Songs View) */}
            {subView === 'songs' && (
              <div>
                {/* 顶部返回导航与标题区 */}
                <div className="mb-5">
                  <PageBackButton onClick={() => navigateResults('overview')} className="mb-3" />

                  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 px-1">
                    <div>
                      <h2 className="text-2xl sm:text-3xl font-extrabold text-[var(--ink)] tracking-tight">单曲</h2>
                      <p className="text-xs text-[var(--muted)] mt-1 font-medium">
                        {isBulkSelecting ? `已选择 ${selectedSongIds.length} 首` : null}
                      </p>
                    </div>

                    {/* 单曲操作栏 */}
                    <div className="flex flex-wrap items-center gap-2">
                      {isBulkSelecting ? (
                        <>
                          <button type="button" onClick={closeBulkSelection} className="search-action-btn">
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={addBulkSelectionToPlaylist}
                            disabled={selectedSongIds.length === 0}
                            className="search-action-btn"
                          >
                            <FolderPlus size={13} /> 加入歌单
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={handlePlayAll}
                            disabled={filteredSongs.length === 0}
                            className="search-action-btn"
                            title="播放当前列表全部歌曲"
                          >
                            <Play size={12} fill="currentColor" /> 播放全部
                          </button>
                          <button
                            type="button"
                            onClick={handleInsertAllNext}
                            disabled={filteredSongs.length === 0}
                            className="search-action-btn"
                            title="将当前列表全部歌曲插入下一首"
                          >
                            <ListPlus size={13} /> 全部加为下一首
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsBulkSelecting(true)}
                            disabled={filteredSongs.length === 0}
                            className="search-action-btn"
                            title="选择多首歌曲加入歌单"
                          >
                            <FolderPlus size={13} /> 批量加入歌单
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* 单曲全量列表 */}
                <div className={`full-song-grid transition-opacity duration-200 ${isFiltering ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
                  {filteredSongs.map((song, idx) => {
                    const liked = likedIds.has(String(song.id));
                    const isMenuOpen = openMenuSongId === song.id;
                    const isActiveNav = activeIndex === idx;
                    return (
                      <SearchTrackRow
                        key={song.id}
                        song={song}
                        songs={filteredSongs}
                        query={query}
                        currentSong={currentSong}
                        isPlaying={isPlaying}
                        isActiveNav={isActiveNav}
                        liked={liked}
                        isPendingLiked={pendingLikedIds.has(String(song.id))}
                        isPopAnimating={animatingLikedIds.has(String(song.id))}
                        isMenuOpen={isMenuOpen}
                        isBulkSelecting={isBulkSelecting}
                        isBulkSelected={selectedSongIds.includes(String(song.id))}
                        onPlay={(targetSong, songList) => {
                          recordRecentEntity({
                            type: 'song',
                            id: targetSong.id,
                            title: targetSong.title,
                            artist: targetSong.artist,
                            coverUrl: targetSong.cover_url,
                            song: targetSong,
                          });
                          playSong(targetSong, songList);
                        }}
                        onToggleLiked={toggleLiked}
                        onAnimationEnd={clearAddedAnimation}
                        onAddToPlaylist={(selectedSong, event) => {
                          event?.stopPropagation();
                          openAddToPlaylist(selectedSong);
                        }}
                        onToggleBulkSelection={toggleBulkSong}
                        onInsertNext={insertNextWithFeedback}
                        onToggleMenu={(songId) => setOpenMenuSongId((prev) => (prev === songId ? null : songId))}
                        onCloseMenu={() => setOpenMenuSongId(null)}
                        onFilterArtist={(artist) => {
                          const artistSongs = songs.filter(s => (s.artist || '').toLowerCase() === (artist || '').toLowerCase());
                          recordRecentEntity({
                            type: 'artist',
                            name: artist,
                            coverUrl: song.cover_url,
                          });
                          useUIStore.getState().openArtistDrawer({
                            name: artist,
                            songs: artistSongs.length > 0 ? artistSongs : [song],
                            coverUrl: song.cover_url,
                          });
                        }}
                      />
                    );
                  })}
                </div>

                {hasMore && (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="secondary-button mx-auto mt-6 flex min-h-11 items-center gap-2 px-5 py-2 text-sm font-semibold disabled:opacity-60"
                  >
                    {loadingMore ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
                    {loadingMore ? '加载中…' : '加载更多'}
                  </button>
                )}
              </div>
            )}
            {(subView === 'artists' || subView === 'albums') && (
              <div>
                <PageBackButton onClick={() => navigateResults('overview')} className="mb-5" />
                <h2 className="text-2xl sm:text-3xl font-bold mb-7">{subView === 'artists' ? '歌手' : '专辑'}</h2>
                {subView === 'artists' ? (
                  <>
                    <div className="artist-full-grid">
                      {fullArtistResults.items.map((artist) => <ArtistCard key={artist.name} artist={artist} onOpen={() => {
                        recordRecentEntity({ type: 'artist', name: artist.name, coverUrl: artist.photoUrl || artist.coverUrl });
                        useUIStore.getState().openArtistDrawer({ name: artist.name, coverUrl: artist.photoUrl || artist.coverUrl });
                      }} />)}
                    </div>
                    {fullArtistResults.hasMore && <button type="button" className="secondary-button mt-6 px-4 py-2" onClick={fullArtistResults.loadMore} disabled={fullArtistResults.loadingMore}>{fullArtistResults.loadingMore ? '加载中…' : '加载更多'}</button>}
                  </>
                ) : (
                  <>
                    <AlbumPreviewGrid albums={fullAlbumResults.items} maxRows={Infinity}
                      onOpen={(album) => syncBrowserHistory(formatPath({ type: 'album', id: album.id }))} />
                    {fullAlbumResults.hasMore && <button type="button" className="secondary-button mt-6 px-4 py-2" onClick={fullAlbumResults.loadMore} disabled={fullAlbumResults.loadingMore}>{fullAlbumResults.loadingMore ? '加载中…' : '加载更多'}</button>}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
