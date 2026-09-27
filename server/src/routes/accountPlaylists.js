import {
  AccountPlaylistError,
  addSongsToPlaylists,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistShelf,
  listPlaylists,
  removePlaylistSong,
  replacePlaylistSongs,
  updatePlaylist,
  updatePlaylistShelf,
} from '../services/accountPlaylists.js';

const MESSAGES = {
  AUTH_REQUIRED: '需要登录账号才能管理个人歌单。',
  CSRF_REJECTED: '请求来源验证失败。',
  INVALID_BODY: '请求内容无效。',
  MUSIC_STORAGE_UNAVAILABLE: '个人歌单存储暂时不可用。',
};

export const accountPlaylistJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  },
});

const success = (data, status, headers) => accountPlaylistJson({ ok: true, data }, status, headers);
const failure = (error, status, headers, message, data) => accountPlaylistJson({
  ok: false,
  error,
  message: message || MESSAGES[error] || error,
  ...(data === undefined ? {} : { data }),
}, status, headers);

const readBody = async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new AccountPlaylistError('INVALID_BODY', '请求体必须是有效 JSON。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AccountPlaylistError('INVALID_BODY', '请求体必须是 JSON 对象。');
  }
  return body;
};

const decodePathPart = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AccountPlaylistError('INVALID_BODY', '路径 ID 格式无效。');
  }
};

export async function handleAccountPlaylistsRoute(request, url, db, headers, user) {
  const path = url.pathname;
  if (!path.startsWith('/api/account/')) return null;
  if (!user?.subject) return failure('AUTH_REQUIRED', 401, headers);

  try {
    if (path === '/api/account/playlists' && request.method === 'GET') {
      return success(await listPlaylists(db, user.subject), 200, headers);
    }
    if (path === '/api/account/playlists' && request.method === 'POST') {
      return success(await createPlaylist(db, user.subject, await readBody(request)), 201, headers);
    }
    if (path === '/api/account/playlist-songs' && request.method === 'POST') {
      return success(await addSongsToPlaylists(db, user.subject, await readBody(request)), 200, headers);
    }
    if (path === '/api/account/playlist-shelf' && request.method === 'GET') {
      return success({ shelf: await getPlaylistShelf(db, user.subject) }, 200, headers);
    }
    if (path === '/api/account/playlist-shelf' && request.method === 'PUT') {
      return success(await updatePlaylistShelf(db, user.subject, await readBody(request)), 200, headers);
    }

    const songMatch = path.match(/^\/api\/account\/playlists\/([^/]+)\/songs\/([^/]+)$/);
    if (songMatch && request.method === 'DELETE') {
      const body = await readBody(request);
      return success(await removePlaylistSong(
        db,
        user.subject,
        decodePathPart(songMatch[1]),
        decodePathPart(songMatch[2]),
        body.expectedRevision,
      ), 200, headers);
    }

    const songsMatch = path.match(/^\/api\/account\/playlists\/([^/]+)\/songs$/);
    if (songsMatch && request.method === 'PUT') {
      const body = await readBody(request);
      return success(await replacePlaylistSongs(
        db,
        user.subject,
        decodePathPart(songsMatch[1]),
        body.songIds,
        body.expectedRevision,
      ), 200, headers);
    }

    const playlistMatch = path.match(/^\/api\/account\/playlists\/([^/]+)$/);
    if (playlistMatch) {
      const playlistId = decodePathPart(playlistMatch[1]);
      if (request.method === 'GET') return success({ playlist: await getPlaylist(db, user.subject, playlistId) }, 200, headers);
      if (request.method === 'PUT') return success(await updatePlaylist(db, user.subject, playlistId, await readBody(request)), 200, headers);
      if (request.method === 'DELETE') {
        const body = await readBody(request);
        return success(await deletePlaylist(db, user.subject, playlistId, body.expectedRevision), 200, headers);
      }
    }

    return failure('PLAYLIST_NOT_FOUND', 404, headers, '接口不存在。');
  } catch (error) {
    if (error instanceof AccountPlaylistError) {
      return failure(error.code, error.status, headers, error.message, error.data);
    }
    return failure('MUSIC_STORAGE_UNAVAILABLE', 503, headers);
  }
}
