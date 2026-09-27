import React, { useState, useEffect, useLayoutEffect, useRef, Suspense } from 'react';
import { useMusicData } from './hooks/useMusicData.js';
import { useTheme } from './hooks/useTheme.js';
import { useLyricsFetcher } from './hooks/useLyricsFetcher.js';
import { useGlobalKeyboardShortcuts } from './hooks/useKeyboard.js';
import { useMediaSession } from './hooks/useMediaSession.js';
import AppSidebar from './components/AppSidebar.jsx';
import ShellEnvironment from './components/ShellEnvironment.jsx';
import MainContent from './components/MainContent.jsx';
import PlayerBar from './components/PlayerBar.jsx';
import AddToPlaylistModal from './components/AddToPlaylistModal.jsx';
import QuickSongEditDialog from './components/QuickSongEditDialog.jsx';
import { usePlayerStore } from './store/usePlayerStore';
import { useUIStore, showToast } from './store/useUIStore';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerContext } from './hooks/usePlayerContext';
import { useAudioEngine } from './hooks/useAudioEngine';
import { getShellThemeStyle } from './constants/shellThemes';
import { useCoverAccent } from './hooks/useCoverAccent';
import { useVisualMotionProfile } from './hooks/useVisualMotionProfile';
import { useWakeLock } from './hooks/useWakeLock';
import { useRandomRoam } from './hooks/useRandomRoam';
import { clearFullscreenRootScrollLock, setFullscreenRootScrollLock } from './utils/fullscreenRootScroll.js';
import { accountPlaylistsStore } from './accountPlaylists.js';
import { usePlayStatsStore } from './store/usePlayStatsStore.js';
import { usePlaybackPresentation } from './hooks/usePlaybackPresentation.js';
import { selectHasRenderableWallpaper, useWallpaperStore } from './store/useWallpaperStore.js';
import { toShellAuthSession } from './instance/state.js';
import { parsePathname, parseAppLocation, formatPath, syncBrowserHistory, ensureHistoryScrollEntry, SUPPORTED_PAGES } from './utils/navigation.js';

const retryDynamicImport = (importer, retries = 2, delayMs = 600) => async () => {
    try {
        return await importer();
    } catch (error) {
        if (retries <= 0) throw error;
        console.warn('[dynamicImport] 模块加载重试中...', error);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return retryDynamicImport(importer, retries - 1, Math.round(delayMs * 1.5))();
    }
};

const loadFullScreenPlayer = () => import('./components/FullScreenPlayer.jsx').catch((err) => {
    console.warn('全屏播放器组件加载重试中...', err);
    return import('./components/FullScreenPlayer.jsx');
});
const FullScreenPlayer = React.lazy(loadFullScreenPlayer);
const PlaylistDrawer = React.lazy(retryDynamicImport(() => import('./components/PlaylistDrawer.jsx')));
const AccountPlaylistDrawer = React.lazy(retryDynamicImport(() => import('./components/AccountPlaylistDrawer.jsx')));
const RoamSettingsDrawer = React.lazy(retryDynamicImport(() => import('./components/RoamSettingsDrawer.jsx')));
const FootprintDrawer = React.lazy(retryDynamicImport(() => import('./components/FootprintDrawer.jsx')));
const BackgroundDrawer = React.lazy(retryDynamicImport(() => import('./components/BackgroundDrawer.jsx')));

const OVERLAY_CLOSE_ORDER = [
    ['quickSongEditId', 'closeQuickSongEdit'],
    ['isAddToPlaylistOpen', 'closeAddToPlaylist'],
    ['isAccountPlaylistOpen', 'setIsAccountPlaylistOpen'],
    ['isFootprintDrawerOpen', 'setIsFootprintDrawerOpen'],
    ['isPlaylistOpen', 'setIsPlaylistOpen'],
    ['isBackgroundDrawerOpen', 'setIsBackgroundDrawerOpen'],
    ['isRoamSettingsOpen', 'setIsRoamSettingsOpen'],
    ['isFullScreen', 'setIsFullScreen'],
];

const closeTopOverlay = (state) => {
    for (const [openKey, closeKey] of OVERLAY_CLOSE_ORDER) {
        if (!state[openKey]) continue;
        return state[closeKey](false) !== false;
    }
    if (state.isViewingPlaylist) {
        state.closeViewingPlaylist();
        return true;
    }
    if (state.isViewingAdmin) {
        state.setIsViewingAdmin(false);
    }
    return true;
};

const useOpenedOnce = (isOpen) => {
    const [opened, setOpened] = useState(isOpen);
    useEffect(() => {
        if (isOpen) setOpened(true);
    }, [isOpen]);
    return opened || isOpen;
};

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Lazy component crashed:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="theme-fatal-error fixed inset-0 z-[200] flex items-center justify-center px-6" role="alert">
          <div className="state-panel state-panel--error w-full max-w-md px-8 py-7 text-center">
            <p className="state-panel__eyebrow">PLAYER INTERRUPTED</p>
            <h2 className="mb-2 text-lg font-semibold">播放器加载失败</h2>
            <p className="state-panel__copy mb-5 text-sm">{this.state.error?.message || '播放器组件暂时不可用'}</p>
            <button
              type="button"
              onClick={() => { this.setState({ hasError: false }); window.location.reload(); }}
              className="primary-button min-h-11 px-5 py-2 text-sm font-semibold"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

class DrawerErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error(`[DrawerErrorBoundary] ${this.props.title || 'Drawer'} crashed:`, error, errorInfo);
  }
  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };
  handleClose = () => {
    this.setState({ hasError: false, error: null });
    if (typeof this.props.onClose === 'function') {
      this.props.onClose();
    }
  };
  render() {
    if (this.props.isOpen === false) {
      return null;
    }
    if (this.state.hasError) {
      const isModal = Boolean(this.props.isModal);
      const containerClass = isModal
        ? 'fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-6 backdrop-blur-md'
        : 'fixed inset-y-0 right-0 z-[120] flex w-full max-w-sm flex-col justify-center border-l border-white/10 bg-[var(--surface-raised)]/95 p-6 shadow-2xl backdrop-blur-2xl';
      return (
        <aside className={containerClass} role="alert">
          <div className="text-center">
            <p className="state-panel__eyebrow mb-1 text-xs font-medium text-[var(--accent)]">COMPONENT UNAVAILABLE</p>
            <h3 className="mb-2 text-base font-semibold text-[color:var(--ink)]">{this.props.title || '组件加载未完成'}</h3>
            <p className="mb-5 text-xs leading-relaxed text-[color:var(--muted)]">
              {this.state.error?.message?.includes('Failed to fetch') || this.state.error?.message?.includes('dynamically imported')
                ? '网络连接波动或资源繁忙，未能成功加载组件。'
                : (this.state.error?.message || '组件暂时不可用')}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={this.handleReload}
                className="primary-button min-h-9 px-4 py-1.5 text-xs font-semibold"
              >
                刷新页面
              </button>
              <button
                type="button"
                onClick={this.handleClose}
                className="theme-drawer__close-btn inline-flex min-h-9 items-center justify-center rounded-xl border border-white/10 px-4 py-1.5 text-xs font-semibold text-[color:var(--muted)] hover:text-[color:var(--ink)]"
              >
                关闭
              </button>
            </div>
          </div>
        </aside>
      );
    }
    return this.props.children;
  }
}

export default function App({ validatedSession }) {
    useLayoutEffect(() => {
        const current = useUIStore.getState().authSession;
        if (current.authenticated && current.user?.accountId === validatedSession.user.accountId
            && current.csrfToken === validatedSession.csrfToken) return;
        useUIStore.getState().setAuthSession(toShellAuthSession(validatedSession));
    }, [validatedSession]);
    const {
        currentSong, isPlaying, volume, playlist,
        shouldAutoPlay,
        setPlaylist,
        setAudioRef, togglePlay, playPrev, playNext, setVolume
    } = usePlayerStore(useShallow((state) => ({
        currentSong: state.currentSong,
        isPlaying: state.isPlaying,
        volume: state.volume,
        playlist: state.playlist,
        shouldAutoPlay: state.shouldAutoPlay,
        setPlaylist: state.setPlaylist,
        setAudioRef: state.setAudioRef,
        togglePlay: state.togglePlay,
        playPrev: state.playPrev,
        playNext: state.playNext,
        setVolume: state.setVolume,
    })));

    const { toastMessage, isDarkMode, setIsDarkMode, isFullScreen, setIsFullScreen, isPlaylistOpen, setIsPlaylistOpen, isBackgroundDrawerOpen, setIsBackgroundDrawerOpen, isAccountPlaylistOpen, isRoamSettingsOpen, isFootprintDrawerOpen, isArtistDrawerOpen, setIsArtistDrawerOpen, activeArtistData, isAddToPlaylistOpen, quickSongEditId, isViewingAdmin, isViewingPlaylist, closeViewingPlaylist, visualMotionPhase } = useUIStore(useShallow((state) => ({
        toastMessage: state.toastMessage,
        isDarkMode: state.isDarkMode,
        setIsDarkMode: state.setIsDarkMode,
        isFullScreen: state.isFullScreen,
        setIsFullScreen: state.setIsFullScreen,
        isPlaylistOpen: state.isPlaylistOpen,
        setIsPlaylistOpen: state.setIsPlaylistOpen,
        isBackgroundDrawerOpen: state.isBackgroundDrawerOpen,
        setIsBackgroundDrawerOpen: state.setIsBackgroundDrawerOpen,
        isAccountPlaylistOpen: state.isAccountPlaylistOpen,
        isRoamSettingsOpen: state.isRoamSettingsOpen,
        isFootprintDrawerOpen: state.isFootprintDrawerOpen,
        isArtistDrawerOpen: state.isArtistDrawerOpen,
        setIsArtistDrawerOpen: state.setIsArtistDrawerOpen,
        activeArtistData: state.activeArtistData,
        isAddToPlaylistOpen: state.isAddToPlaylistOpen,
        quickSongEditId: state.quickSongEditId,
        isViewingAdmin: state.isViewingAdmin,
        isViewingPlaylist: state.isViewingPlaylist,
        closeViewingPlaylist: state.closeViewingPlaylist,
        visualMotionPhase: state.visualMotionPhase,
    })));

    const motionProfile = useVisualMotionProfile(visualMotionPhase);

    const {
        toggleTheme,
        themePreference,
        selectTheme,
        activeShellTheme,
    } = useTheme(isDarkMode, setIsDarkMode, motionProfile);

    const coverAccent = useCoverAccent();
    const hasWallpaper = useWallpaperStore(selectHasRenderableWallpaper);
    const cardBlur = useWallpaperStore((s) => s.cardBlur);
    const cardSaturate = useWallpaperStore((s) => s.cardSaturate);
    const cardOpacity = useWallpaperStore((s) => s.cardOpacity);
    const hasOpenedPlaylistDrawer = useOpenedOnce(isPlaylistOpen);
    const hasOpenedBackgroundDrawer = useOpenedOnce(isBackgroundDrawerOpen);
    const hasOpenedAccountPlaylistDrawer = useOpenedOnce(isAccountPlaylistOpen);
    const hasOpenedRoamSettingsDrawer = useOpenedOnce(isRoamSettingsOpen);
    const hasOpenedFootprintDrawer = useOpenedOnce(isFootprintDrawerOpen);

    const audioRef = useRef(null);
    const hasInitializedPlaylist = useRef(false);
    const initialRouteRef = useRef(null);
    if (!initialRouteRef.current && typeof window !== 'undefined') {
        initialRouteRef.current = parseAppLocation(window.location);
    }
    const [activePage, setActivePage] = useState(() => {
        const init = initialRouteRef.current;
        if (init?.type === 'explore') return 'roam';
        if (init?.type === 'playlist' && init?.id === 'daily-recommend') return 'home';
        if (init?.type === 'top-songs' || init?.type === 'top-albums' || init?.type === 'top-artists' || init?.type === 'playlist' || init?.type === 'album') return 'library';
        return (init && init.type === 'page' && SUPPORTED_PAGES.includes(init.page)) ? init.page : 'home';
    });
    const [activeRoute, setActiveRoute] = useState(() => initialRouteRef.current || { type: 'page', page: 'home' });
    useEffect(() => {
        useUIStore.getState().setActivePage(activePage);
    }, [activePage]);
    const routeScrollPositionsRef = useRef({});
    const routeKeyRef = useRef(typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/home');
    const routeEntryRef = useRef(ensureHistoryScrollEntry());
    const routeNavigationModeRef = useRef('initial');
    const [playbackSessionReady, setPlaybackSessionReady] = useState(false);
    const contentScrollRef = useRef(null);
    const adminReturnRef = useRef({ entryId: '', top: 0 });
    const lastToastRef = useRef('');
    const {
        isPlayerContextReady,
        claimPlayback,
        persistPosition,
        persistPositionThrottled,
        persistSeekPosition,
        restorePosition,
    } = usePlayerContext(audioRef);

    const { audioHandlers } = useAudioEngine({
        audioRef,
        claimPlayback,
        persistPosition,
        persistPositionThrottled,
        persistSeekPosition,
        restorePosition,
    });

    useEffect(() => {
        if (toastMessage) lastToastRef.current = toastMessage;
    }, [toastMessage]);

    useEffect(() => {
        if (audioRef) {
            setAudioRef(audioRef);
        }
    }, [setAudioRef]);

    const {
        myPlaylists,
        likedSongs,
        songsMap,
        isLoading,
        loadError,
        retryMusicData,
        patchMusicSong,
    } = useMusicData();
    const authInitialized = useUIStore((state) => Boolean(state.authSession.initialized));
    const authenticated = useUIStore((state) => Boolean(state.authSession.authenticated));
    const accountId = useUIStore((state) => state.authSession.user?.accountId || null);
    useRandomRoam({ authenticated, isPlayerContextReady });

    useLayoutEffect(() => {
        if (authInitialized && authenticated) setPlaybackSessionReady(true);
    }, [authInitialized, authenticated]);

    useEffect(() => {
        if (!authInitialized) return;
        const subject = authenticated ? accountId : null;
        accountPlaylistsStore.getState().setSubject(subject);
        const playStats = usePlayStatsStore.getState();
        playStats.setSubject(subject);
        if (subject) {
            void accountPlaylistsStore.getState().refresh().catch((error) => {
                console.warn('账号歌单加载失败:', error);
            });
            void playStats.synchronizeAccountStats().then((result) => {
                if (!result.ok && result.reason !== 'identity-changed') {
                    console.warn('账号播放统计初始化失败:', result.error || result.reason || result.stage);
                }
            });
        }
    }, [accountId, authInitialized, authenticated]);

    const handleNavigate = React.useCallback((page, section) => {
        const targetPage = SUPPORTED_PAGES.includes(page) ? page : 'home';
        const targetPath = formatPath({ type: 'page', page: targetPage,
            ...(targetPage === 'settings' ? { section } : {}),
            ...(targetPage === 'assistant' ? { section } : {}),
            ...(targetPage === 'lyrics' ? { section, songId: activeRoute.songId } : {}) });
        const ui = useUIStore.getState();
        if (activePage === 'lyrics' && targetPage !== 'lyrics'
            && ui.lyricsWorkspaceBeforeCloseGuard?.() === false) return;
        if (targetPage === activePage && activeRoute.type === 'page' && formatPath(activeRoute) === targetPath && !ui.isViewingPlaylist && !ui.isArtistDrawerOpen) {
            if (ui.isViewingAdmin) ui.setIsViewingAdmin(false);
            if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
            return;
        }
        if (ui.isViewingPlaylist) ui.closeViewingPlaylist();
        if (ui.isViewingAdmin) ui.setIsViewingAdmin(false);
        if (ui.isArtistDrawerOpen) ui.setIsArtistDrawerOpen(false);
        setActivePage(targetPage);
        syncBrowserHistory(targetPath, { replace: targetPage === 'lyrics' && activePage === 'lyrics' });
    }, [activePage, activeRoute]);

    // 首次载入或刷新：规范化根路径或还原深层实体路由
    useEffect(() => {
        const init = initialRouteRef.current;
        if (!init) return;
        if (window.location.pathname === '/' || window.location.pathname === '') {
            syncBrowserHistory('/home', { replace: true });
        } else if (init.type === 'artist' && init.name) {
            useUIStore.getState().openArtistDrawer({ name: init.name, view: init.view || 'overview' });
        }
    }, []);

    // 同步歌手专区与地址栏 URL (/artist/:name, /artist/:name/songs, /artist/:name/albums)
    useEffect(() => {
        if (isArtistDrawerOpen && activeArtistData?.name) {
            const targetUrl = formatPath({
                type: 'artist',
                name: activeArtistData.name,
                view: activeArtistData.view || 'overview',
            });
            syncBrowserHistory(targetUrl);
        } else if (!isArtistDrawerOpen && !isViewingPlaylist) {
            const currentRoute = parsePathname(window.location.pathname);
            if (currentRoute.type === 'artist') {
                syncBrowserHistory(`/${activePage}`);
            }
        }
    }, [isArtistDrawerOpen, activeArtistData?.name, activeArtistData?.view, activePage, isViewingPlaylist]);

    // 当前 URL 是内容页的唯一来源；替换搜索词不增加历史条目。
    useEffect(() => {
        const handleNavigation = (event) => {
            if (!event.detail?.replace && contentScrollRef.current) {
                routeScrollPositionsRef.current[routeEntryRef.current] = contentScrollRef.current.scrollTop;
            }
            routeNavigationModeRef.current = event.detail?.replace ? 'replace' : 'push';
            routeKeyRef.current = window.location.pathname + window.location.search;
            routeEntryRef.current = ensureHistoryScrollEntry();
            const nextRoute = parseAppLocation(window.location);
            const ui = useUIStore.getState();
            if (nextRoute.page !== 'lyrics') useUIStore.setState({ lyricsWorkspaceExitApproved: false });
            if (nextRoute.type !== 'artist' && ui.isArtistDrawerOpen) ui.setIsArtistDrawerOpen(false);
            if (nextRoute.type !== 'playlist' && ui.isViewingPlaylist) ui.closeViewingPlaylist();
            setActiveRoute(nextRoute);
            if (nextRoute.type === 'page') setActivePage(nextRoute.page);
            else if (nextRoute.type === 'explore') setActivePage('roam');
            else if (nextRoute.type === 'top-songs' || nextRoute.type === 'top-albums' || nextRoute.type === 'top-artists') setActivePage('library');
        };
        window.addEventListener('flaretune:navigate', handleNavigation);
        return () => window.removeEventListener('flaretune:navigate', handleNavigation);
    }, []);

    // 响应浏览器原生前进/后退 (popstate)
    useEffect(() => {
        const handlePopState = () => {
            const previousRoute = parsePathname(routeKeyRef.current);
            const nextRoute = parseAppLocation(window.location);
            const ui = useUIStore.getState();
            if (previousRoute.page === 'lyrics' && nextRoute.page !== 'lyrics') {
                if (ui.lyricsWorkspaceExitApproved) {
                    useUIStore.setState({ lyricsWorkspaceExitApproved: false });
                } else if (ui.lyricsWorkspaceBeforeCloseGuard?.() === false) {
                    window.history.pushState({ url: routeKeyRef.current, from: window.location.pathname + window.location.search }, '', routeKeyRef.current);
                    return;
                }
            }
            if (contentScrollRef.current) {
                routeScrollPositionsRef.current[routeEntryRef.current] = contentScrollRef.current.scrollTop;
            }
            routeNavigationModeRef.current = 'pop';
            routeKeyRef.current = window.location.pathname + window.location.search;
            routeEntryRef.current = ensureHistoryScrollEntry();
            const route = nextRoute;
            setActiveRoute(route);
            if (route.type === 'artist' && route.name) {
                if (ui.isViewingPlaylist) ui.closeViewingPlaylist();
                if (ui.isViewingAdmin) ui.setIsViewingAdmin(false);
                const currentData = ui.activeArtistData;
                const isSameArtist = currentData?.name?.toLowerCase() === route.name.toLowerCase();
                ui.openArtistDrawer(
                    isSameArtist
                        ? { ...currentData, view: route.view || 'overview' }
                        : { name: route.name, view: route.view || 'overview' }
                );
            } else if (route.type === 'page') {
                if (ui.isArtistDrawerOpen) ui.setIsArtistDrawerOpen(false);
                if (ui.isViewingPlaylist) ui.closeViewingPlaylist();
                if (ui.isViewingAdmin) ui.setIsViewingAdmin(false);
                setActivePage(route.page);
            } else {
                if (ui.isArtistDrawerOpen) ui.setIsArtistDrawerOpen(false);
                if (route.type !== 'playlist' && ui.isViewingPlaylist) ui.closeViewingPlaylist();
                if (route.type === 'explore') setActivePage('roam');
                else if (route.type === 'top-songs' || route.type === 'top-albums' || route.type === 'top-artists') setActivePage('library');
            }
        };
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    useLayoutEffect(() => {
        const container = contentScrollRef.current;
        if (!container) return undefined;
        const key = routeEntryRef.current;
        const top = routeNavigationModeRef.current === 'pop'
            ? routeScrollPositionsRef.current[key] || 0
            : routeNavigationModeRef.current === 'replace' && activeRoute?.page !== 'lyrics' ? container.scrollTop : 0;
        container.scrollTop = top;
        let observer;
        const frame = requestAnimationFrame(() => {
            container.scrollTop = top;
            if (top > container.scrollTop && typeof ResizeObserver !== 'undefined') {
                observer = new ResizeObserver(() => {
                    container.scrollTop = top;
                    if (Math.abs(container.scrollTop - top) < 2) observer.disconnect();
                });
                observer.observe(container.firstElementChild || container);
            }
        });
        return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
    }, [activeRoute]);

    useEffect(() => useUIStore.subscribe((next, previous) => {
        if (!previous.isViewingAdmin && next.isViewingAdmin) {
            adminReturnRef.current = {
                entryId: routeEntryRef.current,
                top: contentScrollRef.current?.scrollTop || 0,
            };
        }
    }), []);

    const restorePageScroll = React.useCallback((nextScrollTop) => {
        const container = contentScrollRef.current;
        if (!container) return undefined;
        container.scrollTop = nextScrollTop;
        let settleFrame = null;
        const restoreFrame = requestAnimationFrame(() => {
            container.scrollTop = nextScrollTop;
            settleFrame = requestAnimationFrame(() => {
                container.scrollTop = nextScrollTop;
            });
        });
        return () => {
            cancelAnimationFrame(restoreFrame);
            if (settleFrame !== null) cancelAnimationFrame(settleFrame);
        };
    }, []);

    const previousAdminOpenRef = useRef(isViewingAdmin);
    useLayoutEffect(() => {
        const wasOpen = previousAdminOpenRef.current;
        previousAdminOpenRef.current = isViewingAdmin;
        if (!wasOpen || isViewingAdmin || adminReturnRef.current.entryId !== routeEntryRef.current) return undefined;
        return restorePageScroll(adminReturnRef.current.top);
    }, [activePage, isViewingAdmin, restorePageScroll]);

    useEffect(() => {
        if (isPlayerContextReady && !hasInitializedPlaylist.current && likedSongs.length > 0) {
            hasInitializedPlaylist.current = true;
            if (playlist.length === 0) {
                setPlaylist(likedSongs);
            }
        }
    }, [isPlayerContextReady, likedSongs, playlist.length, setPlaylist]);

    // === 使用提取出来的 Hooks ===
    useEffect(() => {
        let fallbackTimer = null;
        const warmPlayerCode = () => {
            void loadFullScreenPlayer().catch(() => {
                // Idle prefetch is best-effort; React.lazy owns the real load attempt.
            });
        };

        if ('requestIdleCallback' in window) {
            const idleId = window.requestIdleCallback(warmPlayerCode, { timeout: 4000 });
            return () => window.cancelIdleCallback(idleId);
        }

        fallbackTimer = window.setTimeout(warmPlayerCode, 2400);
        return () => window.clearTimeout(fallbackTimer);
    }, []);
    
    useLyricsFetcher({ enabled: authenticated });

    useGlobalKeyboardShortcuts({ 
        togglePlay, 
        isPlaying, 
        playPrev, 
        playNext, 
        volume, 
        setVolume, 
        showToast,
        onOpenSearch: () => handleNavigate('search')
    });

    useMediaSession({ 
        currentSong, 
        isPlaying, 
        togglePlay, 
        playPrev, 
        playNext, 
        playlist 
    });

    useWakeLock({ isFullScreen });

    useLayoutEffect(() => {
        setFullscreenRootScrollLock(document.documentElement, isFullScreen);
        return () => {
            clearFullscreenRootScrollLock(document.documentElement);
        };
    }, [isFullScreen]);

    // === 返回键拦截：关闭当前覆盖层而非退出网页 ===
    const prevAnyOpen = useRef(false);
    const secondaryModalOpen = Boolean(quickSongEditId) || isPlaylistOpen
        || isBackgroundDrawerOpen || isRoamSettingsOpen
        || isAccountPlaylistOpen || isAddToPlaylistOpen || isFootprintDrawerOpen;
    const modalOpen = isFullScreen || secondaryModalOpen;
    const anyOpen = modalOpen || isViewingPlaylist || isViewingAdmin;

    useEffect(() => {
        if (anyOpen && !prevAnyOpen.current) {
            window.history.pushState({ hermes_overlay: true }, '', window.location.href);
        }
        prevAnyOpen.current = anyOpen;
    }, [anyOpen]);

    useEffect(() => {
        const handlePopState = () => {
            const state = useUIStore.getState();
            if (!closeTopOverlay(state)) {
                window.history.pushState({ hermes_overlay: true }, '', window.location.href);
            }
        };
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    // === 播放控制 ===
    useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

    usePlaybackPresentation(currentSong, isPlaying);

    const rootStyle = {
        ...getShellThemeStyle(activeShellTheme, isDarkMode),
        '--cover-accent': coverAccent,
        '--card-glass-blur': `${cardBlur}px`,
        '--card-glass-saturate': `${cardSaturate}%`,
        '--card-glass-opacity': `${cardOpacity}%`,
        overscrollBehavior: 'none',
    };

    return (
        <div 
            className="music-shell flex h-screen w-full flex-col overflow-hidden select-none"
            data-shell-theme="fluid"
            data-motion-phase={visualMotionPhase}
            data-motion-profile={motionProfile}
            data-has-wallpaper={hasWallpaper ? 'true' : 'false'}
            style={rootStyle}
        >
            {/* 网格点阵背景层 */}
            <ShellEnvironment />

            <div className="relative z-10 flex h-full flex-col">
            <div className="app-workspace relative flex min-h-0 flex-1" aria-hidden={modalOpen ? true : undefined} inert={modalOpen ? '' : undefined}>
                <AppSidebar activePage={activePage} activeRoute={activeRoute} onNavigate={handleNavigate} />
                <main className="app-main flex-1 min-h-0 flex flex-col relative overflow-hidden">
                    {loadError ? (
                        <div className="h-full flex items-center justify-center px-6 pt-[var(--header-height,62px)]" role="alert">
                            <div className="state-panel state-panel--error max-w-md px-8 py-7 text-center">
                                <p className="state-panel__eyebrow">CONNECTION INTERRUPTED</p>
                                <h2 className="mb-2 text-lg font-semibold">音乐库暂时不可用</h2>
                                <p className="state-panel__copy mb-5 text-sm">{loadError}</p>
                                <button type="button" onClick={retryMusicData} className="primary-button px-5 py-2 text-sm font-semibold">
                                    重新加载
                                </button>
                            </div>
                        </div>
                    ) : isLoading && myPlaylists.length === 0 ? (
                        <div className="h-full flex items-center justify-center px-6 pt-[var(--header-height,62px)]" role="status" aria-label="正在加载音乐库">
                            <div className="state-panel state-panel--loading w-full max-w-sm px-8 py-7">
                                <p className="state-panel__eyebrow">OPENING THE RECORD SHELF</p>
                                <p className="state-panel__copy text-sm">正在加载音乐库</p>
                                <div className="state-skeleton mt-5" aria-hidden="true"><i></i><i></i><i></i></div>
                            </div>
                        </div>
                    ) : (
                        <MainContent
                            myPlaylists={myPlaylists}
                            likedSongs={likedSongs}
                            songsMap={songsMap}
                            activeShellTheme={activeShellTheme}
                            activePage={activePage}
                            activeRoute={activeRoute}
                            onNavigate={handleNavigate}
                            toggleTheme={toggleTheme}
                            themePreference={themePreference}
                            selectTheme={selectTheme}
                            scrollContainerRef={contentScrollRef}
                        />
                    )}
                </main>
            </div>
            <div
                className="app-player-surface"
                role={isFullScreen ? 'dialog' : undefined}
                aria-modal={isFullScreen ? true : undefined}
                aria-label={isFullScreen ? '全屏播放器' : undefined}
                inert={secondaryModalOpen ? '' : undefined}
            >
                {playbackSessionReady && <PlayerBar motionProfile={motionProfile} activePage={activePage} />}
                <ErrorBoundary>
                  <Suspense fallback={null}>
                      {playbackSessionReady && isFullScreen && <FullScreenPlayer motionProfile={motionProfile} />}
                  </Suspense>
                </ErrorBoundary>
            </div>
            <DrawerErrorBoundary title="播放列表" isOpen={isPlaylistOpen} onClose={() => useUIStore.getState().setIsPlaylistOpen(false)}>
              <Suspense fallback={null}>
                   {hasOpenedPlaylistDrawer && <PlaylistDrawer motionProfile={motionProfile} />}
              </Suspense>
            </DrawerErrorBoundary>
            <DrawerErrorBoundary title="背景设置" isOpen={isBackgroundDrawerOpen} onClose={() => useUIStore.getState().setIsBackgroundDrawerOpen(false)}>
              <Suspense fallback={null}>
                   {authenticated && hasOpenedBackgroundDrawer && <BackgroundDrawer />}
              </Suspense>
            </DrawerErrorBoundary>
             <DrawerErrorBoundary title="个人歌单" isOpen={isAccountPlaylistOpen} onClose={() => useUIStore.getState().setIsAccountPlaylistOpen(false)}>
               <Suspense fallback={null}>
                    {authenticated && hasOpenedAccountPlaylistDrawer && <AccountPlaylistDrawer />}
               </Suspense>
             </DrawerErrorBoundary>
             <DrawerErrorBoundary title="随心漫游偏好" isOpen={isRoamSettingsOpen} onClose={() => useUIStore.getState().setIsRoamSettingsOpen(false)}>
               <Suspense fallback={null}>
                    {authenticated && hasOpenedRoamSettingsDrawer && <RoamSettingsDrawer />}
               </Suspense>
             </DrawerErrorBoundary>
             <DrawerErrorBoundary title="音乐足迹" isOpen={isFootprintDrawerOpen} onClose={() => useUIStore.getState().setIsFootprintDrawerOpen(false)}>
               <Suspense fallback={null}>
                    {authenticated && hasOpenedFootprintDrawer && <FootprintDrawer />}
               </Suspense>
             </DrawerErrorBoundary>
            {authenticated && <AddToPlaylistModal />}
            {authenticated && quickSongEditId && <QuickSongEditDialog
                songId={quickSongEditId}
                onClose={() => useUIStore.getState().closeQuickSongEdit()}
                onSaved={(song) => {
                    const patch = { title: song.title, artist: song.artist, album: song.album, language: song.language, cover_url: song.cover_url };
                    usePlayerStore.getState().patchSongMetadata(song.id, patch);
                    patchMusicSong(song.id, patch);
                    useUIStore.setState((state) => ({ playlistSongs: state.playlistSongs.map((item) => item.id === song.id ? { ...item, ...patch } : item) }));
                    accountPlaylistsStore.setState((state) => ({
                        details: Object.fromEntries(Object.entries(state.details).map(([id, detail]) => [id, {
                            ...detail,
                            songs: Array.isArray(detail.songs) ? detail.songs.map((item) => item.id === song.id ? { ...item, ...patch } : item) : detail.songs,
                        }])),
                    }));
                    window.dispatchEvent(new CustomEvent('flaretune:catalog-song-updated', { detail: { id: song.id, ...patch } }));
                    showToast('歌曲信息已更新');
                }}
            />}
            <audio
                ref={audioRef}
                preload="metadata"
                controlsList="nodownload"
                onContextMenu={(e) => e.preventDefault()}
                {...audioHandlers}
                crossOrigin="anonymous"
                src={playbackSessionReady ? (currentSong?.audio_url || undefined) : undefined}
            />
            <div role="status" aria-live="polite" className={`fixed top-20 left-1/2 transform -translate-x-1/2 z-[9999] transition-all duration-300 ${toastMessage ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3 pointer-events-none'}`}>
                <div className="theme-toast flex items-center gap-3 px-6 py-3">
                    <span>{toastMessage || lastToastRef.current}</span>
                </div>
            </div>
            </div>
        </div>
    );
}
