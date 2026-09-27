import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  fetchAccountPlayStats,
  submitAccountPlayStats,
} from '../services/accountPlayStats.js';

const SYNC_THRESHOLD = 3;
const MAX_SYNC_BATCH_SIZE = 25;
const TOP_SONG_LIMIT = 50;
const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
let debouncedFlushTimer = null;
let flushPromise = null;
let consecutiveFailures = 0;
let nextAllowedSyncTime = 0;

export function resetSyncBackoff() {
  consecutiveFailures = 0;
  nextAllowedSyncTime = 0;
}

function getLocalStorage() {
  if (!globalThis.localStorage) throw new Error('localStorage is unavailable');
  return globalThis.localStorage;
}

function createEventId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `play_${globalThis.crypto.randomUUID().replaceAll('-', '_')}`;
  }
  return `play_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function cleanSongMeta(songId, song, playedAt = Date.now()) {
  return {
    id: songId,
    title: song?.title || '未知曲目',
    artist: song?.artist || '未知艺术家',
    album: song?.album || '',
    cover_url: song?.cover_url || '',
    audio_url: song?.audio_url || '',
    duration: Number(song?.duration) || 0,
    last_played_at: Number(song?.last_played_at) || playedAt,
    language: song?.language || null,
  };
}

function buildTopSongs(playCounts, songMetaMap, remoteSongs = []) {
  const songsById = new Map();
  for (const song of remoteSongs) {
    const id = String(song?.id || '').trim();
    if (!id) continue;
    songsById.set(id, cleanSongMeta(id, song, song.last_played_at));
  }
  for (const [id, song] of Object.entries(songMetaMap)) {
    const existing = songsById.get(id) || {};
    const merged = cleanSongMeta(id, { ...existing, ...song }, song?.last_played_at || existing.last_played_at);
    if (!merged.language && existing.language) {
      merged.language = existing.language;
    }
    songsById.set(id, { ...existing, ...merged });
  }

  return Object.entries(playCounts)
    .filter(([, count]) => Number(count) > 0)
    .map(([id, count]) => ({
      ...(songsById.get(id) || cleanSongMeta(id, null)),
      id,
      play_count: Number(count) || 0,
    }))
    .sort((a, b) => (
      b.play_count - a.play_count
      || Number(b.last_played_at || 0) - Number(a.last_played_at || 0)
      || a.id.localeCompare(b.id)
    ))
    .slice(0, TOP_SONG_LIMIT);
}

function emptyIdentityState(ownerSubject = null, identityReady = false) {
  return {
    ownerSubject,
    identityReady,
    playCounts: {},
    pendingQueue: [],
    songMetaMap: {},
    topSongs: [],
    topAlbums: [],
    totalPlays: 0,
    totalUniqueSongs: 0,
    isSyncing: false,
    lastSyncedAt: 0,
  };
}

function applyPendingEvents(state, events, eventMetaMap) {
  if (!events.length) return state;
  const playCounts = { ...state.playCounts };
  const songMetaMap = { ...state.songMetaMap };
  let totalPlays = state.totalPlays;
  let totalUniqueSongs = state.totalUniqueSongs;

  for (const event of events) {
    const songId = event.song_id;
    const currentCount = playCounts[songId] || 0;
    playCounts[songId] = currentCount + 1;
    songMetaMap[songId] = cleanSongMeta(
      songId,
      eventMetaMap[songId] || songMetaMap[songId],
      event.played_at,
    );
    totalPlays += 1;
    if (currentCount === 0) totalUniqueSongs += 1;
  }

  return {
    ...state,
    playCounts,
    pendingQueue: [...state.pendingQueue, ...events],
    songMetaMap,
    topSongs: buildTopSongs(playCounts, songMetaMap, state.topSongs),
    totalPlays,
    totalUniqueSongs,
  };
}

function rebuildFromRemote(data, state) {
  const playCounts = {};
  const songMetaMap = {};
  for (const song of data.songs || []) {
    const id = String(song?.id || '').trim();
    if (!id) continue;
    playCounts[id] = Number(song.play_count) || 0;
    songMetaMap[id] = cleanSongMeta(id, song, song.last_played_at);
  }

  const remoteState = {
    ...state,
    playCounts,
    songMetaMap,
    topSongs: buildTopSongs(playCounts, songMetaMap, data.songs || []),
    topAlbums: Array.isArray(data.topAlbums) ? data.topAlbums : [],
    totalPlays: Number(data.totalPlays) || 0,
    totalUniqueSongs: Number(data.totalUniqueSongs) || 0,
    pendingQueue: [],
  };
  return applyPendingEvents(remoteState, state.pendingQueue, state.songMetaMap);
}

function scheduleDebouncedFlush() {
  if (debouncedFlushTimer) clearTimeout(debouncedFlushTimer);
  debouncedFlushTimer = setTimeout(() => {
    debouncedFlushTimer = null;
    const store = usePlayStatsStore.getState();
    if (store.identityReady && store.ownerSubject && store.pendingQueue.length > 0) {
      void store.flushQueue();
    }
  }, 8000);
}

export const usePlayStatsStore = create(
  persist(
    (set, get) => ({
      ...emptyIdentityState(),

      getPlayCount: (songId) => {
        if (!songId) return 0;
        return get().playCounts[String(songId)] || 0;
      },

      patchSongMetadata: (songsInput) => {
        if (!songsInput) return;
        const list = Array.isArray(songsInput)
          ? songsInput
          : typeof songsInput === 'object'
            ? Object.values(songsInput)
            : [];
        if (list.length === 0) return;

        set((state) => {
          let hasChange = false;
          const nextMetaMap = { ...state.songMetaMap };
          for (const item of list) {
            const id = String(item?.id || '').trim();
            if (!id) continue;
            const existing = nextMetaMap[id] || {};
            if (item.language && existing.language !== item.language) {
              nextMetaMap[id] = cleanSongMeta(id, { ...existing, ...item }, existing.last_played_at);
              hasChange = true;
            }
          }
          if (!hasChange) return {};
          return {
            songMetaMap: nextMetaMap,
            topSongs: buildTopSongs(state.playCounts, nextMetaMap, state.topSongs),
          };
        });
      },

      markIdentityUnconfirmed: () => {
        if (debouncedFlushTimer) {
          clearTimeout(debouncedFlushTimer);
          debouncedFlushTimer = null;
        }
        set({ identityReady: false, isSyncing: false });
      },

      setSubject: (subjectInput) => {
        const nextSubject = subjectInput ? String(subjectInput).trim() : null;
        const state = get();
        let nextState;

        if (nextSubject && state.ownerSubject === nextSubject) {
          nextState = { ...state, identityReady: true };
        } else {
          resetSyncBackoff();
          nextState = emptyIdentityState(nextSubject, true);
        }

        set(nextState);
        return {
          changed: state.ownerSubject !== nextSubject,
        };
      },

      recordQualifiedPlay: (songOrId, songMeta = null) => {
        let cleanId = '';
        let meta = null;
        if (songOrId && typeof songOrId === 'object') {
          cleanId = String(songOrId.id || '').trim();
          meta = songOrId;
        } else {
          cleanId = String(songOrId || '').trim();
          meta = songMeta;
        }
        if (!cleanId) return;

        const now = Date.now();
        const event = { event_id: createEventId(), song_id: cleanId, played_at: now };
        set((state) => {
          if (!state.identityReady || !state.ownerSubject) return {};
          const currentCount = state.playCounts[cleanId] || 0;
          const nextCounts = { ...state.playCounts, [cleanId]: currentCount + 1 };
          const nextMetaMap = {
            ...state.songMetaMap,
            [cleanId]: cleanSongMeta(cleanId, meta || state.songMetaMap[cleanId], now),
          };
          return {
            playCounts: nextCounts,
            pendingQueue: [
              ...state.pendingQueue,
              event,
            ],
            songMetaMap: nextMetaMap,
            topSongs: buildTopSongs(nextCounts, nextMetaMap, state.topSongs),
            totalPlays: state.totalPlays + 1,
            totalUniqueSongs: state.totalUniqueSongs + (currentCount > 0 ? 0 : 1),
          };
        });

        if (!get().identityReady || !get().ownerSubject) return;
        if (get().pendingQueue.length >= SYNC_THRESHOLD) {
          if (debouncedFlushTimer) {
            clearTimeout(debouncedFlushTimer);
            debouncedFlushTimer = null;
          }
          void get().flushQueue();
        } else {
          scheduleDebouncedFlush();
        }
      },

      flushQueue: ({ keepalive = false, force = false } = {}) => {
        if (flushPromise) return flushPromise;

        const now = Date.now();
        if (!force && now < nextAllowedSyncTime) {
          return Promise.resolve({
            ok: false,
            submitted: 0,
            remaining: get().pendingQueue.length,
            reason: 'cooling-down',
            retryAfterMs: nextAllowedSyncTime - now,
          });
        }

        flushPromise = (async () => {
          const initial = get();
          if (!initial.identityReady) {
            return { ok: false, submitted: 0, remaining: initial.pendingQueue.length, reason: 'identity-unconfirmed' };
          }
          if (!initial.ownerSubject || initial.pendingQueue.length === 0) {
            return { ok: true, submitted: 0, remaining: initial.pendingQueue.length };
          }

          const syncSubject = initial.ownerSubject;
          let submitted = 0;
          set({ isSyncing: true });

          try {
            do {
              const current = get();
              if (!current.identityReady || current.ownerSubject !== syncSubject) {
                return { ok: false, submitted, remaining: current.pendingQueue.length, reason: 'identity-changed' };
              }

              const snapshot = current.pendingQueue.slice(0, MAX_SYNC_BATCH_SIZE);
              if (snapshot.length === 0) break;
              const response = await submitAccountPlayStats(snapshot, {
                keepalive,
                expectedSubject: syncSubject,
              });
              const acceptedIds = new Set(Array.isArray(response?.acceptedEventIds) ? response.acceptedEventIds : []);
              if (!snapshot.every((event) => acceptedIds.has(event.event_id))) {
                throw new Error('播放统计服务未确认完整事件批次。');
              }

              set((state) => {
                if (state.ownerSubject !== syncSubject) return {};
                return {
                  pendingQueue: state.pendingQueue.filter((event) => !acceptedIds.has(event.event_id)),
                  lastSyncedAt: Date.now(),
                };
              });
              submitted += snapshot.length;
              if (keepalive) break;
            } while (get().pendingQueue.length > 0);

            // 成功提交：重置失败计数与退避时间
            consecutiveFailures = 0;
            nextAllowedSyncTime = 0;

            return { ok: true, submitted, remaining: get().pendingQueue.length };
          } catch (error) {
            consecutiveFailures += 1;
            const delay = Math.min(
              INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1),
              MAX_BACKOFF_MS,
            );
            nextAllowedSyncTime = Date.now() + delay;
            console.warn(`播放统计后台同步失败，将在 ${Math.round(delay / 1000)} 秒后重试:`, error);
            return { ok: false, submitted, remaining: get().pendingQueue.length, error, retryAfterMs: delay };
          } finally {
            const current = get();
            if (current.ownerSubject === syncSubject) {
              set({ isSyncing: false });
            }
          }
        })();

        flushPromise.finally(() => {
          flushPromise = null;
        });
        return flushPromise;
      },

      refreshRemoteStats: async (limit = 20) => {
        const initial = get();
        const syncSubject = initial.ownerSubject;
        if (!initial.identityReady) return { ok: false, reason: 'identity-unconfirmed' };
        if (!syncSubject) return { ok: false, reason: 'unauthenticated' };

        try {
          const data = await fetchAccountPlayStats({ limit, expectedSubject: syncSubject });
          if (!data) throw new Error('播放统计服务未返回数据。');
          if (!get().identityReady || get().ownerSubject !== syncSubject) {
            return { ok: false, reason: 'identity-changed' };
          }

          set((state) => {
            if (state.ownerSubject !== syncSubject) return {};
            return rebuildFromRemote(data, state);
          });
          return { ok: true, data };
        } catch (error) {
          console.warn('拉取云端播放统计失败:', error);
          return { ok: false, error };
        }
      },

      synchronizeAccountStats: async (limit = 50, { force = false } = {}) => {
        let flushResult = await get().flushQueue({ force });
        if (!flushResult.ok && flushResult.reason === 'identity-changed' && get().ownerSubject) {
          flushResult = await get().flushQueue({ force });
        }
        if (!flushResult.ok) return { ok: false, stage: 'submit', ...flushResult };
        const refreshResult = await get().refreshRemoteStats(limit);
        if (!refreshResult.ok) return { ok: false, stage: 'refresh', flushResult, ...refreshResult };
        return { ok: true, flushResult, refreshResult };
      },
    }),
    {
      name: 'music-play-stats-v2',
      version: 2,
      storage: createJSONStorage(getLocalStorage),
      partialize: (state) => ({
        ownerSubject: state.ownerSubject,
        playCounts: state.playCounts,
        pendingQueue: state.pendingQueue,
        songMetaMap: state.songMetaMap,
        topSongs: state.topSongs,
        totalPlays: state.totalPlays,
        totalUniqueSongs: state.totalUniqueSongs,
        lastSyncedAt: state.lastSyncedAt,
      }),
    },
  ),
);

if (
  typeof window !== 'undefined'
  && typeof window.addEventListener === 'function'
) {
  const handlePageUnload = () => {
    const store = usePlayStatsStore.getState();
    if (store.identityReady && store.ownerSubject && store.pendingQueue.length > 0) {
      void store.flushQueue({ keepalive: true });
    }
  };

  window.addEventListener('pagehide', handlePageUnload);
  window.addEventListener('beforeunload', handlePageUnload);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') handlePageUnload();
    });
  }
}
