import { resolveInstanceState } from '../instance/state.js';
import { authenticate } from './credentials.js';
import { reply, reject, ProtocolError, required } from './response.js';
import { library } from './library.js';
import { state } from './state.js';
import { media } from './media.js';

const MEDIA = new Set(['stream', 'download', 'getCoverArt', 'getCoverArt2', 'getLyrics', 'getLyricsBySongId']);
const STATE = new Set(['getPlaylists', 'getPlaylist', 'getPlaylist2', 'createPlaylist', 'updatePlaylist', 'deletePlaylist', 'star', 'unstar', 'getStarred', 'getStarred2']);
const MUTATIONS = new Set(['createPlaylist', 'updatePlaylist', 'deletePlaylist', 'star', 'unstar']);
const failures = new Map();
function failureBucket(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  for (const [id, value] of failures) if (now > value.until) failures.delete(id);
  if (!failures.has(ip)) {
    if (failures.size >= 2048) reject(40, 'Too many authentication attempts');
    failures.set(ip, { count: 0, until: now + 15 * 60_000 });
  }
  const bucket = failures.get(ip);
  if (bucket.count >= 20) reject(40, 'Too many authentication attempts');
  return bucket;
}

export async function handleSubsonic(request, env) {
  const url = new URL(request.url); const p = url.searchParams;
  const format = p.get('f') === 'json' ? 'json' : 'xml';
  try {
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) reject(0, 'HTTPS is required');
    if (request.method !== 'GET' && request.method !== 'HEAD') reject(0, 'Only GET is supported');
    if (url.search.length > 32 * 1024) reject(10, 'Request is too large');
    for (const name of new Set(p.keys())) {
      if (!['id', 'songId', 'songIdToAdd', 'songIndexToRemove', 'albumId', 'artistId'].includes(name)
        && p.getAll(name).length !== 1) reject(10, 'Duplicate parameter');
    }
    if (p.has('f') && !['xml', 'json'].includes(p.get('f'))) reject(0, 'Unsupported response format');
    const version = required(p, 'v'); required(p, 'c');
    if (!/^1\.\d+\.\d+$/.test(version)) reject(30, 'Unsupported protocol version');
    if (Number(version.split('.')[1]) > 16) reject(30, 'Server must upgrade');
    if (Number(version.split('.')[1]) < 13) reject(20, 'Client must upgrade');
    const match = /^\/rest\/([A-Za-z0-9]+)(?:\.view)?$/.exec(url.pathname);
    if (!match) reject(70, 'Endpoint was not found');
    const method = match[1];
    if (request.method === 'HEAD' && !['stream', 'download', 'getCoverArt', 'getCoverArt2'].includes(method)) reject(0, 'HEAD is only supported for media');
    // Subsonic mutates through GET: writes must validate the current structure.
    const instance = await resolveInstanceState(env.DB, Date.now(), { cacheSchema: !MUTATIONS.has(method) });
    if (instance.state !== 'ready') return reply({}, format, { code: 0, message: 'Instance is unavailable' }, 503);
    // The OpenSubsonic specification requires unauthenticated discovery.
    // This advertises code capabilities only, never account opt-in or music.
    if (method === 'getOpenSubsonicExtensions') return reply({ openSubsonicExtensions: [{ name: 'songLyrics', versions: [1] }] }, format);
    const bucket = failureBucket(request);
    let account;
    try { account = await authenticate(env.DB, p, env); }
    catch (error) { bucket.count++; throw error; }
    if (method === 'ping') return reply({}, format);
    if (method === 'getLicense') return reply({ license: { valid: true } }, format);
    if (method === 'getUser') {
      if (required(p, 'username') !== account.username) reject(50, 'Cross-user access is not allowed');
      return reply({ user: { username: account.username, scrobblingEnabled: false, adminRole: false,
        settingsRole: false, downloadRole: true, uploadRole: false, playlistRole: true,
        coverArtRole: false, commentRole: false, podcastRole: false, streamRole: true,
        jukeboxRole: false, shareRole: false, videoConversionRole: false, folder: [1] } }, format);
    }
    if (method === 'scrobble') reject(0, 'Playback reporting is not supported');
    const result = MEDIA.has(method) ? await media(method, p, request, env)
      : STATE.has(method) ? await state(method, p, env.DB, account)
        : await library(method, p, env.DB, account.accountId);
    return result instanceof Response ? result : reply(result, format);
  } catch (error) {
    if (error instanceof ProtocolError) return reply({}, format, { code: error.code, message: error.message });
    if (typeof error.code === 'string' && typeof error.status === 'number') {
      return reply({}, format, { code: error.status === 404 ? 70 : error.status === 403 ? 50 : 0,
        message: error.status === 409 ? 'Conflict or quota exceeded; refresh and retry' : 'Request could not be completed' });
    }
    return reply({}, format, { code: 0, message: 'Service unavailable' }, 503);
  }
}
