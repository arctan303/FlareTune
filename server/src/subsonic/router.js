import { resolveInstanceState } from '../instance/state.js';
import { authenticate } from './credentials.js';
import { reply, reject, ProtocolError, required } from './response.js';
import { library } from './library.js';
import { state } from './state.js';
import { media } from './media.js';
import { LyricSourceError } from '../services/lyricSourceError.js';
import { LyricArtifactStoreError } from '../services/lyricArtifactStore.js';
import { PlaybackLyricsError } from '../services/playbackLyrics.js';

const MEDIA = new Set(['stream', 'download', 'getCoverArt', 'getCoverArt2', 'getLyrics', 'getLyricsBySongId']);
const BINARY = new Set(['stream', 'download', 'getCoverArt', 'getCoverArt2']);
const STATE = new Set(['getPlaylists', 'getPlaylist', 'getPlaylist2', 'createPlaylist', 'updatePlaylist', 'deletePlaylist', 'star', 'unstar', 'getStarred', 'getStarred2']);
const MUTATIONS = new Set(['createPlaylist', 'updatePlaylist', 'deletePlaylist', 'star', 'unstar']);
const DIAGNOSTIC_METHODS = new Set([...MEDIA, ...STATE, 'ping', 'getLicense', 'getUser',
  'getOpenSubsonicExtensions', 'scrobble', 'getMusicFolders', 'getGenres', 'getSong',
  'getArtists', 'getIndexes', 'getArtist', 'getAlbum', 'getMusicDirectory', 'search3', 'search2',
  'getRandomSongs', 'getAlbumList2', 'getAlbumList', 'getScanStatus']);
const DIAGNOSTIC_REASONS = new Map([
  ['Wrong username or password', 'authentication_rejected'], ['Song was not found', 'song_missing'],
  ['Media was not found', 'media_missing'], ['Cover was not found', 'cover_missing'],
  ['Transcoding is not supported', 'transcoding_requested'], ['Bitrate limiting is not supported', 'bitrate_limit_requested'],
  ['Use HTTP Range to seek', 'time_offset_requested'], ['Playback reporting is not supported', 'scrobble_unsupported'],
]);
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

export async function handleSubsonic(request, env, executionContext) {
  const url = new URL(request.url); const p = url.searchParams;
  const format = p.get('f') === 'json' ? 'json' : 'xml';
  const binary = BINARY.has(/^\/rest\/([A-Za-z0-9]+)(?:\.view)?$/.exec(url.pathname)?.[1]);
  // A failed binary download must not look like successful media: some clients
  // persist HTTP 200 error bodies as audio even when Content-Type is text/xml.
  // Metadata keeps the normal Subsonic HTTP 200 + protocol error convention.
  const failure = (error, status = 200) => {
    if (binary && status === 200) status = error.code === 70 ? 404
      : error.code === 40 || error.code === 50 ? 403 : 400;
    const response = reply({}, binary ? 'xml' : format, error, status);
    if (binary) response.headers.set('Content-Type', 'text/xml; charset=utf-8');
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  };
  let method;
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
    method = match[1];
    if (request.method === 'HEAD' && !['stream', 'download', 'getCoverArt', 'getCoverArt2'].includes(method)) reject(0, 'HEAD is only supported for media');
    // Subsonic mutates through GET: writes must validate the current structure.
    const instance = await resolveInstanceState(env.DB, Date.now(), { cacheSchema: !MUTATIONS.has(method), executionContext });
    if (instance.state !== 'ready') return failure({ code: 0, message: 'Instance is unavailable' }, 503);
    // The OpenSubsonic specification requires unauthenticated discovery.
    // This advertises code capabilities only, never account opt-in or music.
    if (method === 'getOpenSubsonicExtensions') return reply({ openSubsonicExtensions: [{ name: 'songLyrics', versions: [1, 2] }] }, format);
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
    const result = MEDIA.has(method) ? await media(method, p, request, env, executionContext, account.accountId)
      : STATE.has(method) ? await state(method, p, env.DB, account)
        : await library(method, p, env.DB, account.accountId, executionContext);
    if (binary && result instanceof Response && result.status === 503) {
      return failure({ code: 0, message: 'Service unavailable' }, 503);
    }
    return result instanceof Response ? result : reply(result, format);
  } catch (error) {
    // Development-only, fixed vocabulary. Never log URLs, credentials, IDs,
    // arbitrary parameter values or storage exceptions.
    if (env.SUBSONIC_DIAGNOSTICS === 'true') console.warn(JSON.stringify({
      event: 'subsonic_failure', endpoint: DIAGNOSTIC_METHODS.has(method) ? method : 'other',
      code: error instanceof ProtocolError ? error.code : 0,
      reason: error instanceof ProtocolError ? DIAGNOSTIC_REASONS.get(error.message) || 'request_rejected' : 'service_unavailable',
    }));
    if (error instanceof ProtocolError) return failure({ code: error.code, message: error.message });
    if (error instanceof LyricSourceError) return failure({ code: 0, message: 'Lyric source temporarily unavailable' }, 503);
    if (error instanceof LyricArtifactStoreError || error instanceof PlaybackLyricsError) {
      return failure({ code: 0, message: 'Lyric storage temporarily unavailable' }, 503);
    }
    if (typeof error.code === 'string' && typeof error.status === 'number') {
      return failure({ code: error.status === 404 ? 70 : error.status === 403 ? 50 : 0,
        message: error.status === 409 ? 'Conflict or quota exceeded; refresh and retry' : 'Request could not be completed' });
    }
    return failure({ code: 0, message: 'Service unavailable' }, 503);
  }
}
