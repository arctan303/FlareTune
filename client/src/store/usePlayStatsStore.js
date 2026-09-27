import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  fetchAccountPlayStats,
  submitAccountPlayStats,
} from '../services/accountPlayStats.js';

const SYNC_INTERVAL_MS = 600_000;
const PENDING_EVENT_PREFIX = 'music-play-stats-pending-v1:';
const MAX_SYNC_BATCH_SIZE = 25;
const TOP_SONG_LIMIT = 50;
const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
let scheduledSyncTimer = null;
let flushPromise = null;
let flushSubject = null;
let syncPromise = null;
let syncSubject = null;
let consecutiveFailures = 0;
let nextAllowedSyncTime = 0;
let nextCycleTime = 0;
let nextRetryTime = 0;
const volatilePending = new Map();

export function resetSyncBackoff() {
  consecutiveFailures = 0;
  nextAllowedSyncTime = 0;
  nextCycleTime = 0;
  nextRetryTime = 0;
  if (scheduledSyncTimer) clearTimeout(scheduledSyncTimer);
  scheduledSyncTimer = null;
}

function getLocalStorage() {
  if (!globalThis.localStorage) throw new Error('localStorage is unavailable');
  return globalThis.localStorage;
}

function pendingStorageKey(subject, eventId) {
  return `${PENDING_EVENT_PREFIX}${encodeURIComponent(subject)}:${encodeURIComponent(eventId)}`;
}

function validPendingEvent(event) {
  const playedAt = Number(event?.played_at);
  return typeof event?.event_id === 'string'
    && event.event_id.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(event.event_id)
    && typeof event.song_id === 'string'
    && event.song_id.length > 0
    && event.song_id.length <= 256
    && Number.isSafeInteger(playedAt)
    && playedAt > 0;
}

function savePendingEvent(subject, event) {
  try {
    getLocalStorage().setItem(pendingStorageKey(subject, event.event_id), JSON.stringify(event));
    return true;
  } catch (error) {
    const pending = volatilePending.get(subject) || new Map();
    pending.set(event.event_id, event);
    volatilePending.set(subject, pending);
    console.warn('播放事件本地持久化失败；本次页面仍会尝试同步:', error);
    return false;
  }
}

function readPendingEvents(subject) {
  if (!subject) return [];
  const events = new Map();
  const storage = getLocalStorage();
  const prefix = `${PENDING_EVENT_PREFIX}${encodeURIComponent(subject)}:`;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try {
      const event = JSON.parse(storage.getItem(key));
      if (validPendingEvent(event) && key === pendingStorageKey(subject, event.event_id)) {
        events.set(event.event_id, event);
      }
    } catch {
      // An invalid key is ignored; it is never sent as another account's event.
    }
  }
  for (const [id, event] of volatilePending.get(subject) || []) events.set(id, event);
  return [...events.values()].sort((a, b) => (
    Number(a.played_at) - Number(b.played_at) || a.event_id.localeCompare(b.event_id)
  ));
}

function removePendingEvents(subject, ids) {
  const volatile = volatilePending.get(subject);
  for (const id of ids) {
    getLocalStorage().removeItem(pendingStorageKey(subject, id));
    volatile?.delete(id);
  }
  if (volatile?.size === 0) volatilePending.delete(subject);
}

function pageIsVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
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
    pendingBySubject: {},
    legacyUnownedPending: [],
    legacyMigrationComplete: true,
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
  const countEntries = new Map();
  const metaEntries = new Map();
  const hasCompleteCounts = data.playCounts && typeof data.playCounts === 'object'
    && !Array.isArray(data.playCounts);
  if (hasCompleteCounts) {
    for (const [id, rawCount] of Object.entries(data.playCounts)) {
      const count = Number(rawCount);
      if (id && Number.isSafeInteger(count) && count > 0) {
        countEntries.set(id, count);
        if (Object.hasOwn(state.songMetaMap, id)) {
          metaEntries.set(id, cleanSongMeta(id, state.songMetaMap[id]));
        }
      }
    }
  }
  for (const song of data.songs || []) {
    const id = String(song?.id || '').trim();
    if (!id) continue;
    if (hasCompleteCounts && !countEntries.has(id)) continue;
    if (!hasCompleteCounts) countEntries.set(id, Number(song.play_count) || 0);
    metaEntries.set(id, cleanSongMeta(id, song, song.last_played_at));
  }
  const playCounts = Object.fromEntries(countEntries);
  const songMetaMap = Object.fromEntries(metaEntries);

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

function scheduleNextSync() {
  if (scheduledSyncTimer) clearTimeout(scheduledSyncTimer);
  scheduledSyncTimer = null;
  const state = usePlayStatsStore.getState();
  if (!state.identityReady || !state.ownerSubject || !pageIsVisible()) return;
  if (!nextCycleTime) nextCycleTime = Date.now() + SYNC_INTERVAL_MS;
  const due = Math.max(
    Math.min(nextCycleTime, nextRetryTime || Infinity),
    nextAllowedSyncTime,
  );
  scheduledSyncTimer = setTimeout(() => {
    scheduledSyncTimer = null;
    const store = usePlayStatsStore.getState();
    if (store.identityReady && store.ownerSubject && pageIsVisible()) {
      void store.synchronizeAccountStats();
    }
  }, Math.max(0, due - Date.now()));
  scheduledSyncTimer.unref?.();
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
        if (scheduledSyncTimer) clearTimeout(scheduledSyncTimer);
        scheduledSyncTimer = null;
        set({ identityReady: false, isSyncing: false });
      },

      migrateLegacyPending: (legacy) => {
        const current = get();
        let saved = true;
        const currentEvents = Array.isArray(legacy.pendingQueue) ? legacy.pendingQueue : [];
        const unownedEvents = Array.isArray(legacy.legacyUnownedPending)
          ? legacy.legacyUnownedPending : [];
        if (unownedEvents.length || (currentEvents.length && !current.ownerSubject)) saved = false;
        if (current.ownerSubject) {
          for (const event of currentEvents) {
            if (validPendingEvent(event)) saved = savePendingEvent(current.ownerSubject, event) && saved;
            else saved = false;
          }
        }
        for (const [subject, events] of Object.entries(legacy.pendingBySubject || {})) {
          if (!subject.trim() || subject.trim() !== subject || !Array.isArray(events)) {
            saved = false;
            continue;
          }
          for (const event of events) {
            if (validPendingEvent(event)) saved = savePendingEvent(subject, event) && saved;
            else saved = false;
          }
        }
        if (!saved) {
          const quarantined = [...unownedEvents];
          if (!current.ownerSubject) {
            for (const event of currentEvents) {
              if (!quarantined.some((item) => JSON.stringify(item) === JSON.stringify(event))) {
                quarantined.push(event);
              }
            }
          }
          set({
            legacyMigrationComplete: false,
            legacyUnownedPending: quarantined,
          });
          return false;
        }
        set({
          pendingQueue: [], pendingBySubject: {}, legacyUnownedPending: [],
          legacyMigrationComplete: true,
        });
        return true;
      },

      reconcilePending: () => {
        const state = get();
        if (!state.identityReady || !state.ownerSubject) return [];
        const stored = readPendingEvents(state.ownerSubject);
        const storedIds = new Set(stored.map((event) => event.event_id));
        const existingIds = new Set(state.pendingQueue.map((event) => event.event_id));
        const added = stored.filter((event) => !existingIds.has(event.event_id));
        if (added.length || state.pendingQueue.some((event) => !storedIds.has(event.event_id))) {
          set((current) => {
            if (current.ownerSubject !== state.ownerSubject) return {};
            const next = applyPendingEvents(current, added, current.songMetaMap);
            return { ...next, pendingQueue: stored };
          });
        }
        return stored;
      },

      setSubject: (subjectInput) => {
        const nextSubject = subjectInput ? String(subjectInput).trim() : null;
        const state = get();
        let nextState;

        if (nextSubject && state.ownerSubject === nextSubject) {
          nextState = {
            ...state,
            identityReady: true,
            // The persisted count already includes this tab's unsent plays.
            pendingQueue: state.identityReady ? state.pendingQueue : readPendingEvents(nextSubject),
          };
        } else {
          resetSyncBackoff();
          nextCycleTime = nextSubject ? Date.now() + SYNC_INTERVAL_MS : 0;
          const restored = nextSubject ? readPendingEvents(nextSubject) : [];
          const legacyPendingBySubject = state.legacyMigrationComplete
            ? {}
            : { ...state.pendingBySubject };
          if (!state.legacyMigrationComplete && state.ownerSubject && state.pendingQueue.length) {
            const existing = legacyPendingBySubject[state.ownerSubject] || [];
            const byId = new Map([...existing, ...state.pendingQueue].map((event) => [event.event_id, event]));
            legacyPendingBySubject[state.ownerSubject] = [...byId.values()];
          }
          nextState = applyPendingEvents(
            {
              ...emptyIdentityState(nextSubject, true),
              pendingBySubject: legacyPendingBySubject,
              legacyUnownedPending: state.legacyUnownedPending,
              legacyMigrationComplete: state.legacyMigrationComplete,
            },
            restored,
            {},
          );
        }

        set(nextState);
        if (nextSubject) get().reconcilePending();
        scheduleNextSync();
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

        const state = get();
        if (!state.identityReady || !state.ownerSubject) return;
        const now = Date.now();
        const event = { event_id: createEventId(), song_id: cleanId, played_at: now };
        const durable = savePendingEvent(state.ownerSubject, event);
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
            legacyMigrationComplete: state.legacyMigrationComplete && durable,
            songMetaMap: nextMetaMap,
            topSongs: buildTopSongs(nextCounts, nextMetaMap, state.topSongs),
            totalPlays: state.totalPlays + 1,
            totalUniqueSongs: state.totalUniqueSongs + (currentCount > 0 ? 0 : 1),
          };
        });

        if (!durable) void get().flushQueue({ force: true });

      },

      flushQueue: ({ keepalive = false, force = false } = {}) => {
        if (flushPromise) {
          if (flushSubject === get().ownerSubject) return flushPromise;
          return flushPromise.then(() => get().flushQueue({ keepalive, force }));
        }

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

        flushSubject = get().ownerSubject;
        if (scheduledSyncTimer) clearTimeout(scheduledSyncTimer);
        scheduledSyncTimer = null;
        flushPromise = (async () => {
          get().reconcilePending();
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
              get().reconcilePending();
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

              removePendingEvents(syncSubject, acceptedIds);

              set((state) => {
                const legacyPendingBySubject = { ...state.pendingBySubject };
                if (!state.legacyMigrationComplete && legacyPendingBySubject[syncSubject]) {
                  const held = legacyPendingBySubject[syncSubject].filter(
                    (event) => !acceptedIds.has(event.event_id),
                  );
                  if (held.length) legacyPendingBySubject[syncSubject] = held;
                  else delete legacyPendingBySubject[syncSubject];
                }
                if (state.ownerSubject !== syncSubject) {
                  return state.legacyMigrationComplete ? {} : { pendingBySubject: legacyPendingBySubject };
                }
                return {
                  pendingQueue: state.pendingQueue.filter((event) => !acceptedIds.has(event.event_id)),
                  ...(!state.legacyMigrationComplete ? { pendingBySubject: legacyPendingBySubject } : {}),
                  lastSyncedAt: Date.now(),
                };
              });
              submitted += snapshot.length;
              if (keepalive) break;
            } while (get().pendingQueue.length > 0);

            // 成功提交：重置失败计数与退避时间
            consecutiveFailures = 0;
            nextAllowedSyncTime = 0;
            nextRetryTime = 0;

            return { ok: true, submitted, remaining: get().pendingQueue.length };
          } catch (error) {
            const stillCurrent = get().ownerSubject === syncSubject;
            if (stillCurrent) consecutiveFailures += 1;
            const delay = stillCurrent ? Math.min(
              INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1),
              MAX_BACKOFF_MS,
            ) : 0;
            if (stillCurrent) nextAllowedSyncTime = Date.now() + delay;
            if (stillCurrent) nextRetryTime = nextAllowedSyncTime;
            console.warn(`播放统计后台同步失败，将在 ${Math.round(delay / 1000)} 秒后重试:`, error);
            return { ok: false, submitted, remaining: get().pendingQueue.length, error, retryAfterMs: delay };
          } finally {
            const current = get();
            if (current.ownerSubject === syncSubject) {
              set({ isSyncing: false });
            }
            scheduleNextSync();
          }
        })();

        const clearFlight = () => {
          flushPromise = null;
          flushSubject = null;
        };
        flushPromise.then(clearFlight, clearFlight);
        return flushPromise;
      },

      refreshRemoteStats: async (limit = 20) => {
        const initial = get();
        const syncSubject = initial.ownerSubject;
        if (!initial.identityReady) return { ok: false, reason: 'identity-unconfirmed' };
        if (!syncSubject) return { ok: false, reason: 'unauthenticated' };
        if (!pageIsVisible()) return { ok: false, reason: 'page-hidden' };

        try {
          const data = await fetchAccountPlayStats({ limit, expectedSubject: syncSubject });
          if (!data) throw new Error('播放统计服务未返回数据。');
          if (!get().identityReady || get().ownerSubject !== syncSubject) {
            return { ok: false, reason: 'identity-changed' };
          }

          set((state) => {
            if (state.ownerSubject !== syncSubject) return {};
            return rebuildFromRemote(data, {
              ...state,
              pendingQueue: readPendingEvents(syncSubject),
            });
          });
          return { ok: true, data };
        } catch (error) {
          console.warn('拉取云端播放统计失败:', error);
          return { ok: false, error };
        }
      },

      synchronizeAccountStats: (limit = 50, { force = false } = {}) => {
        if (syncPromise) {
          if (syncSubject === get().ownerSubject) return syncPromise;
          return syncPromise.then(() => get().synchronizeAccountStats(limit, { force }));
        }
        const cycleSubject = get().ownerSubject;
        syncSubject = cycleSubject;
        syncPromise = (async () => {
          let flushResult = await get().flushQueue({ force });
          if (!flushResult.ok && flushResult.reason === 'identity-changed' && get().ownerSubject) {
            flushResult = await get().flushQueue({ force });
          }
          if (!flushResult.ok) return { ok: false, stage: 'submit', ...flushResult };
          const refreshResult = await get().refreshRemoteStats(limit);
          if (!refreshResult.ok) return { ok: false, stage: 'refresh', flushResult, ...refreshResult };
          return { ok: true, flushResult, refreshResult };
        })();
        const currentPromise = syncPromise;
        currentPromise.then((result) => {
          if (get().ownerSubject === cycleSubject) {
            if (result.ok) {
              consecutiveFailures = 0;
              nextAllowedSyncTime = 0;
              nextCycleTime = Date.now() + SYNC_INTERVAL_MS;
              nextRetryTime = 0;
            } else if (result.reason === 'page-hidden') {
              nextRetryTime = Date.now();
            } else if (result.stage === 'submit' && result.retryAfterMs) {
              nextRetryTime = Math.max(Date.now(), nextAllowedSyncTime);
            } else {
              consecutiveFailures += 1;
              nextRetryTime = Date.now() + Math.min(
                INITIAL_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
                MAX_BACKOFF_MS,
              );
            }
            scheduleNextSync();
          }
          syncPromise = null;
          syncSubject = null;
        }, () => {
          if (get().ownerSubject === cycleSubject) {
            nextRetryTime = Date.now() + INITIAL_BACKOFF_MS;
            scheduleNextSync();
          }
          syncPromise = null;
          syncSubject = null;
        });
        return currentPromise;
      },
    }),
    {
      name: 'music-play-stats-v2',
      version: 2,
      storage: createJSONStorage(getLocalStorage),
      partialize: (state) => ({
        ownerSubject: state.ownerSubject,
        playCounts: state.playCounts,
        ...(!state.legacyMigrationComplete ? {
          pendingQueue: state.pendingQueue,
          pendingBySubject: state.pendingBySubject,
          legacyUnownedPending: state.legacyUnownedPending,
        } : {}),
        songMetaMap: state.songMetaMap,
        topSongs: state.topSongs,
        totalPlays: state.totalPlays,
        totalUniqueSongs: state.totalUniqueSongs,
        lastSyncedAt: state.lastSyncedAt,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        try {
          const persisted = JSON.parse(getLocalStorage().getItem('music-play-stats-v2') || '{}').state || {};
          if (
            persisted.pendingQueue?.length
            || persisted.legacyUnownedPending?.length
            || Object.keys(persisted.pendingBySubject || {}).length
          ) {
            state.migrateLegacyPending(persisted);
          }
        } catch (migrationError) {
          console.warn('旧播放事件队列迁移失败:', migrationError);
        }
      },
    },
  ),
);

if (
  typeof window !== 'undefined'
  && typeof window.addEventListener === 'function'
) {
  const pauseSyncTimer = () => {
    if (scheduledSyncTimer) clearTimeout(scheduledSyncTimer);
    scheduledSyncTimer = null;
  };

  window.addEventListener('pagehide', pauseSyncTimer);
  window.addEventListener('pageshow', () => scheduleNextSync());
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pauseSyncTimer();
      else scheduleNextSync();
    });
  }
  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith(PENDING_EVENT_PREFIX)) {
      usePlayStatsStore.getState().reconcilePending();
    }
  });
  window.addEventListener('online', () => scheduleNextSync());
}
