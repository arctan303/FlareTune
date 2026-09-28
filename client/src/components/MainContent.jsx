import React, { useRef, useState, useEffect } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { useUIStore, showToast } from '../store/useUIStore';
import { hydrateSong } from '../utils';
import { useShallow } from 'zustand/react/shallow';
import { imageLoadRegistry } from '../utils/imageLoadRegistry';
import {
    createLatestRequestGuard,
} from '../utils/expiringAsyncCache';
import { accountPlaylistsStore, isAccountPlaylistStaleError, useAccountPlaylists } from '../accountPlaylists.js';
import { resolveVisibleShelfPlaylists } from '../accountPlaylistOrdering.js';
import { createMemberPlaylistInfo, loadPlaylistPayload } from '../services/playlistPayloadLoader.js';
import { useRandomSongs } from '../hooks/useRandomSongs';
import SearchView from './SearchView.jsx';
import { getPlaylistCoverUrls, PLAYLIST_COVER_FALLBACK } from './PlaylistCover.jsx';
import PlaylistDetailView from './PlaylistDetailView.jsx';
import AllPlaylistsView from './AllPlaylistsView.jsx';
import { HomeExploreSection } from './HomeCollectionSections.jsx';
import RoamOverview from './RoamOverview.jsx';
import HomeOverview from './HomeOverview.jsx';
import PlayHistoryView from './PlayHistoryView.jsx';
import SettingsView from './SettingsView.jsx';
const LyricsManagementWorkspace = React.lazy(() => import('./LyricsManagementWorkspace.jsx'));
import AssistantView from './AssistantView.jsx';
import ArtistDetailView from './ArtistDetailView.jsx';
import AlbumDetailView from './AlbumDetailView.jsx';
import CatalogBrowserView from './CatalogBrowserView.jsx';
import TrackRow from './TrackRow.jsx';
import ArtistCard from './catalog/ArtistCard.jsx';
import AlbumPreviewGrid from './catalog/AlbumPreviewGrid.jsx';
import PageBackButton from './PageBackButton.jsx';
import { formatPath, returnToOriginRoute, syncBrowserHistory } from '../utils/navigation.js';
import { EXPLORE_CATEGORIES } from '../constants/explore.js';
import { useFavoriteSongAction } from '../hooks/useFavoriteSongAction.js';
import { useSongLanguageCounts } from '../hooks/useSongLanguageCounts.js';
import { insertNextWithFeedback } from '../services/playerActions.js';
import { usePlayStatsStore } from '../store/usePlayStatsStore.js';
import { deriveTopArtists } from '../utils/topArtists.js';

const AdminView = React.lazy(() => import('./AdminView.jsx'));

const ROAM_LANGUAGE_OPTIONS = [
    { key: 'all', label: '全库' },
    { key: 'zh', label: '华语' },
    { key: 'ja', label: '日文' },
    { key: 'en', label: '欧美' },
    { key: 'yue', label: '粤语' },
];

export default function MainContent({ myPlaylists, likedSongs, songsMap, activePage, activeRoute, onNavigate, toggleTheme, themePreference, selectTheme, scrollContainerRef }) {
    const accountPlaylists = useAccountPlaylists((state) => state.playlists);
    const accountDetails = useAccountPlaylists((state) => state.details);
    const accountShelf = useAccountPlaylists((state) => state.shelf);
    const accountStatus = useAccountPlaylists((state) => state.status);
    const accountError = useAccountPlaylists((state) => state.error);
    const {
        favoritePlaylist,
        favoriteDetail,
        favoriteSongIds: likedSongIdSet,
        toggleFavorite: toggleLikedWithFeedback,
    } = useFavoriteSongAction();
    const { currentSong, isPlaying, playSong, randomRoam, startRandomRoam, playlist, setRandomRoamEnabled, setRandomRoamLanguage } = usePlayerStore(useShallow((state) => ({
        currentSong: state.currentSong,
        isPlaying: state.isPlaying,
        playSong: state.playSong,
        randomRoam: state.randomRoam,
        startRandomRoam: state.startRandomRoam,
        playlist: state.playlist,
        setRandomRoamEnabled: state.setRandomRoamEnabled,
        setRandomRoamLanguage: state.setRandomRoamLanguage,
    })));
    const viewingPlaylist = useUIStore(s => s.viewingPlaylistData);

    const playlistSongs = useUIStore(s => s.playlistSongs);
    const playlistInfo = useUIStore(s => s.playlistInfo);
    const isViewingPlaylist = useUIStore(s => s.isViewingPlaylist);
    const setViewingPlaylist = useUIStore(s => s.setViewingPlaylist);
    const closeViewingPlaylist = useUIStore(s => s.closeViewingPlaylist);
    const isViewingAdmin = useUIStore(s => s.isViewingAdmin);
    const setIsViewingAdmin = useUIStore(s => s.setIsViewingAdmin);
    const isArtistDrawerOpen = useUIStore(s => s.isArtistDrawerOpen);
    const setIsArtistDrawerOpen = useUIStore(s => s.setIsArtistDrawerOpen);
    const activeArtistData = useUIStore(s => s.activeArtistData);
    const setIsAccountPlaylistOpen = useUIStore(s => s.setIsAccountPlaylistOpen);
    const openAddToPlaylist = useUIStore((s) => s.openAddToPlaylist);
    const authUser = useUIStore((state) => state.authSession.user || null);
    const isAuthenticated = useUIStore((state) => Boolean(state.authSession.authenticated));
    const topSongs = usePlayStatsStore((state) => state.topSongs);
    const topAlbums = usePlayStatsStore((state) => state.topAlbums);
    const resolvedTopSongs = React.useMemo(() => (topSongs || []).map((song) => {
        const mapped = songsMap instanceof Map
            ? songsMap.get(String(song.id)) || songsMap.get(Number(song.id)) || {}
            : songsMap?.[song.id] || {};
        return hydrateSong({ ...mapped, ...song, play_count: song.play_count || mapped.play_count || 0 });
    }).filter((song) => song?.title), [songsMap, topSongs]);
    const topArtists = React.useMemo(() => deriveTopArtists(resolvedTopSongs), [resolvedTopSongs]);
    const backToContent = React.useCallback((fallback = '/home') => {
        if (returnToOriginRoute(fallback) === 'replace') {
            onNavigate?.(fallback.replace(/^\//, ''));
        }
    }, [onNavigate]);
    const backToAlbumOrigin = React.useCallback(() => {
        if (returnToOriginRoute('/library') === 'replace') onNavigate?.('library');
    }, [onNavigate]);
    const shelfPlaylists = React.useMemo(() => resolveVisibleShelfPlaylists({
        memberPlaylists: accountPlaylists,
        shelf: accountShelf,
        authenticated: true,
    }), [accountPlaylists, accountShelf]);
    const retryAccountPlaylists = React.useCallback(() => {
        void accountPlaylistsStore.getState().refresh().catch((error) => {
            if (!isAccountPlaylistStaleError(error)) console.warn('账号歌单重试失败:', error);
        });
    }, []);
    const {
        songs: randomSongs,
        isLoading: isRandomLoading,
        isRefreshing: isRandomRefreshing,
        isCoolingDown: isRandomCoolingDown,
        error: randomError,
        refresh: refreshRandomSongs,
    } = useRandomSongs(isAuthenticated);
    const handleRefreshRandomSongs = React.useCallback(async () => {
        const result = await refreshRandomSongs();
        if (!result?.ok && result?.message) showToast(result.message);
    }, [refreshRandomSongs]);
    const handleRefreshDailyRecommendInDetail = React.useCallback(async () => {
        const result = await refreshRandomSongs();
        if (result?.ok && Array.isArray(result?.songs)) {
            const currentViewing = useUIStore.getState().viewingPlaylistData;
            if (currentViewing?.id === 'daily-recommend') {
                setViewingPlaylist(
                    {
                        ...currentViewing,
                        cover_url: result.songs[0]?.cover_url,
                        preloadedSongs: result.songs,
                        description: `每日随机精选 ${result.songs.length} 首灵感曲目`,
                    },
                    result.songs,
                    playlistInfo
                );
            }
            showToast('已更新今日推荐歌曲');
        } else if (!result?.ok && result?.message) {
            showToast(result.message);
        }
    }, [playlistInfo, refreshRandomSongs, setViewingPlaylist]);
    const currentRoamLang = randomRoam.language || 'all';
    const langCounts = useSongLanguageCounts(isAuthenticated);

    const handleStartRandomRoam = React.useCallback(() => {
        if (randomRoam.enabled) {
            setRandomRoamEnabled(false);
            showToast('已关闭随机漫游');
            return;
        }
        const activeLabel = ROAM_LANGUAGE_OPTIONS.find((opt) => opt.key === currentRoamLang)?.label || '全库';
        if (currentSong && playlist.length > 0) {
            setRandomRoamEnabled(true, { language: currentRoamLang });
            showToast(`已开启【${activeLabel}】随机漫游，将在队尾自动补充歌曲`);
            return;
        }
        if (!startRandomRoam(randomSongs, { language: currentRoamLang })) return;
        showToast(`已开启【${activeLabel}】随机漫游，将在队尾自动补充歌曲`);
    }, [currentRoamLang, currentSong, playlist.length, randomRoam.enabled, randomSongs, setRandomRoamEnabled, startRandomRoam]);

    const handleLoadMoreLibrarySongs = React.useCallback(async () => {
        const activePlaylist = useUIStore.getState().viewingPlaylistData;
        const pagination = activePlaylist?.pagination;
        if (!pagination || !pagination.hasMore) return;
        const nextPage = (pagination.page || 1) + 1;

        try {
            const payload = await loadPlaylistPayload({
                ...activePlaylist,
                langKey: pagination.langKey || activePlaylist.langKey || activePlaylist.id.replace('lang-', ''),
                sort: pagination.sort || 'desc',
                page: nextPage,
                limit: pagination.pageSize || 30,
            }, authUser, { revalidate: true });
            const currentSongs = useUIStore.getState().playlistSongs;
            setViewingPlaylist(
                { ...activePlaylist, ...payload.playlist },
                [...currentSongs, ...payload.songs],
                payload.info || useUIStore.getState().playlistInfo,
            );
        } catch (error) {
            console.error('加载更多失败:', error);
            showToast('加载更多歌曲失败，请稍后重试');
        }
    }, [authUser, setViewingPlaylist]);

    const handleChangeLibrarySort = React.useCallback(async (newSort) => {
        const activePlaylist = useUIStore.getState().viewingPlaylistData;
        if (!activePlaylist) return;

        try {
            const payload = await loadPlaylistPayload({
                ...activePlaylist,
                langKey: activePlaylist.langKey || activePlaylist.id.replace('lang-', ''),
                sort: newSort,
                page: 1,
                limit: 30,
            }, authUser, { revalidate: true });
            setViewingPlaylist(payload.playlist, payload.songs, payload.info);
        } catch (error) {
            console.error('切换排序失败:', error);
            showToast('切换排序失败，请稍后重试');
        }
    }, [authUser, setViewingPlaylist]);
    const { dateHeaderTag, dateZhTag } = React.useMemo(() => {
        const today = new Date();
        const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const monthStr = monthNames[today.getMonth()] || 'TODAY';
        const dayStr = String(today.getDate()).padStart(2, '0');
        const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekdayStr = weekdays[today.getDay()] || '';
        return {
            dateHeaderTag: `${monthStr} ${dayStr} · ${weekdayStr}`,
            dateZhTag: `${today.getMonth() + 1}月${today.getDate()}日`,
        };
    }, []);
    const [leaving, setLeaving] = useState(false);
    const [playlistLoadState, setPlaylistLoadState] = useState({ status: 'idle', playlist: null, error: null });

    const ambientCoverUrl = React.useMemo(() => {
        if (!viewingPlaylist) return null;
        const cover = getPlaylistCoverUrls(viewingPlaylist, songsMap)[0];
        return cover === PLAYLIST_COVER_FALLBACK ? null : cover;
    }, [viewingPlaylist, songsMap]);
    const isHomeConcealed = isViewingPlaylist || ['skeleton', 'error'].includes(playlistLoadState.status);
    const invalidViewingSongCount = Number(viewingPlaylist?.invalidSongCount) || 0;
    const containerRef = scrollContainerRef;
    const homeScrollPosRef = useRef(0);
    const originPlaylistIdRef = useRef(null);
    const originPageRef = useRef(activeRoute?.id === 'daily-recommend' ? 'home' : (activePage || 'home'));
    const detailHeadingRef = useRef(null);
    const skeletonTimerRef = useRef(null);
    const requestGuardRef = useRef(null);
    if (!requestGuardRef.current) requestGuardRef.current = createLatestRequestGuard();
    const viewerKey = authUser?.accountId || '';
    const previousViewerKeyRef = useRef(viewerKey);

    useEffect(() => {
        if (!isViewingPlaylist && activePage) {
            originPageRef.current = activePage;
        }
    }, [activePage, isViewingPlaylist]);

    useEffect(() => {
        if (!isAuthenticated || !favoritePlaylist || favoriteDetail) return;
        void accountPlaylistsStore.getState().loadDetail(favoritePlaylist.id).catch((error) => {
            if (isAccountPlaylistStaleError(error)) return;
            console.warn('我的收藏加载失败:', error);
        });
    }, [favoriteDetail, favoritePlaylist, isAuthenticated]);

    useEffect(() => {
        if (previousViewerKeyRef.current === viewerKey) return;
        previousViewerKeyRef.current = viewerKey;
        const requestToken = requestGuardRef.current.next();
        const playlist = useUIStore.getState().viewingPlaylistData || playlistLoadState.playlist;
        if (!playlist || playlist.preloadedSongs || playlist.songs) return;

        clearSkeletonTimer();
        closeViewingPlaylist();
        if (playlist.source === 'member') {
            setPlaylistLoadState({ status: 'idle', playlist: null, error: null });
            return;
        }
        setPlaylistLoadState({ status: 'skeleton', playlist, error: null });
        const applyIdentityPayload = (payload) => {
            if (!requestGuardRef.current.isCurrent(requestToken)) return;
            const activePlaylist = useUIStore.getState().viewingPlaylistData;
            if (activePlaylist && activePlaylist.id !== playlist.id) return;
            setViewingPlaylist(payload.playlist || activePlaylist || playlist, payload.songs, payload.info);
            setPlaylistLoadState({ status: 'idle', playlist: null, error: null });
        };
        loadPlaylistPayload(playlist, authUser, {
            revalidate: true,
        })
            .then(applyIdentityPayload)
            .catch((error) => {
                if (!requestGuardRef.current.isCurrent(requestToken)) return;
                console.error('登录状态变化后刷新歌单失败:', error);
                closeViewingPlaylist();
                setPlaylistLoadState({ status: 'error', playlist, error });
            });
    }, [authUser, closeViewingPlaylist, playlistLoadState.playlist, setViewingPlaylist, viewerKey]);

    useEffect(() => {
        if (viewingPlaylist?.source !== 'member') return;
        const detail = accountDetails[viewingPlaylist.id];
        if (!detail) return;
        setViewingPlaylist(
            { ...viewingPlaylist, ...detail, source: 'member' },
            (detail.songs || []).map((song) => hydrateSong(song)).filter(Boolean),
            createMemberPlaylistInfo(detail, authUser),
        );
    }, [accountDetails, authUser, setViewingPlaylist, viewingPlaylist?.id, viewingPlaylist?.source]);

    useEffect(() => {
        if (!isAuthenticated || accountStatus !== 'ready' || viewingPlaylist?.source !== 'member') return;
        if (accountPlaylists.some((playlist) => playlist.id === viewingPlaylist.id)) return;
        requestGuardRef.current.cancel();
        clearSkeletonTimer();
        closeViewingPlaylist();
        setPlaylistLoadState({ status: 'idle', playlist: null, error: null });
        showToast('当前个人歌单已被删除');
    }, [accountPlaylists, accountStatus, closeViewingPlaylist, isAuthenticated, viewingPlaylist?.id, viewingPlaylist?.source]);

    const clearSkeletonTimer = () => {
        if (skeletonTimerRef.current !== null) {
            clearTimeout(skeletonTimerRef.current);
            skeletonTimerRef.current = null;
        }
    };

    const restoreHomePositionAndFocus = () => {
        requestAnimationFrame(() => {
            if (containerRef.current) containerRef.current.scrollTop = homeScrollPosRef.current;
            const originId = originPlaylistIdRef.current;
            requestAnimationFrame(() => {
                const origin = [...(containerRef.current?.querySelectorAll('[data-playlist-id]') || [])]
                    .find((element) => element.dataset.playlistId === originId);
                origin?.focus({ preventScroll: true });
            });
        });
    };

    const closePlaylist = () => {
        requestGuardRef.current.cancel();
        clearSkeletonTimer();
        if (!isViewingPlaylist) {
            setPlaylistLoadState({ status: 'idle', playlist: null, error: null });
            restoreHomePositionAndFocus();
            return;
        }

        setLeaving(true);
        if (activeRoute?.type === 'playlist') {
            const fallbackRoute = originPageRef.current === 'library'
                ? '/library'
                : originPageRef.current === 'search'
                    ? '/search'
                    : originPageRef.current === 'roam'
                        ? '/roam'
                        : '/home';
            backToContent(fallbackRoute);
        }
        setTimeout(() => {
            closeViewingPlaylist();
            setLeaving(false);
            restoreHomePositionAndFocus();
        }, 250);
    };

    const prefetchPlaylist = React.useCallback((playlist) => {
        if (!playlist || navigator.connection?.saveData) return;
        void loadPlaylistPayload(playlist, authUser).catch(() => {});
        const urls = getPlaylistCoverUrls(playlist, songsMap);
        void imageLoadRegistry.loadGroup(urls, PLAYLIST_COVER_FALLBACK).catch(() => {});
    }, [songsMap, authUser]);

    const openPlaylist = async (playlist, event = null) => {
        if (!playlist) return;
        if (playlistLoadState.playlist?.id === playlist.id && ['opening', 'skeleton'].includes(playlistLoadState.status)) return;
        if (playlist.id === 'daily-recommend') {
            originPageRef.current = 'home';
        } else if (activePage) {
            originPageRef.current = activePage;
        }
        syncBrowserHistory(formatPath({ type: 'playlist', id: playlist.id }));
        if (!isViewingPlaylist && containerRef.current) {
            homeScrollPosRef.current = containerRef.current.scrollTop;
        }
        if (event?.currentTarget?.dataset?.playlistId) {
            originPlaylistIdRef.current = event.currentTarget.dataset.playlistId;
        }

        const requestToken = requestGuardRef.current.next();
        clearSkeletonTimer();
        setPlaylistLoadState({ status: 'opening', playlist, error: null });
        skeletonTimerRef.current = setTimeout(() => {
            if (requestGuardRef.current.isCurrent(requestToken)) {
                setPlaylistLoadState({ status: 'skeleton', playlist, error: null });
            }
        }, 100);

        try {
            const applyRefreshedPayload = (freshPayload) => {
                if (!requestGuardRef.current.isCurrent(requestToken)) return;
                const activePlaylist = useUIStore.getState().viewingPlaylistData;
                if (activePlaylist?.id !== playlist.id) return;
                setViewingPlaylist(activePlaylist, freshPayload.songs, freshPayload.info);
            };
            const payload = await loadPlaylistPayload(playlist, authUser, {
                revalidate: true,
                staleWhileRevalidate: true,
                onRefresh: applyRefreshedPayload,
            });
            if (!requestGuardRef.current.isCurrent(requestToken)) return;
            clearSkeletonTimer();
            const resolvedPlaylist = payload.playlist || playlist;
            setViewingPlaylist(resolvedPlaylist, payload.songs, payload.info);
            setPlaylistLoadState({ status: 'idle', playlist: null, error: null });
            if (containerRef.current) containerRef.current.scrollTop = 0;
        } catch (error) {
            if (!requestGuardRef.current.isCurrent(requestToken)) return;
            clearSkeletonTimer();
            console.error('加载歌单失败:', error);
            setPlaylistLoadState({ status: 'error', playlist, error });
        }
    };

    React.useEffect(() => {
        if (activeRoute?.type !== 'playlist' || !activeRoute.id) return;
        const memberPlaylist = accountPlaylists.find((item) => String(item.id) === activeRoute.id);
        if (activeRoute.id.startsWith('fav_') && !memberPlaylist) return;
        if (viewingPlaylist?.id === activeRoute.id && isViewingPlaylist) return;
        if (playlistLoadState.playlist?.id === activeRoute.id && ['opening', 'skeleton'].includes(playlistLoadState.status)) return;
        const playlist = memberPlaylist ? { ...memberPlaylist, source: 'member' }
            : activeRoute.id === 'daily-recommend' ? {
                id: 'daily-recommend',
                name: '今日精选',
                cover_url: randomSongs?.[0]?.cover_url,
                preloadedSongs: randomSongs?.slice(0, 8) || [],
                description: `每日精选 ${Math.min(randomSongs?.length || 0, 8)} 首灵感推荐`,
            }
            : shelfPlaylists.find((entry) => String(entry.id) === activeRoute.id)
            || (String(favoritePlaylist?.id) === activeRoute.id ? { ...favoritePlaylist, source: 'member' } : null);
        if (playlist) void openPlaylist(playlist);
    }, [activeRoute?.type, activeRoute?.id, shelfPlaylists, accountPlaylists, favoritePlaylist, randomSongs]);

    const handleOpenLanguageSongs = React.useCallback((lang) => {
        syncBrowserHistory(formatPath({ type: 'explore', language: lang.key }));
    }, []);

    React.useEffect(() => () => {
        requestGuardRef.current.cancel();
        clearSkeletonTimer();
    }, []);

    React.useEffect(() => {
        if (isViewingPlaylist || ['skeleton', 'error'].includes(playlistLoadState.status)) {
            const frame = requestAnimationFrame(() => detailHeadingRef.current?.focus({ preventScroll: true }));
            return () => cancelAnimationFrame(frame);
        }
        return undefined;
    }, [isViewingPlaylist, playlistLoadState.status]);

    const isViewingMemberPlaylist = viewingPlaylist?.source === 'member';

    const renderHome = () => (
        <HomeOverview
            playlists={shelfPlaylists}
            songsMap={songsMap}
            favoritePlaylist={favoritePlaylist}
            favoriteDetail={favoriteDetail}
            likedSongs={likedSongs}
            randomSongs={randomSongs}
            resolvedTopSongs={resolvedTopSongs}
            topAlbums={topAlbums}
            currentSong={currentSong}
            isPlaying={isPlaying}
            playSong={playSong}
            openPlaylist={openPlaylist}
            onOpenHistory={() => syncBrowserHistory('/history')}
            onNavigateRoam={() => onNavigate('roam')}
            onOpenTopSongs={() => syncBrowserHistory('/library/top-songs')}
            onOpenTopAlbums={() => syncBrowserHistory('/library/top-albums')}
            onOpenTopArtists={() => syncBrowserHistory('/library/top-artists')}
            onOpenAlbum={(album) => syncBrowserHistory(formatPath({ type: 'album', id: album.id }))}
            onOpenArtist={(artist) => useUIStore.getState().openArtistDrawer(artist)}
            onToggleRoam={handleStartRandomRoam}
            randomRoam={randomRoam}
            likedSongIdSet={likedSongIdSet}
            toggleLikedWithFeedback={toggleLikedWithFeedback}
            insertNextWithFeedback={insertNextWithFeedback}
            openAddToPlaylist={openAddToPlaylist}
            accountStatus={accountStatus}
            accountError={accountError}
            onRetryAccount={retryAccountPlaylists}
        />
    );

    const renderRoam = () => (
        <RoamOverview
            isAuthenticated
            items={EXPLORE_CATEGORIES}
            langCounts={langCounts}
            onOpenLanguage={handleOpenLanguageSongs}
            onToggleRoam={handleStartRandomRoam}
            randomRoam={randomRoam}
            songsMap={songsMap}
        />
    );

    const renderLibrary = () => (
        <div className="app-page library-page">
            <AllPlaylistsView
                playlists={shelfPlaylists}
                songsMap={songsMap}
                loadState={playlistLoadState}
                onOpen={openPlaylist}
                onPrefetch={prefetchPlaylist}
                onBack={() => onNavigate('home')}
                onManageShelf={() => setIsAccountPlaylistOpen(true)}
                isAuthenticated
                standalone
            />
        </div>
    );

    const isAssistantActive = activePage === 'assistant' && !(isViewingPlaylist && activeRoute?.type === 'playlist') && !(isArtistDrawerOpen && activeArtistData) && activeRoute?.type !== 'album' && activeRoute?.type !== 'explore' && !isViewingAdmin;
    const isLyricsCurrentActive = activePage === 'lyrics' && activeRoute?.type === 'page'
        && (activeRoute.section || 'current') === 'current'
        && !isViewingPlaylist && !isArtistDrawerOpen && !isViewingAdmin;
    const isLyricsCandidatesActive = activePage === 'lyrics' && activeRoute?.type === 'page'
        && activeRoute.section === 'candidates'
        && !isViewingPlaylist && !isArtistDrawerOpen && !isViewingAdmin;

    return (
        <div className={`collection-scroll h-full w-full ${isAssistantActive || isLyricsCurrentActive || isLyricsCandidatesActive ? 'overflow-hidden' : 'overflow-y-auto'} custom-scrollbar`} ref={containerRef}>
            <div
                className="collection-page app-content-canvas"
                data-artist-view={Boolean(isArtistDrawerOpen && activeArtistData)}
                data-assistant-view={isAssistantActive}
                data-lyrics-current-view={isLyricsCurrentActive}
                data-lyrics-candidates-view={isLyricsCandidatesActive}
            >
            <PlaylistDetailView
                isViewingPlaylist={isViewingPlaylist && activeRoute?.type === 'playlist'}
                loadState={activeRoute?.type === 'playlist' ? playlistLoadState : { status: 'idle' }}
                leaving={leaving}
                playlist={viewingPlaylist}
                playlistInfo={playlistInfo}
                playlistSongs={playlistSongs}
                invalidSongCount={invalidViewingSongCount}
                ambientCoverUrl={ambientCoverUrl}
                songsMap={songsMap}
                currentSong={currentSong}
                isPlaying={isPlaying}
                isPersonalPlaylist={isViewingMemberPlaylist}
                showFavoriteAction
                headingRef={detailHeadingRef}
                onClose={closePlaylist}
                onRetry={openPlaylist}
                onPlaySong={playSong}
                onToggleLiked={toggleLikedWithFeedback}
                isSongLiked={(song) => likedSongIdSet.has(String(song.id))}
                onInsertNext={insertNextWithFeedback}
                onAddToPlaylist={(song, event) => { event?.stopPropagation(); openAddToPlaylist(song); }}
                onOpenAssistant={() => onNavigate('assistant')}
                onLoadMoreLibrarySongs={handleLoadMoreLibrarySongs}
                onChangeLibrarySort={handleChangeLibrarySort}
                onRefreshDailyRecommend={handleRefreshDailyRecommendInDetail}
                isRefreshingDailyRecommend={isRandomRefreshing}
            />
            {!(isViewingPlaylist && activeRoute?.type === 'playlist') && (
                activeRoute?.type === 'playlist' ? (
                    playlistLoadState.status === 'idle' ? <div className="app-page" role="status">正在打开歌单…</div> : null
                ) : isArtistDrawerOpen && activeArtistData ? (
                    <ArtistDetailView
                        artist={activeArtistData}
                        onBack={() => {
                            if (returnToOriginRoute('/home') === 'replace') {
                                setIsArtistDrawerOpen(false);
                            }
                        }}
                        currentSong={currentSong}
                        isPlaying={isPlaying}
                        onPlaySong={playSong}
                        onInsertNext={insertNextWithFeedback}
                        onAddToPlaylist={(song, event) => { event?.stopPropagation(); openAddToPlaylist(song); }}
                        onToggleLiked={toggleLikedWithFeedback}
                        isSongLiked={(song) => likedSongIdSet.has(String(song.id))}
                        isAuthenticated
                    />
                ) : activeRoute?.type === 'album' ? (
                    <AlbumDetailView id={activeRoute.id} onBack={backToAlbumOrigin}
                        currentSong={currentSong} isPlaying={isPlaying} onPlaySong={playSong}
                        onInsertNext={insertNextWithFeedback} onAddToPlaylist={(song, event) => { event?.stopPropagation(); openAddToPlaylist(song); }}
                        onToggleLiked={toggleLikedWithFeedback} isSongLiked={(song) => likedSongIdSet.has(String(song.id))} />
                ) : activeRoute?.type === 'explore' ? (
                    <CatalogBrowserView route={activeRoute} onBack={() => backToContent('/roam')}
                        currentSong={currentSong} isPlaying={isPlaying} onPlaySong={playSong}
                        onInsertNext={insertNextWithFeedback} onAddToPlaylist={(song, event) => { event?.stopPropagation(); openAddToPlaylist(song); }}
                        onToggleLiked={toggleLikedWithFeedback} isSongLiked={(song) => likedSongIdSet.has(String(song.id))} />
                ) : activeRoute?.type === 'top-songs' ? (
                    <div className="app-page pb-24">
                        <PageBackButton className="mb-5" onClick={() => backToContent('/home')} />
                        <h1 className="text-3xl font-bold mb-8">常听单曲</h1>
                        <div className="home-track-grid">{resolvedTopSongs.map((song) => <TrackRow key={song.id} song={song} songs={resolvedTopSongs}
                            currentSong={currentSong} isPlaying={isPlaying} playSong={playSong}
                            isLiked={likedSongIdSet.has(String(song.id))} onToggleLiked={toggleLikedWithFeedback}
                            onInsertNext={insertNextWithFeedback} onAddToPlaylist={openAddToPlaylist} />)}</div>
                    </div>
                ) : activeRoute?.type === 'top-albums' ? (
                    <div className="app-page pb-24">
                        <PageBackButton className="mb-5" onClick={() => backToContent('/home')} />
                        <h1 className="text-3xl font-bold mb-8">常听专辑</h1>
                        {topAlbums.length > 0
                            ? <AlbumPreviewGrid albums={topAlbums} maxRows={Infinity}
                                onOpen={(album) => syncBrowserHistory(formatPath({ type: 'album', id: album.id }))} />
                            : <p className="text-sm text-[var(--muted)]">还没有常听专辑</p>}
                    </div>
                ) : activeRoute?.type === 'top-artists' ? (
                    <div className="app-page pb-24">
                        <PageBackButton className="mb-5" onClick={() => backToContent('/home')} />
                        <h1 className="text-3xl font-bold mb-8">常听歌手</h1>
                        {topArtists.length > 0
                            ? <div className="artist-full-grid">
                                {topArtists.map((artist) => <ArtistCard key={artist.name} artist={artist}
                                    onOpen={(selectedArtist) => useUIStore.getState().openArtistDrawer(selectedArtist)} />)}
                              </div>
                            : <p className="text-sm text-[var(--muted)]">还没有常听歌手</p>}
                    </div>
                ) : isViewingAdmin ? (
                    <div className="collection-admin animate-[fade-in_0.3s_ease-out]" hidden={isHomeConcealed}>
                        <React.Suspense fallback={<div className="state-panel p-6 text-sm text-[var(--muted)]">正在加载管理控制台…</div>}>
                            <AdminView onBack={() => setIsViewingAdmin(false)} />
                        </React.Suspense>
                    </div>
                ) : activePage === 'history' ? <PlayHistoryView onBack={() => backToContent('/home')}
                    likedSongIdSet={likedSongIdSet} onToggleLiked={toggleLikedWithFeedback}
                    onInsertNext={insertNextWithFeedback} onAddToPlaylist={openAddToPlaylist} />
                    : activePage === 'assistant' ? <AssistantView isAuthenticated section={activeRoute?.section || 'conversation'} />
                    : activePage === 'search' ? <SearchView route={activeRoute} onBack={() => onNavigate('home')} songsMap={songsMap} />
                        : activePage === 'library' ? renderLibrary()
                        : activePage === 'roam' ? renderRoam()
                            : activePage === 'settings' ? <SettingsView section={activeRoute?.section} themePreference={themePreference} selectTheme={selectTheme} />
                                : activePage === 'lyrics' ? <React.Suspense fallback={<div className="app-page" role="status">正在打开歌词工作台…</div>}>
                                    <LyricsManagementWorkspace route={activeRoute} songFromLibrary={songsMap?.get(String(activeRoute?.songId))} onNavigate={onNavigate} />
                                  </React.Suspense>
                                : renderHome()
            )}
        </div>
    </div>
);
}
