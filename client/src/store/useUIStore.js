import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  VISUAL_MOTION_PHASE,
  getDrawerVisibilityUpdate,
  getPlaylistVisibilityUpdate,
} from '../utils/motionPerformance.js';
import {
  getInitialPlayerMode,
  isPlayerMode,
  writeStoredPlayerMode,
} from '../constants/playerModes.js';
import { accountPlaylistsStore } from '../accountPlaylists.js';
import { usePlayStatsStore } from './usePlayStatsStore.js';
import { usePlayHistoryStore } from './usePlayHistoryStore.js';
import { clearRecentSearchesFromStorage } from '../utils/searchHistory.js';
import { formatPath, syncBrowserHistory } from '../utils/navigation.js';

export const mergePersistedUISettings = (persistedState, currentState) => {
  const settings = persistedState && typeof persistedState === 'object'
    ? { ...persistedState }
    : {};
  delete settings.immersiveBgMode;
  return { ...currentState, ...settings };
};

export const useUIStore = create(
  persist(
    (set, get) => ({
      isFullScreen: false,
      isFullScreenClosing: false,
      setIsFullScreen: (val) => set({ isFullScreen: typeof val === 'function' ? val(get().isFullScreen) : val }),
      setIsFullScreenClosing: (val) => set({ isFullScreenClosing: typeof val === 'function' ? val(get().isFullScreenClosing) : val }),

      activePage: 'home',
      setActivePage: (val) => set({ activePage: val }),

      compactPlayerPlacement: 'dock',
      compactPlayerTransition: null,
      setCompactPlayerPlacement: (value) => {
        if (value !== 'dock' && value !== 'sidebar') return;
        const from = get().compactPlayerPlacement;
        if (value === from || get().compactPlayerTransition) return;
        const reducedMotion = typeof window === 'undefined'
          || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        if (reducedMotion) {
          set({ compactPlayerPlacement: value, compactPlayerTransition: null });
          return;
        }
        set({ compactPlayerTransition: { from, to: value, phase: 'exit' } });
        setTimeout(() => {
          set({ compactPlayerPlacement: value, compactPlayerTransition: { from, to: value, phase: 'enter' } });
          setTimeout(() => set({ compactPlayerTransition: null }), 320);
        }, 220);
      },

      playerMode: getInitialPlayerMode(),
      setPlayerMode: (mode) => {
        if (!isPlayerMode(mode)) return;
        writeStoredPlayerMode(mode);
        set({ playerMode: mode });
      },

      visualMotionPhase: VISUAL_MOTION_PHASE.IDLE,
      setVisualMotionPhase: (val) => set({
        visualMotionPhase: typeof val === 'function' ? val(get().visualMotionPhase) : val,
      }),

      isPlaylistOpen: false,
      setIsPlaylistOpen: (val) => {
        const update = getPlaylistVisibilityUpdate(get().isPlaylistOpen, val);
        if (update?.isPlaylistOpen && get().setIsAccountPlaylistOpen(false) === false) return false;
        if (update) set(update);
        return Boolean(update);
      },

      fullScreenMobileView: 'song',
      setFullScreenMobileView: (val) => set({ fullScreenMobileView: val }),

      immersiveControlsPinned: true,
      setImmersiveControlsPinned: (val) => set({ immersiveControlsPinned: typeof val === 'function' ? val(get().immersiveControlsPinned) : val }),

      immersiveControlsVisible: true,
      setImmersiveControlsVisible: (val) => set({ immersiveControlsVisible: typeof val === 'function' ? val(get().immersiveControlsVisible) : val }),

      immersiveAmbientEnabled: true,
      setImmersiveAmbientEnabled: (val) => set({ immersiveAmbientEnabled: typeof val === 'function' ? val(get().immersiveAmbientEnabled) : val }),

      immersiveAmbientIntensity: 'subtle',
      setImmersiveAmbientIntensity: (val) => set({ immersiveAmbientIntensity: val }),

      isBackgroundDrawerOpen: false,
      setIsBackgroundDrawerOpen: (val) => {
        const update = getDrawerVisibilityUpdate(get().isBackgroundDrawerOpen, val, 'isBackgroundDrawerOpen');
        if (update?.isBackgroundDrawerOpen && !get().authSession?.authenticated) return false;
        if (update?.isBackgroundDrawerOpen && get().setIsAccountPlaylistOpen(false) === false) return false;
        if (update) set(update);
        return Boolean(update);
      },

      lyricsWorkspaceSong: null,
      lyricsWorkspaceBeforeCloseGuard: null,
      lyricsWorkspaceExitApproved: false,
      setLyricsWorkspaceBeforeCloseGuard: (guard) => set({
        lyricsWorkspaceBeforeCloseGuard: typeof guard === 'function' ? guard : null,
      }),
      approveLyricsWorkspaceExit: () => {
        if (get().lyricsWorkspaceBeforeCloseGuard?.() === false) return false;
        set({ lyricsWorkspaceExitApproved: true });
        return true;
      },
      openLyricsWorkspace: (song) => {
        if (!song?.id) return false;
        if (!get().authSession?.authenticated) return false;
        if (get().lyricsWorkspaceBeforeCloseGuard?.() === false) return false;
        if (get().setIsAccountPlaylistOpen(false) === false) return false;
        set({
          lyricsWorkspaceSong: { ...song },
          lyricsWorkspaceExitApproved: false,
          isFullScreen: false,
          isPlaylistOpen: false,
          isBackgroundDrawerOpen: false,
          isRoamSettingsOpen: false,
          isFootprintDrawerOpen: false,
          isArtistDrawerOpen: false,
        });
        syncBrowserHistory(formatPath({ type: 'page', page: 'lyrics', songId: String(song.id), section: 'current' }),
          { replace: typeof window !== 'undefined' && window.location.pathname.startsWith('/lyrics/') });
        return true;
      },
      isRoamSettingsOpen: false,
      setIsRoamSettingsOpen: (val) => {
        const update = getDrawerVisibilityUpdate(get().isRoamSettingsOpen, val, 'isRoamSettingsOpen');
        if (update?.isRoamSettingsOpen && !get().authSession?.authenticated) return false;
        if (update?.isRoamSettingsOpen && get().setIsAccountPlaylistOpen(false) === false) return false;
        if (update) set(update);
        return Boolean(update);
      },

      isFootprintDrawerOpen: false,
      setIsFootprintDrawerOpen: (val) => {
        const update = getDrawerVisibilityUpdate(get().isFootprintDrawerOpen, val, 'isFootprintDrawerOpen');
        if (update?.isFootprintDrawerOpen && !get().authSession?.authenticated) return false;
        if (update?.isFootprintDrawerOpen && get().setIsAccountPlaylistOpen(false) === false) return false;
        if (update) set(update);
        return Boolean(update);
      },

      isArtistDrawerOpen: false,
      activeArtistData: null,
      setIsArtistDrawerOpen: (val) => {
        const update = getDrawerVisibilityUpdate(get().isArtistDrawerOpen, val, 'isArtistDrawerOpen');
        if (update?.isArtistDrawerOpen && !get().authSession?.authenticated) return false;
        if (update?.isArtistDrawerOpen && get().setIsAccountPlaylistOpen(false) === false) return false;
        if (update) set(update);
        return Boolean(update);
      },
      openArtistDrawer: (artistData) => {
        if (!get().authSession?.authenticated) return false;
        const update = getDrawerVisibilityUpdate(get().isArtistDrawerOpen, true, 'isArtistDrawerOpen');
        if (update?.isArtistDrawerOpen && get().setIsAccountPlaylistOpen(false) === false) return false;
        set({
          ...(update || {}),
          isArtistDrawerOpen: true,
          activeArtistData: artistData || null,
        });
        return true;
      },

      isAccountPlaylistOpen: false,
      accountPlaylistBeforeCloseGuard: null,
      registerAccountPlaylistBeforeClose: (guard) => {
        if (typeof guard !== 'function') return () => {};
        set({ accountPlaylistBeforeCloseGuard: guard });
        return () => {
          if (get().accountPlaylistBeforeCloseGuard === guard) set({ accountPlaylistBeforeCloseGuard: null });
        };
      },
      setIsAccountPlaylistOpen: (val, { force = false } = {}) => {
        const update = getDrawerVisibilityUpdate(get().isAccountPlaylistOpen, val, 'isAccountPlaylistOpen');
        if (!update) return true;
        if (update.isAccountPlaylistOpen && !get().authSession?.authenticated) return false;
        if (!update.isAccountPlaylistOpen && !force
          && get().accountPlaylistBeforeCloseGuard?.() === false) return false;
        set(update.isAccountPlaylistOpen ? {
          ...update,
          isPlaylistOpen: false,
          isBackgroundDrawerOpen: false,
          isRoamSettingsOpen: false,
          isFootprintDrawerOpen: false,
          isArtistDrawerOpen: false,
        } : { ...update, accountPlaylistBeforeCloseGuard: null });
        return true;
      },

      isViewingPlaylist: false,
      viewingPlaylistData: null,
      playlistSongs: [],
      playlistInfo: null,
      setViewingPlaylist: (data, songs, info) => {
        if (!get().authSession?.authenticated) return false;
        set({ isViewingPlaylist: true, viewingPlaylistData: data, playlistSongs: songs || [], playlistInfo: info || null });
        return true;
      },
      closeViewingPlaylist: () => set({ isViewingPlaylist: false, viewingPlaylistData: null, playlistSongs: [], playlistInfo: null }),

      quickSongEditId: null,
      quickSongEditReturnFocus: null,
      openQuickSongEdit: (songId, returnFocus = null) => {
        if (get().authSession?.user?.role !== 'admin' || !songId) return false;
        set({ quickSongEditId: String(songId), quickSongEditReturnFocus: returnFocus });
        return true;
      },
      closeQuickSongEdit: () => {
        const returnFocus = get().quickSongEditReturnFocus;
        set({ quickSongEditId: null, quickSongEditReturnFocus: null });
        if (returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
      },

      isViewingAdmin: false,
      setIsViewingAdmin: (val) => {
        const next = typeof val === 'function' ? val(get().isViewingAdmin) : val;
        if (next && !get().authSession?.authenticated) return false;
        set({
          isViewingAdmin: next,
          ...(next ? {
            isViewingPlaylist: false,
            viewingPlaylistData: null,
            playlistSongs: [],
            playlistInfo: null,
            isPlaylistOpen: false,
            isBackgroundDrawerOpen: false,
            isRoamSettingsOpen: false,
            isAccountPlaylistOpen: false,
            isFootprintDrawerOpen: false,
            isArtistDrawerOpen: false,
          } : {}),
        });
        return true;
      },
      isAddToPlaylistOpen: false,
      addToPlaylistSongs: [],
      openAddToPlaylist: (songsOrSong) => {
        if (!get().authSession?.authenticated) return false;
        const songs = Array.isArray(songsOrSong) ? songsOrSong : (songsOrSong ? [songsOrSong] : []);
        set({ isAddToPlaylistOpen: true, addToPlaylistSongs: songs });
        return true;
      },
      closeAddToPlaylist: () => set({ isAddToPlaylistOpen: false, addToPlaylistSongs: [] }),

      isDarkMode: typeof window !== 'undefined' && document.documentElement.classList.contains('dark'),
      setIsDarkMode: (val) => set({ isDarkMode: val }),

      authSession: { authenticated: false, user: null, initialized: false },
      setAuthSession: (val) => {
        const previous = get().authSession;
        const next = typeof val === 'function' ? val(previous) : val;
        const previousAccountId = previous?.authenticated ? previous.user?.accountId || null : null;
        const nextAccountId = next?.authenticated ? next.user?.accountId || null : null;
        accountPlaylistsStore.getState().setSubject(nextAccountId);
        if (next?.initialized) {
          usePlayStatsStore.getState().setSubject(nextAccountId);
          usePlayHistoryStore.getState().setSubject(nextAccountId);
        }
        if (next?.initialized && (!nextAccountId || previousAccountId !== nextAccountId)) {
          clearRecentSearchesFromStorage();
        }
        set({
          authSession: next,
          ...(!nextAccountId || previousAccountId !== nextAccountId ? {
            isAccountPlaylistOpen: false,
            isViewingAdmin: false,
            accountPlaylistBeforeCloseGuard: null,
            isViewingPlaylist: false,
            viewingPlaylistData: null,
            playlistSongs: [],
            playlistInfo: null,
            lyricsWorkspaceSong: null,
            lyricsWorkspaceBeforeCloseGuard: null,
            lyricsWorkspaceExitApproved: false,
            isBackgroundDrawerOpen: false,
            isRoamSettingsOpen: false,
            isFootprintDrawerOpen: false,
            isArtistDrawerOpen: false,
            activeArtistData: null,
            isAddToPlaylistOpen: false,
            addToPlaylistSongs: [],
            quickSongEditId: null,
            quickSongEditReturnFocus: null,
          } : {}),
        });
      },

      toastMessage: '',
      setToastMessage: (val) => set({ toastMessage: val }),

      assistantClearHandler: null,
      setAssistantClearHandler: (handler) => set({
        assistantClearHandler: typeof handler === 'function' ? handler : null,
      }),
      requestAssistantClear: () => get().assistantClearHandler?.(),

      assistantEnableThinking: true,
      xiaoaEnableThinking: true,
      setAssistantEnableThinking: (val) => set((s) => {
        const next = typeof val === 'function' ? val(s.assistantEnableThinking ?? s.xiaoaEnableThinking ?? true) : Boolean(val);
        return { assistantEnableThinking: next, xiaoaEnableThinking: next };
      }),
      setXiaoaEnableThinking: (val) => set((s) => {
        const next = typeof val === 'function' ? val(s.assistantEnableThinking ?? s.xiaoaEnableThinking ?? true) : Boolean(val);
        return { assistantEnableThinking: next, xiaoaEnableThinking: next };
      }),
    }),
    {
      name: 'musicPlayer_ui',
      version: 1,
      migrate: () => undefined,
      partialize: (state) => ({
        immersiveControlsPinned: state.immersiveControlsPinned,
        immersiveAmbientEnabled: state.immersiveAmbientEnabled,
        immersiveAmbientIntensity: state.immersiveAmbientIntensity,
        compactPlayerPlacement: state.compactPlayerPlacement,
        assistantEnableThinking: state.assistantEnableThinking ?? state.xiaoaEnableThinking,
        xiaoaEnableThinking: state.assistantEnableThinking ?? state.xiaoaEnableThinking,
      }),
      merge: mergePersistedUISettings,
    }
  )
);

let toastTimer = null;
export const showToast = (msg, duration = 3000) => {
    useUIStore.getState().setToastMessage(msg);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        useUIStore.getState().setToastMessage('');
    }, duration);
};
