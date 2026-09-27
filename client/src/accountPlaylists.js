import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { getApiBaseUrl } from './services/apiBase.js';
import { requestAccountJson } from './services/accountApiRequest.js';

export class AccountPlaylistRequestError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED', data } = {}) {
    super(message || code);
    this.name = 'AccountPlaylistRequestError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export const ACCOUNT_PLAYLIST_STALE_CODE = 'STALE_ACCOUNT_CONTEXT';
export const isAccountPlaylistStaleError = (error) => error?.code === ACCOUNT_PLAYLIST_STALE_CODE;

const staleAccountPlaylistError = () => new AccountPlaylistRequestError(
  '账号状态已变化，已忽略旧请求结果。',
  { code: ACCOUNT_PLAYLIST_STALE_CODE },
);

export const getAccountPlaylistApiBase = () => getApiBaseUrl();

const initialState = {
  subject: null,
  generation: 0,
  status: 'idle',
  error: null,
  playlists: [],
  details: {},
  shelf: null,
};

const normalizePlaylist = (playlist) => playlist?.kind === 'favorite'
  ? { ...playlist, name: '我的收藏', description: '' }
  : playlist;
const normalizePlaylists = (playlists) => (playlists || []).map(normalizePlaylist);

const batchFailureStatus = (code) => {
  if (['REVISION_CONFLICT', 'PLAYLIST_LIMIT_REACHED', 'PLAYLIST_SONG_LIMIT_REACHED'].includes(code)) return 409;
  if (['PLAYLIST_NOT_FOUND', 'SONG_NOT_FOUND'].includes(code)) return 404;
  return 400;
};

const throwBatchFailure = (data) => {
  if (data?.outcome !== 'failed') return;
  const failure = data.results?.find((item) => item.outcome === 'failed') || {};
  const code = failure.error || 'REQUEST_FAILED';
  throw new AccountPlaylistRequestError('个人歌单未能更新。', {
    status: batchFailureStatus(code),
    code,
    data,
  });
};

const retainCurrentDetails = (details, playlists) => {
  const currentIds = new Set((playlists || []).map((playlist) => playlist.id));
  return Object.fromEntries(Object.entries(details || {}).filter(([playlistId]) => currentIds.has(playlistId)));
};

export function createAccountPlaylistStore({ fetchImpl = globalThis.fetch, apiBase } = {}) {
  const base = typeof apiBase === 'string' ? apiBase.replace(/\/$/, '') : getAccountPlaylistApiBase();
  const jsonRequest = (path, init) => requestAccountJson({
    fetchImpl,
    base,
    path,
    init,
    ErrorType: AccountPlaylistRequestError,
    errorLabel: '个人歌单请求失败',
  });
  const store = createStore((set, get) => {
    const isCurrent = (subject, generation) => {
      const state = get();
      return state.subject === subject && state.generation === generation;
    };
    const capture = () => ({ subject: get().subject, generation: get().generation });
    const requireSubject = () => {
      const current = capture();
      if (!current.subject) throw new AccountPlaylistRequestError('需要登录账号才能管理个人歌单。', { status: 401, code: 'AUTH_REQUIRED' });
      return current;
    };
    const run = async (operation, { availability = false } = {}) => {
      const current = requireSubject();
      try {
        const data = await operation(current);
        if (!isCurrent(current.subject, current.generation)) throw staleAccountPlaylistError();
        set((state) => availability && state.status === 'error' ? {} : { error: null });
        return data;
      } catch (error) {
        if (!isCurrent(current.subject, current.generation)) throw staleAccountPlaylistError();
        const unavailable = availability && (error?.status === 0 || error?.status >= 500);
        set({ error, ...(unavailable ? { status: 'error' } : {}) });
        throw error;
      }
    };
    const applyDetail = (playlist, current) => {
      if (!playlist || !isCurrent(current.subject, current.generation)) return;
      if (!get().playlists.some((item) => item.id === playlist.id)) return;
      set((state) => ({ details: { ...state.details, [playlist.id]: normalizePlaylist(playlist) } }));
    };
    const applySummary = (playlist, current) => {
      if (!playlist || !isCurrent(current.subject, current.generation)) return;
      const summary = normalizePlaylist(playlist);
      set((state) => ({
        playlists: state.playlists.some((item) => item.id === playlist.id)
          ? state.playlists.map((item) => item.id === playlist.id ? normalizePlaylist({ ...item, ...summary }) : item)
          : [...state.playlists, summary],
      }));
    };

    return {
      ...initialState,
      setSubject(subject) {
        const nextSubject = typeof subject === 'string' && subject.trim() ? subject.trim() : null;
        if (get().subject === nextSubject) return false;
        set((state) => ({ ...initialState, subject: nextSubject, generation: state.generation + 1 }));
        return true;
      },
      async refreshLists() {
        return run(async (current) => {
          const data = await jsonRequest('/api/account/playlists');
          const playlists = normalizePlaylists(data.playlists);
          if (isCurrent(current.subject, current.generation)) set((state) => ({
            playlists,
            details: retainCurrentDetails(state.details, playlists),
          }));
          return { ...data, playlists };
        });
      },
      async refreshShelf() {
        return run(async (current) => {
          const data = await jsonRequest('/api/account/playlist-shelf');
          if (isCurrent(current.subject, current.generation)) set({ shelf: data.shelf || null });
          return data;
        });
      },
      async refresh() {
        const current = requireSubject();
        if (isCurrent(current.subject, current.generation)) set({ status: 'loading', error: null });
        const [listsResult, shelfResult] = await Promise.allSettled([
            jsonRequest('/api/account/playlists'),
            jsonRequest('/api/account/playlist-shelf'),
        ]);
        if (!isCurrent(current.subject, current.generation)) throw staleAccountPlaylistError();

        const error = listsResult.status === 'rejected'
          ? listsResult.reason
          : shelfResult.status === 'rejected'
            ? shelfResult.reason
            : null;
        const playlists = listsResult.status === 'fulfilled' ? normalizePlaylists(listsResult.value.playlists) : null;
        set((state) => ({
          status: error ? 'error' : 'ready',
          ...(listsResult.status === 'fulfilled' ? {
            playlists,
            details: retainCurrentDetails(state.details, playlists),
          } : {}),
          ...(shelfResult.status === 'fulfilled' ? { shelf: shelfResult.value.shelf || null } : {}),
          error,
        }));
        if (error) throw error;
        return { ...listsResult.value, playlists, ...shelfResult.value };
      },
      async loadDetail(playlistId) {
        return run(async (current) => {
          const data = await jsonRequest(`/api/account/playlists/${encodeURIComponent(playlistId)}`);
          const playlist = normalizePlaylist(data.playlist);
          applyDetail(playlist, current);
          return playlist;
        }, { availability: true });
      },
      async createPlaylist(input) {
        return run(async (current) => {
          const data = await jsonRequest('/api/account/playlists', { method: 'POST', body: JSON.stringify(input) });
          applySummary(data.playlist, current);
          if (isCurrent(current.subject, current.generation)) set({ shelf: data.shelf || get().shelf });
          return data;
        });
      },
      async updatePlaylist(playlistId, input) {
        return run(async (current) => {
          const data = await jsonRequest(`/api/account/playlists/${encodeURIComponent(playlistId)}`, { method: 'PUT', body: JSON.stringify(input) });
          applySummary(data.playlist, current);
          if (get().details[playlistId]) applyDetail({ ...get().details[playlistId], ...data.playlist }, current);
          return data;
        });
      },
      async deletePlaylist(playlistId, expectedRevision) {
        return run(async (current) => {
          const data = await jsonRequest(`/api/account/playlists/${encodeURIComponent(playlistId)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }) });
          if (isCurrent(current.subject, current.generation)) set((state) => {
            const details = { ...state.details };
            delete details[playlistId];
            return { playlists: state.playlists.filter((item) => item.id !== playlistId), details, shelf: data.shelf || state.shelf };
          });
          return data;
        });
      },
      async addSongs(targets, songIds) {
        return run(async (current) => {
          const data = await jsonRequest('/api/account/playlist-songs', { method: 'POST', body: JSON.stringify({ targets, songIds }) });
          let refreshFailed = false;
          if (isCurrent(current.subject, current.generation)) {
            try {
              await Promise.all([
                get().refreshLists(),
                ...targets.map((target) => get().loadDetail(target.playlistId)),
              ]);
            } catch {
              refreshFailed = true;
            }
          }
          throwBatchFailure(data);
          return refreshFailed ? { ...data, refreshFailed: true } : data;
        });
      },
      async removeSong(playlistId, songId, expectedRevision) {
        return run(async (current) => {
          const data = await jsonRequest(`/api/account/playlists/${encodeURIComponent(playlistId)}/songs/${encodeURIComponent(songId)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }) });
          applyDetail(data.playlist, current);
          applySummary(data.playlist, current);
          return data;
        });
      },
      async replaceSongs(playlistId, songIds, expectedRevision) {
        return run(async (current) => {
          const data = await jsonRequest(`/api/account/playlists/${encodeURIComponent(playlistId)}/songs`, { method: 'PUT', body: JSON.stringify({ songIds, expectedRevision }) });
          applyDetail(data.playlist, current);
          applySummary(data.playlist, current);
          return data;
        });
      },
      clearPlaylist(playlistId, expectedRevision) {
        return get().replaceSongs(playlistId, [], expectedRevision);
      },
      reorderSongs(playlistId, songIds, expectedRevision) {
        return get().replaceSongs(playlistId, songIds, expectedRevision);
      },
      async updateShelfOrder(items, expectedRevision) {
        return run(async (current) => {
          const data = await jsonRequest('/api/account/playlist-shelf', { method: 'PUT', body: JSON.stringify({ items, expectedRevision }) });
          if (isCurrent(current.subject, current.generation)) set({ shelf: data.shelf });
          return data;
        });
      },
    };
  });
  return store;
}

export const accountPlaylistsStore = createAccountPlaylistStore();
export const useAccountPlaylists = (selector = (state) => state) => useStore(accountPlaylistsStore, selector);
