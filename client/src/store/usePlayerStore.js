import { createQueueContinuationRegistry } from './queueContinuation.js';
import { t } from '../i18n/index.js';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useUIStore, showToast } from './useUIStore.js';
import { isPlayableSong } from '../utils.js';
import { planInsertNext, reorderQueue, sanitizePlayableQueue } from './playerQueue.js';
import { isPlaybackMode, PLAYBACK_MODE_NAMES, PLAYBACK_MODES } from '../constants/playbackModes.js';
import { throttledLocalStorage } from './throttledStorage.js';
import { createPlayerPersistenceStorage } from './playerPersistence.js';

export const usePlayerStore = create(
  persist(
    (set, get) => {
      // 通用 setter 工厂：支持直接值或函数式更新
      const makeSetter = (key) => (val) =>
        set({ [key]: typeof val === 'function' ? val(get()[key]) : val });

      // 歌曲切换只更新状态，由 React 的 <audio src={...}> 负责加载。
      // Store 再写一次 audio.src 会与 React 提交产生竞态并中断首次 play()。
      const selectSongForPlayback = (song, extraState = {}, options = {}) => {
          if (!isPlayableSong(song)) return false;
          const { currentSong, audioRef, playlist: curPlaylist } = get();
          const isSameResource = currentSong?.id === song.id
              && currentSong?.audio_url === song.audio_url;
          const reusesCurrentUrl = currentSong?.audio_url
              && currentSong.audio_url === song.audio_url;
          const forceReload = options.forceReload || Boolean(audioRef?.current?.error);
          const lyricsResetState = currentSong?.id === song.id
              ? {}
              : {
                  lyrics: [],
                  lyricsStatus: 'loading',
                  currentLyricIndex: 0,
                  translationAvailable: false,
                  translationState: 'unavailable',
                  translationStartedAt: null,
                  resolvedLyricSource: null,
                  lyricFormat: 'none',
                  lyricSyncMode: 'none',
                  lyricOffsetMs: 0,
              };

          let computedDirection = extraState.switchDirection;
          if (!computedDirection) {
              const effectivePlaylist = extraState.playlist || curPlaylist;
              const oldIdx = effectivePlaylist.findIndex(s => s.id === currentSong?.id);
              const newIdx = effectivePlaylist.findIndex(s => s.id === song?.id);
              computedDirection = (oldIdx >= 0 && newIdx >= 0 && newIdx < oldIdx) ? 'prev' : 'next';
          }

          set({
              switchDirection: computedDirection || 'next',
              ...extraState,
              ...lyricsResetState,
              currentSong: song,
              playbackOwnershipGeneration: get().playbackOwnershipGeneration + 1,
              isPlaying: true,
              shouldAutoPlay: forceReload || !isSameResource,
          });

          if (audioRef?.current && reusesCurrentUrl) {
              audioRef.current.currentTime = 0;
          }

          if (forceReload && isSameResource && audioRef?.current) {
              audioRef.current.load();
          } else if (isSameResource && audioRef?.current) {
              get().tryPlay();
          }
          return true;
      };

      const continuation = createQueueContinuationRegistry();
      let playbackAttempt = 0, cancelledAttempt = 0;
      const revokePendingPlayback = () => { cancelledAttempt = ++playbackAttempt; };
      let snapshotRevision = 0, lastQueue = null, lastSong = null, lastMode = null, lastReady = null, lastOwner = null;
      const contextOwner = () => {
          const session = useUIStore.getState().authSession;
          return session?.authenticated ? JSON.stringify([session.user?.accountId, session.user?.role, session.csrfToken]) : '';
      };
      const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
      const queueSnapshot = () => {
          const state = get();
          const owner = contextOwner();
          const ready = state.queueContextReady === true && !!owner && state.queueContextOwner === owner;
          if (state.playlist !== lastQueue || state.currentSong !== lastSong || state.playMode !== lastMode
              || ready !== lastReady || owner !== lastOwner) {
              snapshotRevision++; lastQueue = state.playlist; lastSong = state.currentSong;
              lastMode = state.playMode; lastReady = ready; lastOwner = owner;
          }
          return { currentSong: copy(state.currentSong), queue: state.playlist.map(copy),
              isPlaying: state.isPlaying, playMode: state.playMode, revision: snapshotRevision,
              ready, waitingForContinuation: continuation.isWaiting() };
      };
      const notify = event => continuation.notify(event, queueSnapshot());

      return {
      // Runtime-only ownership. A restored/new playback may reuse the same
      // cached song and audio URL; retired plugin cleanup must distinguish it.
      playbackOwnershipGeneration: 0,
      queueContextReady: false,
      queueContextOwner: null,
      setQueueContextReady: value => {
          const ready = value === true;
          const owner = ready ? contextOwner() : null;
          if (!ready) continuation.consumed();
          if (get().queueContextReady !== ready || get().queueContextOwner !== owner) snapshotRevision++;
          set({ queueContextReady: ready, queueContextOwner: owner,
              ...(ready && (!get().queueContextReady || get().queueContextOwner !== owner)
                  ? { playbackOwnershipGeneration: get().playbackOwnershipGeneration + 1 } : {}) });
      },
      getQueueSnapshot: queueSnapshot,
      registerQueueContinuation: (callbacks, isCurrent) => continuation.register(callbacks, isCurrent),
      setQueueSequence: () => { set({ playMode: 'sequence' }); continuation.prepare(); },
      trimQueueAfterCurrent: () => {
          const { playlist, currentSong } = get();
          const index = playlist.findIndex(song => String(song.id) === String(currentSong?.id));
          if (index >= 0) set({ playlist: playlist.slice(0, index + 1) });
          return queueSnapshot();
      },
      startQueueContinuation: songs => {
          const playlist = sanitizePlayableQueue(songs);
          if (!playlist.length) return false;
          continuation.prepare();
          return selectSongForPlayback(playlist[0], { playlist, playMode: 'sequence' });
      },
      appendQueueContinuation: (songs, options = {}) => {
          const snapshot = queueSnapshot();
          const actualId = snapshot.currentSong?.id == null ? null : String(snapshot.currentSong.id);
          const expectedId = options.expectedCurrentSongId == null ? null : String(options.expectedCurrentSongId);
          if ((Object.hasOwn(options, 'expectedCurrentSongId') && actualId !== expectedId)
              || (options.expectedRevision !== undefined && snapshot.revision !== options.expectedRevision)) {
              return { added: [], snapshot, stale: true };
          }
          const { playlist, currentSong } = get();
          const currentIndex = playlist.findIndex(song => String(song.id) === actualId);
          const boundary = currentIndex >= 0 ? currentIndex : continuation.isWaiting() ? playlist.length : 0;
          const played = playlist.slice(0, boundary), queued = playlist.slice(boundary);
          const occupied = new Set((options.relocatePlayedDuplicates ? queued : playlist).map(song => String(song.id)));
          const added = sanitizePlayableQueue(songs).filter(song => {
              const id = String(song.id); if (occupied.has(id)) return false;
              occupied.add(id); return true;
          });
          const renewed = new Set(added.map(song => String(song.id)));
          const next = options.relocatePlayedDuplicates
              ? [...played.filter(song => !renewed.has(String(song.id))), ...queued, ...added]
              : [...playlist, ...added];
          const shouldResume = options.resume === true && continuation.canResume();
          if (added.length) {
              const waiting = continuation.isWaiting();
              continuation.consumed();
              if (shouldResume) selectSongForPlayback(added[0], { playlist: next });
              else if (waiting && !currentSong) set({ playlist: next, currentSong: added[0], isPlaying: false, shouldAutoPlay: false });
              else set({ playlist: next });
          }
          return { added: added.map(copy), snapshot: queueSnapshot() };
      },
      legacyPluginPreferences: {},
      getLegacyPluginPreferences: pluginId => copy(get().legacyPluginPreferences?.[pluginId]) || {},
      currentSong: null,
      switchDirection: 'next',
      setCurrentSong: (song) => {
          if (song && !isPlayableSong(song)) return false;
          const prev = get().currentSong;
          if (song && (!prev || prev.id !== song.id)) {
              set({
                  currentSong: song,
                  isLyricsLoading: true,
                  translationAvailable: false,
                  translationState: 'unavailable',
                  translationStartedAt: null,
                  resolvedLyricSource: null,
                  lyricFormat: 'none',
                  lyricSyncMode: 'none',
                  lyricOffsetMs: 0,
              });
          } else {
              set({ currentSong: song });
          }
          return true;
      },
      patchSongMetadata: (songId, patch) => {
          if (!songId || !patch) return;
          const { currentSong, playlist } = get();
          const patchItem = (s) => (s && s.id === songId ? { ...s, ...patch } : s);
          set({
              currentSong: patchItem(currentSong),
              playlist: Array.isArray(playlist) ? playlist.map(patchItem) : playlist,
          });
      },

      playlist: [],
      setPlaylist: (value) => {
          const nextPlaylist = sanitizePlayableQueue(typeof value === 'function' ? value(get().playlist) : value);
          set({ playlist: nextPlaylist });
          notify(nextPlaylist.length ? 'onExplicitPlay' : 'onQueueCleared');
      },
      reorderPlaylist: (fromIndex, toIndex) => {
          const { playlist } = get();
          const nextPlaylist = reorderQueue(playlist, fromIndex, toIndex);
          if (nextPlaylist === playlist) return false;
          set({ playlist: nextPlaylist });
          return true;
      },
      clearPlaylist: () => {
          const { audioRef } = get();
          if (audioRef?.current) {
              audioRef.current.pause();
              audioRef.current.src = '';
          }
          set({
              playlist: [],
              currentSong: null,
              isPlaying: false,
              progress: 0,
              shouldAutoPlay: false,
              lyrics: [],
              lyricsStatus: 'idle',
              currentLyricIndex: 0,
              translationAvailable: false,
              translationState: 'unavailable',
              translationStartedAt: null,
              resolvedLyricSource: null,
              lyricFormat: 'none',
              lyricSyncMode: 'none',
              lyricOffsetMs: 0,
          });
          notify('onQueueCleared');
      },

      removePlaylistSong: (target) => {
          const { playlist, currentSong } = get();
          let index = -1;
          if (Number.isInteger(target)) {
              index = target;
          } else if (typeof target === 'string' || typeof target === 'number') {
              index = playlist.findIndex((song) => String(song?.id) === String(target));
          } else if (target && typeof target === 'object' && target.id != null) {
              index = playlist.findIndex((song) => String(song?.id) === String(target.id));
          }
          if (index < 0 || index >= playlist.length) return false;
          const removedSong = playlist[index];
          const nextPlaylist = playlist.filter((_, itemIndex) => itemIndex !== index);
          if (nextPlaylist.length === 0) {
              set({ playlist: [], currentSong: null, isPlaying: false, shouldAutoPlay: false, progress: 0 });
              notify('onQueueCleared');
              return true;
          }
          if (String(removedSong?.id) !== String(currentSong?.id)) {
              set({ playlist: nextPlaylist });
              return true;
          }

          // 优先选择原队列中的下一首；删除队尾时不能倒退重播本轮已听歌曲。
          const nextSong = index < nextPlaylist.length ? nextPlaylist[index] : null;
          if (nextSong) return selectSongForPlayback(nextSong, { playlist: nextPlaylist });

          // A provider can continue a deleted current tail without replaying
          // an already played item. An unrelated queue retains old semantics.
          set({ playlist: nextPlaylist, currentSong: null, isPlaying: false, shouldAutoPlay: false, progress: 0 });
          const accepted = notify('onQueueEnd');
          if (!accepted) return selectSongForPlayback(nextPlaylist[nextPlaylist.length - 1], { playlist: nextPlaylist });
          return true;
      },

      isPlaying: false,
      setIsPlaying: makeSetter('isPlaying'),

      isBuffering: false,
      setIsBuffering: makeSetter('isBuffering'),

      progress: 0,
      currentTime: 0,
      setProgress: (val) => {
          const next = typeof val === 'function' ? val(get().progress) : val;
          set({ progress: next, currentTime: next });
      },

      duration: 0,
      setDuration: makeSetter('duration'),

      volume: 0.8,
      setVolume: makeSetter('volume'),

      playMode: 'loop',

      lyrics: [],
      setLyrics: makeSetter('lyrics'),

      lyricsStatus: 'idle',
      setLyricsStatus: makeSetter('lyricsStatus'),

      resolvedLyricSource: null,
      setResolvedLyricSource: makeSetter('resolvedLyricSource'),

      lyricFormat: 'none',
      setLyricFormat: makeSetter('lyricFormat'),

      lyricSyncMode: 'none',
      setLyricSyncMode: makeSetter('lyricSyncMode'),

      lyricOffsetMs: 0,
      setLyricOffsetMs: makeSetter('lyricOffsetMs'),
      setLyricsDocumentSnapshot: (snapshot) => set({
          lyrics: Array.isArray(snapshot.lyrics) ? snapshot.lyrics : [],
          lyricsStatus: snapshot.status,
          resolvedLyricSource: snapshot.source,
          lyricFormat: snapshot.format,
          lyricSyncMode: snapshot.syncMode,
          lyricOffsetMs: Number.isInteger(snapshot.offsetMs) ? snapshot.offsetMs : 0,
          translationAvailable: Boolean(snapshot.translationAvailable),
          translationState: ['unavailable', 'missing', 'pending', 'ready', 'failed'].includes(snapshot.translationState)
              ? snapshot.translationState
              : 'unavailable',
          translationStartedAt: Number.isFinite(Date.parse(snapshot.translationStartedAt))
              ? new Date(snapshot.translationStartedAt).toISOString()
              : null,
      }),

      lyricsRefreshRevision: 0,
      requestLyricsRefresh: (songId) => {
          const { currentSong, lyricsRefreshRevision } = get();
          if (songId === undefined || songId === null
              || String(currentSong?.id) !== String(songId)) return false;
          set({
              lyricsRefreshRevision: Number.isSafeInteger(lyricsRefreshRevision)
                  && lyricsRefreshRevision < Number.MAX_SAFE_INTEGER
                  ? lyricsRefreshRevision + 1
                  : 1,
              translationAvailable: false,
              translationState: 'unavailable',
              translationStartedAt: null,
          });
          return true;
      },

      currentLyricIndex: 0,
      setCurrentLyricIndex: makeSetter('currentLyricIndex'),

      translationAvailable: false,
      setTranslationAvailable: makeSetter('translationAvailable'),

      translationState: 'unavailable',
      setTranslationState: makeSetter('translationState'),

      translationStartedAt: null,
      setTranslationStartedAt: makeSetter('translationStartedAt'),
      setTranslationSnapshot: ({ available, state, startedAt }) => set({
          translationAvailable: Boolean(available),
          translationState: ['unavailable', 'missing', 'pending', 'ready', 'failed'].includes(state)
              ? state
              : 'unavailable',
          translationStartedAt: Number.isFinite(Date.parse(startedAt))
              ? new Date(startedAt).toISOString()
              : null,
      }),

      translationEnabled: false,
      setTranslationEnabled: makeSetter('translationEnabled'),

      isLyricsLoading: false,
      setIsLyricsLoading: makeSetter('isLyricsLoading'),

      audioRef: null,
      setAudioRef: makeSetter('audioRef'),

      shouldAutoPlay: false,
      setShouldAutoPlay: makeSetter('shouldAutoPlay'),

      tryPlay: () => {
          const { audioRef, progress, currentSong, playbackOwnershipGeneration } = get();
          const audio = audioRef?.current;
          if (!audio) return;
          const attempt = ++playbackAttempt, src = audio.src;
          const samePlayback = () => {
              const state = get();
              return state.audioRef?.current === audio && state.currentSong === currentSong
                  && audio.src === src && state.playbackOwnershipGeneration === playbackOwnershipGeneration;
          };
          if (progress > 0 && Math.abs(audio.currentTime - progress) > 0.5 && (!audio.duration || progress < audio.duration - 5)) {
              try {
                  audio.currentTime = progress;
              } catch (e) {
                  // ignore if audio element not ready to seek yet
              }
          }
          audio.play().then(() => {
              if (attempt === playbackAttempt && samePlayback()) set({ isPlaying: true });
              else if (attempt <= cancelledAttempt && playbackAttempt === cancelledAttempt && samePlayback()) audio.pause();
          }).catch(e => {
              if (attempt !== playbackAttempt || !samePlayback()) return;
              console.error("Play error:", e);
              set({ isPlaying: false });
              showToast(t("准备就绪，请点击播放键开始播放"));
          });
      },

      togglePlay: (e) => {
          e?.stopPropagation && e.stopPropagation();
          const { currentSong, playlist, audioRef, tryPlay } = get();
          const audio = audioRef?.current;
          if (!currentSong && playlist.length > 0) {
              set({ currentSong: playlist[0], isPlaying: true, shouldAutoPlay: true });
          } else if (currentSong && audio) {
              if (audio.paused) {
                  set({ isPlaying: true });
                  tryPlay();
              } else {
                  notify('onPause');
                  audio.pause();
                  set({ isPlaying: false });
              }
          }
      },

      play: () => {
          const { audioRef, tryPlay } = get();
          const audio = audioRef?.current;
          if (audio && audio.paused) {
              set({ isPlaying: true });
              tryPlay();
          } else if (!get().isPlaying) {
              get().togglePlay();
          }
      },

      pause: () => {
          revokePendingPlayback();
          notify('onPause');
          const { audioRef } = get();
          const audio = audioRef?.current;
          if (audio && !audio.paused) audio.pause();
          set({ isPlaying: false, shouldAutoPlay: false });
      },

      // A user pause revokes pending autoplay even while audio is already
      // stopped at queue end; late provider results may append but not resume.
      cancelPendingPlayback: () => {
          revokePendingPlayback();
          notify('onPause');
          set({ isPlaying: false, shouldAutoPlay: false });
      },

      toggleTranslation: () => {
          set({ translationEnabled: !get().translationEnabled });
      },

      playSong: (song, list) => {
          if (!isPlayableSong(song)) return false;
          const playableList = Array.isArray(list) ? sanitizePlayableQueue(list) : null;
          notify('onExplicitPlay');
          return selectSongForPlayback(song, playableList ? { playlist: playableList } : {});
      },

      insertAndPlay: (song, e = null) => {
          e?.stopPropagation && e.stopPropagation();
          const { playlist, currentSong } = get();
          const insertion = planInsertNext(playlist, currentSong, song);

          if (insertion.action === 'play') {
              notify('onExplicitPlay');
              return selectSongForPlayback(song, { playlist: insertion.playlist });
          }
          if (insertion.action !== 'queue') {
              return false;
          }

          // 仅更新播放队列，绝对不改变 currentSong 和当前的播放状态
          set({ playlist: insertion.playlist });
          return true;
      },

      handleModeChange: (mode = null) => {
          const { playMode } = get();
          let nextMode;
          if (isPlaybackMode(mode)) {
              nextMode = mode;
          } else {
              const nextIndex = (PLAYBACK_MODES.indexOf(playMode) + 1) % PLAYBACK_MODES.length;
              nextMode = PLAYBACK_MODES[nextIndex];
          }
          set({ playMode: nextMode });
          notify('onModeChange');
          const modeName = PLAYBACK_MODE_NAMES[nextMode];
          showToast(t("已切换为：{p0}", { p0: (modeName) }));
      },

      playNext: (e = null) => {
          e?.stopPropagation && e.stopPropagation();
          const { playlist, playMode, currentSong, audioRef } = get();
          if (!playlist.length) return;

          const applyNext = (song) => selectSongForPlayback(
              song,
              { switchDirection: 'next' },
              { forceReload: e?.type === 'error' }
          );
          const isAutoAdvance = e?.type === 'ended';
          if (isAutoAdvance && playMode === 'single') {
              if (audioRef?.current) {
                  audioRef.current.currentTime = 0;
                  get().tryPlay();
                  set({ shouldAutoPlay: false });
              }
              return;
          }

          const currentIndex = playlist.findIndex(s => s.id === currentSong?.id);

          if (playMode === 'random' && playlist.length > 1) {
              let nextIdx = currentIndex;
              while(nextIdx === currentIndex) {
                  nextIdx = Math.floor(Math.random() * playlist.length);
              }
              applyNext(playlist[nextIdx]);
              return;
          }

          if (currentIndex >= 0 && currentIndex < playlist.length - 1) {
              applyNext(playlist[currentIndex + 1]);
          } else {
              if (playMode === 'sequence' && notify('onQueueEnd')) {
                  set({ isPlaying: false, progress: 0, shouldAutoPlay: false });
                  if (audioRef?.current) audioRef.current.currentTime = 0;
                  return;
              }
              if (playMode === 'loop' || playMode === 'random') {
                  applyNext(playlist[0]);
              } else {
                  if (isAutoAdvance) {
                      set({ isPlaying: false, progress: 0 });
                      if (audioRef?.current) audioRef.current.currentTime = 0;
                  } else {
                      applyNext(playlist[0]);
                  }
              }
          }
      },

      playPrev: (e) => {
          e?.stopPropagation && e.stopPropagation();
          const { playlist, playMode, currentSong, audioRef } = get();
          if (!playlist.length) return;

          const applyNext = (song) => selectSongForPlayback(song, { switchDirection: 'prev' });
          if (playMode === 'random' && playlist.length > 1) {
              const currentIndex = playlist.findIndex(s => s.id === currentSong?.id);
              let nextIdx = currentIndex;
              while (nextIdx === currentIndex) {
                  nextIdx = Math.floor(Math.random() * playlist.length);
              }
              applyNext(playlist[nextIdx]);
              return;
          }

          const currentIndex = playlist.findIndex(s => s.id === currentSong?.id);
          if (currentIndex > 0) {
              applyNext(playlist[currentIndex - 1]);
          } else {
              if (audioRef?.current) {
                  audioRef.current.currentTime = 0;
                  get().tryPlay();
              }
              set({ progress: 0, isPlaying: true, shouldAutoPlay: false });
          }
      },

      nextTrack: (e = null) => get().playNext(e),
      prevTrack: (e = null) => get().playPrev(e),
    };
    },
    {
      name: 'musicPlayer_player',
      version: 1,
      migrate: () => undefined,
      storage: createPlayerPersistenceStorage(() => throttledLocalStorage),
      partialize: (state) => ({
        currentSong: state.currentSong,
        playlist: state.playlist,
        volume: state.volume,
        playMode: state.playMode,
        translationEnabled: state.translationEnabled,
        legacyPluginPreferences: state.legacyPluginPreferences,
      }),
      // IndexedDB 保存跨站播放上下文；Local Storage 保存当前播放器偏好与会话恢复数据。
      merge: (persisted, current) => ({
        ...current,
        currentSong: isPlayableSong(persisted?.currentSong)
          ? persisted.currentSong
          : current.currentSong,
        playlist: Array.isArray(persisted?.playlist)
          ? sanitizePlayableQueue(persisted.playlist)
          : current.playlist,
        volume: Number.isFinite(persisted?.volume) ? persisted.volume : current.volume,
        playMode: isPlaybackMode(persisted?.playMode)
          ? persisted.playMode
          : current.playMode,
        translationEnabled: typeof persisted?.translationEnabled === 'boolean'
          ? persisted.translationEnabled
          : current.translationEnabled,
        // One-way migration only: old enabled/request/autoplay state never
        // authorizes a plugin. Its previous language/batch are passive data.
        legacyPluginPreferences: persisted?.legacyPluginPreferences || {
          roam: { language: typeof persisted?.randomRoam?.language === 'string' ? persisted.randomRoam.language : 'all',
            batchSize: Number.isInteger(persisted?.randomRoam?.batchSize) ? persisted.randomRoam.batchSize : 10 },
        },
      }),
    }
  )
);
