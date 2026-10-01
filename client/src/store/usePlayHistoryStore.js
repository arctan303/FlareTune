import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { getLocale } from '../i18n/index.js';

export const MAX_HISTORY_COUNT = 100;

function getLocalStorage() {
  if (!globalThis.localStorage) throw new Error('localStorage is unavailable');
  return globalThis.localStorage;
}

export function formatRelativeTime(timestamp) {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (getLocale() === 'en') {
    if (diffSec < 60) return 'just now';
    const diffMinEn = Math.floor(diffSec / 60);
    if (diffMinEn < 60) return `${diffMinEn} min ago`;
    const diffHourEn = Math.floor(diffMinEn / 60);
    if (diffHourEn < 24) return `${diffHourEn} hr ago`;
    const diffDayEn = Math.floor(diffHourEn / 24);
    if (diffDayEn < 7) return `${diffDayEn} d ago`;
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
  }
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
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
