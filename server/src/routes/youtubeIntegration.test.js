import test from 'node:test';
import assert from 'node:assert/strict';
import { handleYouTubeMusicRoute, handleYouTubeMedia, createYouTubeAccess, youtubeLyricDependencies } from './youtubeIntegration.js';
const session = { mode: 'normal', account: { accountId: 'one', role: 'member' } };
const song = { id: 'yt:QBtVFL0Qefs', title: 'Same title', artist: 'Same artist', source: 'youtube' };
const localRead = async () => Response.json({ code: 200, data: { songs: [{ id: 'local', title: song.title, artist: song.artist }], query: 'Same' } });
const run = (path, options) => { const request = new Request('https://test.example' + path);
  return handleYouTubeMusicRoute(request, new URL(request.url), {}, session, {}, options); };
test('search retains same local and YT recording, uses independent source offset and exposes no signed URL', async () => {
  let params;
  const getAccess = async () => ({ service: { search: async (_, options) => { params = options; return { songs: [song], hasMore: true }; } }, assertCurrent: async () => true });
  const response = await run('/api/songs/search?q=Same', { localRead, getAccess });
  const result = (await response.json()).data;
  assert.deepEqual(result.songs.map(s => s.id), ['local', song.id]);
  assert.equal(result.hasMore, true); assert.equal(result.nextOffset, 20);
  assert.equal(params.hl, undefined, 'omitting hl preserves the independently configured metadata language');
  assert.equal(params.offset, 0); assert.equal(params.limit, 20);
});
test('disabled plugin preserves original local response; failed YT requests retain local with safe warning', async () => {
  const getAccess = async () => { throw Object.assign(new Error('private error data'), { code: 'PLUGIN_NOT_INSTALLED' }); };
  const response = await run('/api/songs/search?q=Same', { localRead, getAccess });
  assert.deepEqual(await response.json(), await (await localRead()).json());
  const failed = await run('/api/songs/search?q=Same', { localRead, getAccess: async () => { throw new Error('secret signed URL'); } });
  const payload = await failed.json();
  assert.equal(payload.data.songs[0].id, 'local');
  assert.deepEqual(payload.data.sourceWarnings, [{ source: 'youtube', code: 'unavailable' }]);
  assert.equal(JSON.stringify(payload).includes('secret'), false);
});
test('artist detail paginates public upstream by stable browse ID', async () => {
  const songs = Array.from({ length: 5 }, (_, i) => ({ id: 'yt:' + String(i).padStart(11, '0') }));
  const getAccess = async () => ({ service: { artist: async id => { assert.equal(id, 'UCabc'); return { name: 'Artist', songs, albums: [], hasMore: true }; } }, assertCurrent: async () => true });
  const response = await run('/api/artists/yt%3Aartist%3AUCabc?offset=2&limit=2', { getAccess });
  const data = (await response.json()).data;
  assert.deepEqual(data.songs.map(s => s.id), songs.slice(2, 4).map(s => s.id));
  assert.equal(data.nextOffset, 4); assert.equal(data.hasMore, true);
});
test('media consumes authenticated service, rechecks connection after fetch and cancels stale bytes', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const request = new Request('https://test.example/media/youtube/audio/QBtVFL0Qefs', { headers: { Range: 'bytes=4-8' } });
  const getAccess = async () => ({ service: { stream: async r => { assert.equal(r.headers.get('Range'), 'bytes=4-8');
    return new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 4-8/100' } }); } }, assertCurrent: async () => { throw new Error('binding retired'); } });
  const response = await handleYouTubeMedia(request, new URL(request.url).pathname, {}, session, {}, { getAccess });
  assert.equal(response.status, 502); assert.equal(cancelled, true);
});
test('access and lyric resolution reject a binding replaced while request was in flight', async () => {
  let epoch = 'installation:one';
  const options = { checkSession: async () => {}, bindingFor: async () => ({ epoch, record: { epoch: 'installation' } }),
    createService: () => ({ song: async () => song }) };
  const access = await createYouTubeAccess({}, session, {}, options);
  epoch = 'installation:two';
  await assert.rejects(access.assertCurrent(), { code: 'YOUTUBE_CONNECTION_CHANGED' });
  const deps = youtubeLyricDependencies({}, session, {}, { getAccess: async () => access });
  assert.equal(await deps.songStillExists(song.id), false);
  await assert.rejects(deps.resolveSong(song.id), { code: 'YOUTUBE_CONNECTION_CHANGED' });
  assert.equal(await deps.resolveSong('local-id'), null);
});

test('one lyric request cannot adopt a new account binding after metadata resolution', async () => {
  let generation = 1, accesses = 0;
  const deps = youtubeLyricDependencies({}, session, {}, { getAccess: async () => {
    accesses++; const captured = generation;
    return { service: { song: async () => song }, assertCurrent: async () => {
      if (captured !== generation) throw new Error('retired binding');
      return true;
    } };
  } });
  assert.equal((await deps.resolveSong(song.id)).id, song.id);
  generation = 2;
  assert.equal(await deps.songStillExists(song.id), false);
  await assert.rejects(deps.resolveSong(song.id), /retired binding/u);
  assert.equal(accesses, 1, 'all late write checks retain the original request binding');
});

test('private compute binding receives only range, codec and server authority, with no browser credentials', async () => {
  let received;
  const env = { YTM_RUNTIME: { idFromName: name => name, get: name => ({ fetch: async (url, init) => {
    assert.equal(name, 'youtube:private-generation'); received = { url, headers: new Headers(init.headers) };
    return new Response(new Uint8Array([4, 5]), { status: 206, headers: { 'Content-Type': 'audio/webm', 'Content-Range': 'bytes 4-5/100' } });
  } }) } };
  const request = new Request('https://test.example/media/youtube/audio/QBtVFL0Qefs?codec=opus&url=https://invalid.example', {
    headers: { Cookie: 'private-cookie', Authorization: 'Bearer private-token', Range: 'bytes=4-5', 'X-FlareTune-YT-Epoch': 'attacker-generation' } });
  const getAccess = async () => ({ epoch: 'private-generation', service: { stream: () => assert.fail('must run inside actor') }, assertCurrent: async () => true });
  const response = await handleYouTubeMedia(request, new URL(request.url).pathname, env, session, {}, { getAccess });
  assert.equal(response.status, 206); assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5]);
  assert.equal(received.url, 'https://youtube-runtime.internal/audio/QBtVFL0Qefs?codec=opus');
  assert.equal(received.headers.get('X-FlareTune-YT-Epoch'), 'private-generation');
  assert.equal(received.headers.get('Range'), 'bytes=4-5');
  assert.equal(received.headers.has('Cookie'), false); assert.equal(received.headers.has('Authorization'), false);
});
