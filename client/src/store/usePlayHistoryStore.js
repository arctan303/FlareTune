import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createResilientStorage } from '../utils/browserStorage.js';
import { formatDateTime, formatRelative, t } from '../i18n/index.js';

export const MAX_HISTORY_COUNT = 100;

const historyStorage = createResilientStorage();
const getLocalStorage = () => historyStorage;

export function formatRelativeTime(timestamp) {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 60) return t('刚刚');
  if (diffSec < 3600) return formatRelative(-Math.floor(diffSec / 60), 'minute');
  if (diffSec < 86400) return formatRelative(-Math.floor(diffSec / 3600), 'hour');
  if (diffSec < 604800) return formatRelative(-Math.floor(diffSec / 86400), 'day');
  return formatDateTime(new Date(timestamp), { month: 'short', day: 'numeric' });
}

export const usePlayHistoryStore = create(
  persist(
    (set) => ({
      history: [],
      subject: null,

      setSubject: (accountId) => {
        const subject = accountId ? String(accountId) : null;
        set((state) => state.subject === subject ? state : { subject, history: [] });
      },

      addSong: (song) => {
        if (!song || !song.id) return;
        const songId = String(song.id).trim();
        if (!songId) return;

        const entry = {
          id: songId,
          title: song.title || '未知曲目',
          artist: song.artist || '未知艺术家',
          album: song.album || '',
          duration: Number(song.duration) || 0,
          audio_url: song.audio_url || '',
          cover_url: song.cover_url || '',
          language: song.language || null,
          playedAt: Date.now(),
        };

        set((state) => {
          const filtered = state.history.filter((s) => s.id !== songId);
          return {
            history: [entry, ...filtered].slice(0, MAX_HISTORY_COUNT),
          };
        });
      },

      removeSong: (songId) => {
        if (!songId) return;
        const targetId = String(songId);
        set((state) => ({
          history: state.history.filter((s) => s.id !== targetId),
        }));
      },

      clearHistory: () => {
        set({ history: [] });
      },
    }),
    {
      name: 'music-play-history-v2',
      version: 2,
      storage: createJSONStorage(getLocalStorage),
    },
  ),
);
