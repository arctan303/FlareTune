import { appendRollingRoam } from '../rollingRoam.js';
import { t } from '../i18n/index.js';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useUIStore, showToast } from './useUIStore.js';
import { isPlayableSong } from '../utils.js';
import { planInsertNext, reorderQueue, sanitizePlayableQueue } from './playerQueue.js';
import {
  createInactiveRandomRoam,
  normalizeRandomRoamSongIds,
  normalizeRandomRoamState,
} from '../randomRoam.js';
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
                  lyricIntro: null,
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

      return {
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
                  lyricIntro: null,
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
          const currentRoam = get().randomRoam;
          const shouldDisableRoam = nextPlaylist.length === 0 && currentRoam.enabled;
          set({
              playlist: nextPlaylist,
              ...(shouldDisableRoam ? {
                  randomRoam: {
                      ...createInactiveRandomRoam(),
                      language: currentRoam?.language || 'all',
                      batchSize: currentRoam?.batchSize || 10,
                  },
              } : {}),
          });
      },
      reorderPlaylist: (fromIndex, toIndex) => {
          const { playlist } = get();
          const nextPlaylist = reorderQueue(playlist, fromIndex, toIndex);
          if (nextPlaylist === playlist) return false;
          set({ playlist: nextPlaylist });
          return true;
      },
      clearPlaylist: () => {
          const { audioRef, randomRoam } = get();
          if (audioRef?.current) {
              audioRef.current.pause();
              audioRef.current.src = '';
          }
          const currentLang = randomRoam?.language || 'all';
          const currentBatchSize = randomRoam?.batchSize || 10;
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
              lyricIntro: null,
              lyricOffsetMs: 0,
              randomRoam: {
                  ...createInactiveRandomRoam(),
                  language: currentLang,
                  batchSize: currentBatchSize,
              },
          });
      },

      randomRoam: createInactiveRandomRoam(),
      setRandomRoamLanguage: (language) => {
          const current = get().randomRoam;
          const nextLang = (language && typeof language === 'string') ? language.trim() : 'all';
          if (current.language === nextLang) return;
          const { playlist, currentSong } = get();
          let nextPlaylist = playlist;
          // 当随机漫游开启时，为了让新偏好立即生效且不打断当前播放：
          // 保留当前正在播放的歌曲及其前序歌曲，清除当前歌曲之后排队的旧偏好歌曲，触发即时预拉取
          if (current.enabled && currentSong && Array.isArray(playlist) && playlist.length > 0) {
              const currentIndex = playlist.findIndex((s) => String(s?.id) === String(currentSong?.id));
              if (currentIndex >= 0) {
                  nextPlaylist = playlist.slice(0, currentIndex + 1);
              }
          }
          set({
              playlist: nextPlaylist,
              randomRoam: {
                  ...current,
                  language: nextLang,
                  saturatedAtSongId: null,
                  seenSongIds: normalizeRandomRoamSongIds(nextPlaylist.map((s) => s.id)),
                  totalPlayable: null,
                  remainingPlayable: null,
                  exhausted: false,
                  error: null,
                  retryNonce: current.retryNonce + 1,
                  status: 'idle',
              },
          });
      },
      startRandomRoam: (songs, options = {}) => {
          const playlist = sanitizePlayableQueue(songs);
          if (!playlist.length) return false;
          const currentRoam = get().randomRoam;
          const language = options?.language || currentRoam?.language || 'all';
          const batchSize = currentRoam?.batchSize || 10;
          const randomRoam = {
              ...createInactiveRandomRoam(),
              enabled: true,
              language,
              batchSize,
              seenSongIds: normalizeRandomRoamSongIds(playlist.map((song) => song.id)),
          };
          return selectSongForPlayback(playlist[0], {
              playlist,
              playMode: 'sequence',
              randomRoam,
          });
      },
      setRandomRoamEnabled: (enabled, options = {}) => {
          const current = get().randomRoam;
          const currentBatchSize = current?.batchSize || 10;
          if (!enabled) {
              set({
                  randomRoam: {
                      ...createInactiveRandomRoam(),
                      language: current?.language || 'all',
                      batchSize: currentBatchSize,
                  },
              });
              return true;
          }
          const { playlist } = get();
          const language = options?.language || current?.language || 'all';
          const isEmpty = !playlist.length;
          set({
              playMode: 'sequence',
              randomRoam: {
                  ...createInactiveRandomRoam(),
                  enabled: true,
                  language,
                  batchSize: currentBatchSize,
                  seenSongIds: normalizeRandomRoamSongIds(playlist.map((song) => song.id)),
                  waitingAtQueueEnd: isEmpty,
                  resumeWhenAppended: isEmpty,
              },
          });
          return true;
      },
      triggerManualRandomRoam: () => {
          const { playlist, randomRoam } = get();
          const currentBatchSize = randomRoam?.batchSize || 10;
          const isEmpty = !playlist.length;
          set({
              playMode: 'sequence',
              randomRoam: {
                  ...randomRoam,
                  enabled: isEmpty ? true : Boolean(randomRoam.enabled),
                  batchSize: currentBatchSize,
                  status: 'idle',
                  error: null,
                  exhausted: false,
                  manualNonce: (randomRoam.manualNonce || 0) + 1,
                  retryNonce: (randomRoam.retryNonce || 0) + 1,
                  waitingAtQueueEnd: isEmpty ? true : randomRoam.waitingAtQueueEnd,
                  resumeWhenAppended: isEmpty ? true : randomRoam.resumeWhenAppended,
              },
          });
          return true;
      },
      setRandomRoamBatchSize: (batchSize) => {
          const parsed = typeof batchSize === 'number' && Number.isInteger(batchSize) && batchSize >= 1
              ? Math.min(batchSize, 50)
              : 10;
          const { randomRoam } = get();
          if (randomRoam.batchSize === parsed) return;
          set({
              randomRoam: {
                  ...randomRoam,
                  batchSize: parsed,
              },
          });
      },
      beginRandomRoamRequest: () => {
          const { randomRoam } = get();
          if (randomRoam.status === 'loading') return false;
          set({ randomRoam: { ...randomRoam, status: 'loading', error: null } });
          return true;
      },
      appendRandomRoamBatch: (songs, batchState = {}) => {
          const { randomRoam, playlist } = get();
          const rolling = batchState.strategy === 'recent'
              ? appendRollingRoam(playlist, get().currentSong, randomRoam, sanitizePlayableQueue(songs)) : null;
          const seenSongIds = normalizeRandomRoamSongIds([
              ...randomRoam.seenSongIds,
              ...playlist.map((song) => song.id),
          ]);
          const seen = new Set(seenSongIds);
          const additions = rolling?.additions || sanitizePlayableQueue(songs).filter((song) => {
              const id = String(song.id);
              if (seen.has(id)) return false;
              seen.add(id);
              seenSongIds.push(id);
              return true;
          });
          const nextPlaylist = rolling?.playlist || [...playlist, ...additions];
          const normalizedTotal = Number.isInteger(batchState.totalPlayable) && batchState.totalPlayable >= 0
              ? batchState.totalPlayable
              : randomRoam.totalPlayable;
          const normalizedRemaining = Number.isInteger(batchState.remainingPlayable) && batchState.remainingPlayable >= 0
              ? batchState.remainingPlayable
              : randomRoam.remainingPlayable;
          const exhausted = batchState.exhausted === true;
          const nextRandomRoam = {
              ...randomRoam,
              seenSongIds: normalizeRandomRoamSongIds(seenSongIds),
              ...(rolling ? { recentSongIds: rolling.recentSongIds, recentWindow: batchState.recentWindow,
                  saturatedAtSongId: normalizedRemaining === 0
                      ? (batchState.requestedForSongId ?? additions[0]?.id ?? null) : null,
                  saturatedQueueKey: nextPlaylist.slice(Math.max(0, nextPlaylist.findIndex(song =>
                      String(song.id) === String(get().currentSong?.id ?? additions[0]?.id))))
                      .map(song => String(song.id)).join(',') } : {}),
              totalPlayable: normalizedTotal,
              remainingPlayable: normalizedRemaining,
              exhausted,
              status: 'idle',
              error: null,
              waitingAtQueueEnd: randomRoam.waitingAtQueueEnd && additions.length === 0,
              resumeWhenAppended: randomRoam.resumeWhenAppended && additions.length === 0,
          };

          if (randomRoam.waitingAtQueueEnd && randomRoam.resumeWhenAppended && additions.length > 0) {
              return selectSongForPlayback(additions[0], {
                  playlist: nextPlaylist,
                  randomRoam: nextRandomRoam,
              });
          }
          if (randomRoam.waitingAtQueueEnd && additions.length > 0 && !get().currentSong) {
              set({
                  playlist: nextPlaylist,
                  currentSong: additions[0],
                  isPlaying: false,
                  shouldAutoPlay: false,
                  randomRoam: nextRandomRoam,
              });
              return true;
          }
          if (randomRoam.waitingAtQueueEnd && additions.length === 0 && exhausted) {
              set({
                  playlist: nextPlaylist,
                  isPlaying: false,
                  shouldAutoPlay: false,
                  randomRoam: {
                      ...nextRandomRoam,
                      enabled: false,
                      status: 'exhausted',
                      waitingAtQueueEnd: false,
                      resumeWhenAppended: false,
                  },
              });
              showToast(t("当前范围暂无可补充的歌曲"));
              return true;
          }
          set({ playlist: nextPlaylist, randomRoam: nextRandomRoam });
          return true;
      },
      failRandomRoamRequest: (message) => {
          const { randomRoam } = get();
          if (!randomRoam.enabled) return;
          set({
              randomRoam: {
                  ...randomRoam,
                  status: 'error',
                  error: message || '续播加载失败',
              },
          });
      },
      pauseRandomRoamRequest: () => {
          const { randomRoam } = get();
          if (!randomRoam.enabled || randomRoam.status !== 'loading') return;
          set({ randomRoam: { ...randomRoam, status: 'idle', error: null } });
      },
      retryRandomRoam: () => {
          const { randomRoam } = get();
          if (!randomRoam.enabled) return false;
          set({
              randomRoam: {
                  ...randomRoam,
                  status: 'idle',
                  error: null,
                  retryNonce: randomRoam.retryNonce + 1,
              },
          });
          return true;
      },
      resetRandomRoamHistory: () => {
          const current = get().randomRoam;
          set({
              randomRoam: {
                  ...current,
                  seenSongIds: [],
                  recentSongIds: [],
                  totalPlayable: null,
                  remainingPlayable: null,
                  exhausted: false,
                  error: null,
                  retryNonce: current.retryNonce + 1,
              },
          });
          return true;
      },
      removePlaylistSong: (target) => {
          const { playlist, currentSong, randomRoam } = get();
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
              const currentLang = randomRoam?.language || 'all';
              const currentBatchSize = randomRoam?.batchSize || 10;
              set({
                  playlist: [],
                  currentSong: null,
                  isPlaying: false,
                  shouldAutoPlay: false,
                  progress: 0,
                  randomRoam: {
                      ...createInactiveRandomRoam(),
                      language: currentLang,
                      batchSize: currentBatchSize,
                  },
              });
              return true;
          }
          if (String(removedSong?.id) !== String(currentSong?.id)) {
              set({ playlist: nextPlaylist });
              return true;
          }

          // 优先选择原队列中的下一首；删除队尾时不能倒退重播本轮已听歌曲。
          const nextSong = index < nextPlaylist.length ? nextPlaylist[index] : null;
          if (nextSong) return selectSongForPlayback(nextSong, { playlist: nextPlaylist });

          const shouldContinueRoam = randomRoam.enabled && !randomRoam.exhausted;
          if (!shouldContinueRoam && nextPlaylist.length > 0) {
              return selectSongForPlayback(nextPlaylist[nextPlaylist.length - 1], { playlist: nextPlaylist });
          }
          set({
              playlist: nextPlaylist,
              currentSong: null,
              isPlaying: false,
              shouldAutoPlay: false,
              progress: 0,
              randomRoam: shouldContinueRoam
                  ? {
                      ...randomRoam,
                      waitingAtQueueEnd: true,
                      resumeWhenAppended: true,
                      retryNonce: randomRoam.retryNonce + 1,
                    }
                  : randomRoam,
          });
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

      lyricIntro: null,
      setLyricIntro: makeSetter('lyricIntro'),

      lyricOffsetMs: 0,
      setLyricOffsetMs: makeSetter('lyricOffsetMs'),
      setLyricsDocumentSnapshot: (snapshot) => set({
          lyrics: Array.isArray(snapshot.lyrics) ? snapshot.lyrics : [],
          lyricsStatus: snapshot.status,
          resolvedLyricSource: snapshot.source,
          lyricFormat: snapshot.format,
          lyricSyncMode: snapshot.syncMode,
          lyricIntro: snapshot.intro,
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
          const { audioRef, progress } = get();
          const audio = audioRef?.current;
          if (!audio) return;
          if (progress > 0 && Math.abs(audio.currentTime - progress) > 0.5 && (!audio.duration || progress < audio.duration - 5)) {
              try {
                  audio.currentTime = progress;
              } catch (e) {
                  // ignore if audio element not ready to seek yet
              }
          }
          audio.play().then(() => {
              set({ isPlaying: true });
          }).catch(e => {
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
          const { audioRef } = get();
          const audio = audioRef?.current;
          if (audio && !audio.paused) {
              audio.pause();
              set({ isPlaying: false });
          } else if (get().isPlaying) {
              get().togglePlay();
          }
      },

      toggleTranslation: () => {
          set({ translationEnabled: !get().translationEnabled });
      },

      playSong: (song, list) => {
          const playableList = Array.isArray(list) ? sanitizePlayableQueue(list) : null;
          const currentLang = get().randomRoam?.language || 'all';
          const currentBatchSize = get().randomRoam?.batchSize || 10;
          return selectSongForPlayback(song, playableList ? {
              playlist: playableList,
              randomRoam: { ...createInactiveRandomRoam(), language: currentLang, batchSize: currentBatchSize },
          } : {});
      },

      insertAndPlay: (song, e = null) => {
          e?.stopPropagation && e.stopPropagation();
          const { playlist, currentSong } = get();
          const insertion = planInsertNext(playlist, currentSong, song);

          if (insertion.action === 'play') {
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
          const currentLang = get().randomRoam?.language || 'all';
          const currentBatchSize = get().randomRoam?.batchSize || 10;
          set({
              playMode: nextMode,
              ...(nextMode !== 'sequence' && get().randomRoam.enabled
                  ? { randomRoam: { ...createInactiveRandomRoam(), language: currentLang, batchSize: currentBatchSize } }
                  : {}),
          });
          const modeName = PLAYBACK_MODE_NAMES[nextMode];
          showToast(t("已切换为：{p0}", { p0: (modeName) }));
      },

      playNext: (e = null) => {
          e?.stopPropagation && e.stopPropagation();
          const { playlist, playMode, currentSong, audioRef, randomRoam } = get();
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
              if (randomRoam.enabled && playMode === 'sequence') {
                  if (randomRoam.exhausted) {
                      set({
                          isPlaying: false,
                          progress: 0,
                          randomRoam: {
                              ...randomRoam,
                              enabled: false,
                              status: 'exhausted',
                              waitingAtQueueEnd: false,
                              resumeWhenAppended: false,
                          },
                      });
                      if (audioRef?.current) audioRef.current.currentTime = 0;
                      showToast(t("当前范围暂无可补充的歌曲"));
                      return;
                  }
                  set({
                      isPlaying: false,
                      progress: 0,
                      randomRoam: {
                          ...randomRoam,
                          waitingAtQueueEnd: true,
                          resumeWhenAppended: true,
                          retryNonce: randomRoam.retryNonce + 1,
                      },
                  });
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
        randomRoam: {
          ...state.randomRoam,
          // 浏览器恢复时保留“需要续批”，但绝不保留自动起播授权。
          resumeWhenAppended: false,
        },
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
        randomRoam: normalizeRandomRoamState(persisted?.randomRoam),
      }),
    }
  )
);
