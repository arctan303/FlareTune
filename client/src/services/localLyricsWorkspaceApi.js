import { getApiBaseUrl } from './apiBase.js';
import { requestAccountJson } from './accountApiRequest.js';
import { useUIStore } from '../store/useUIStore.js';

export const LYRIC_OFFSET_MIN = -5000;
export const LYRIC_OFFSET_MAX = 5000;

export function clampLyricOffset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(
    LYRIC_OFFSET_MAX,
    Math.max(LYRIC_OFFSET_MIN, Math.round(numeric)),
  );
}

class LyricsWorkspaceError extends Error {
  constructor(message, { status, code, data } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function requestLyricsWorkspace(path, init = {}) {
  const method = init.method || 'GET';
  const session = useUIStore.getState().authSession;
  const memberAction = method === 'POST' && [
    '/candidates/inspect', '/ai-completion',
  ].some((suffix) => path.endsWith(suffix));
  if (method !== 'GET' && (!session?.authenticated || !session?.csrfToken)) {
    throw new LyricsWorkspaceError('登录会话已失效，请重新登录。', {
      status: 401, code: 'UNAUTHORIZED',
    });
  }
  if (method !== 'GET' && !memberAction && session?.user?.role !== 'admin') {
    throw new LyricsWorkspaceError('只有管理员可以修改共享歌词。', {
      status: 403, code: 'FORBIDDEN',
    });
  }
  const data = await requestAccountJson({
    base: getApiBaseUrl(),
    path,
    init,
    ErrorType: LyricsWorkspaceError,
    errorLabel: '歌词请求失败',
  });
  return { ok: true, data };
}

export const lyricsWorkspaceApi = {
  getLyrics: (songId) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}`),
  getLyricsCandidates: (songId, options = {}) => {
    const params = new URLSearchParams();
    if (options.title) params.set('title', options.title);
    if (options.artist) params.set('artist', options.artist);
    if (options.source && options.source !== 'all') params.set('source', options.source);
    const queryString = params.toString();
    const query = queryString ? `?${queryString}` : '';
    return requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/candidates${query}`, {
      signal: options.signal,
    });
  },
  inspectLyricsCandidates: (songId, candidates, options = {}) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/candidates/inspect`, {
    method: 'POST',
    signal: options.signal,
    body: JSON.stringify({
      candidates,
      ...(options.title ? { searchTitle: options.title } : {}),
      ...(options.artist ? { searchArtist: options.artist } : {}),
    }),
  }),
  updateLyrics: (songId, selection, options = {}) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      source: selection.source,
      providerLyricId: selection.providerLyricId ?? null,
      etag: selection.etag ?? null,
      ...(selection.searchTitle || options.title ? { searchTitle: selection.searchTitle || options.title } : {}),
      ...(selection.searchArtist || options.artist ? { searchArtist: selection.searchArtist || options.artist } : {}),
    }),
  }),
  updateLyricsOffset: (songId, offset) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/offset`, {
    method: 'PATCH',
    body: JSON.stringify({
      offsetMs: clampLyricOffset(offset.offsetMs),
      etag: offset.etag ?? null,
    }),
  }),
  shiftLyricsTimeline: (songId, { deltaMs, etag }) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/timeline`, {
    method: 'PATCH', body: JSON.stringify({ deltaMs, etag }),
  }),
  saveLyricsDocument: (songId, { lines, etag, aiReceipt }) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/document`, {
    method: 'PUT', body: JSON.stringify({ lines, etag, ...(aiReceipt ? { aiReceipt } : {}) }),
  }),
  completeDraftLyrics: (songId, { lines, etag }) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/draft-ai`, {
    method: 'POST', body: JSON.stringify({ lines, etag }),
  }),
  importLyricsLrc: (songId, { lrc, etag }) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/import`, {
    method: 'POST', body: JSON.stringify({ lrc, etag }),
  }),
  restoreLyricsBackup: (songId, { asset, etag }) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/restore`, {
    method: 'POST', body: JSON.stringify({ asset, etag }),
  }),
  resetLyrics: (songId, etag = null) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ etag }),
  }),
  completeLyricsTranslation: (songId) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/ai-completion`, {
    method: 'POST',
    body: JSON.stringify({}),
  }),
  clearLyricsTranslation: (songId, etag = null) => requestLyricsWorkspace(`/api/lyrics/workspace/${encodeURIComponent(songId)}/translation`, {
    method: 'DELETE',
    body: JSON.stringify({ etag }),
  }),
};
