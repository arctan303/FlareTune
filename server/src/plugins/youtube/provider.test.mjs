import test from 'node:test';
import assert from 'node:assert/strict';
import { item, albumResult, artistResult, searchResult } from './normalize.mjs';
import { streamTarget, imageTarget, publicError, chooseAudio } from './core.mjs';
import { fetchMedia, streamResponse, streamOptions, imageResponse } from './media.mjs';
import { createSessionManager, credentialScope } from './upstream.mjs';
import { createPlayer } from './player.mjs';
import { createYouTubeService } from './service.mjs';

const id = 'QBtVFL0Qefs';
const aid = 'UCIOdfgVAkc_8rxhRAz9WRDw';
const album = 'MPREb_OTsRyrteoHQ';
const node = { id, title: 'Oops!...I Did It Again', item_type: 'song', duration: { seconds: 213 },
  artists: [{ channel_id: aid, name: 'Britney Spears' }], album: { id: album, name: 'Oops!... I Did It Again' },
  thumbnails: [{ url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', width: 480, height: 360 }] };
const credentials = { clientId: 'test-public-client', clientSecret: 'test-client-secret', refreshToken: 'test-refresh' };
const kv = () => {
  const values = new Map(), writes = [], deletes = [];
  return { values, writes, deletes, async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
    async put(key, value, options) { values.set(key, value); writes.push({ key, options }); },
    async delete(key) { values.delete(key); deletes.push(key); } };
};
const format = (itag, codec = 'opus') => ({ itag, url: 'https://rr1.googlevideo.com/videoplayback?itag=' + itag,
  has_audio: true, has_video: false, mime_type: codec === 'opus' ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"', bitrate: itag === 774 ? 256000 : 128000 });

test('YT references preserve upstream identity, public metadata and proxy only media', () => {
  const song = item(node);
  assert.equal(song.id, 'yt:' + id);
  assert.equal(song.source, 'youtube'); assert.equal(song.sourceId, id);
  assert.equal(song.artist, 'Britney Spears'); assert.equal(song.duration, 213);
  assert.equal(song.artists[0].id, 'yt:artist:' + aid);
  assert.equal(song.albumId, 'yt:album:' + album);
  assert.equal(song.audio_url, '/media/youtube/audio/' + id);
  assert.match(song.cover_url, /^\/media\/youtube\/image\?url=/);
  assert.equal(song.title, node.title);
  assert.equal(item({ id: 'bogus', title: 'No playable identity' }), null);
});

test('normalizers provide existing album/artist fields without cross-source matching', () => {
  const rawAlbum = { header: { title: 'Album', author: { name: 'Singer' } }, contents: [{ id, title: 'Song' }] };
  const a = albumResult(rawAlbum, album);
  assert.equal(a.artist, 'Singer'); assert.equal(a.songs[0].albumId, 'yt:album:' + album);
  assert.equal(a.songs[0].album, 'Album');
  const ar = artistResult({ header: { title: 'Singer' }, sections: [{ title: 'Albums', contents: [{ id: album, title: 'Album' }] }] }, aid,
    { contents: [node], continuation: 'upstream-only-token' });
  assert.equal(ar.id, 'yt:artist:' + aid); assert.equal(ar.albums[0].id, 'yt:album:' + album);
  assert.equal(ar.songs[0].id, 'yt:' + id); assert.equal(ar.hasMore, true); assert.equal(ar.total, 1);
  const search = searchResult({ contents: [{ contents: [node, { id: aid, name: 'Singer' }, { id: album, title: 'Album' }] }] });
  assert.equal(search.songs.length, 1); assert.equal(search.artists.length, 1); assert.equal(search.albums.length, 1);
  assert.equal(JSON.stringify(search).includes('upstream-only-token'), false);
});

test('CDN allowlists reject credentials, ports, deceptive hosts and insecure protocols', () => {
  for (const url of ['http://rr.googlevideo.com/a', 'https://rr.googlevideo.com:4430/a', 'https://a:b@rr.googlevideo.com/a', 'https://rr.googlevideo.com.evil.test/a']) {
    assert.throws(() => streamTarget(url));
  }
  assert.equal(streamTarget('https://rr.googlevideo.com/a'), 'https://rr.googlevideo.com/a');
  assert.throws(() => imageTarget('https://lh3.googleusercontent.com.evil.test/a'));
  assert.throws(() => imageTarget('https://example.test/a'));
  assert.equal(imageTarget('https://yt3.googleusercontent.com/a'), 'https://yt3.googleusercontent.com/a');
});

test('media redirect hop revalidates target and never forwards sensitive headers', async () => {
  const calls = [];
  const response = await fetchMedia('https://rr1.googlevideo.com/a', { headers: { Range: 'bytes=0-9', 'If-Range': 'etag', Authorization: 'Bearer private', Cookie: 'private', 'X-API-Key': 'private' } },
    async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://rr2.googlevideo.com/b' } }) : new Response('bytes', { status: 206 }); });
  assert.equal(response.status, 206); assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.get('Range'), 'bytes=0-9');
  for (const call of calls) {
    assert.equal(call.init.redirect, 'manual');
    for (const name of ['Authorization', 'Cookie', 'X-API-Key']) assert.equal(call.init.headers.has(name), false);
  }
  await assert.rejects(fetchMedia('https://rr1.googlevideo.com/a', {}, async () => new Response(null,
    { status: 302, headers: { Location: 'https://127.0.0.1/private' } })), { code: 'YOUTUBE_INVALID_MEDIA_URL' });
});

test('stream keeps Range/206 and retries 403 exactly once with the original itag', async () => {
  const resolutions = [], requests = [];
  const player = { async resolve(id, options) { resolutions.push(options); return { formats: [format(774), format(251)] }; } };
  const result = await streamResponse(new Request('https://host.test/media/youtube/audio/' + id,
    { headers: { Range: 'bytes=500-509', 'If-Range': 'v1', Authorization: 'private', Cookie: 'private' } }), id, player,
    async (url, init) => { requests.push({ url, init }); return requests.length === 1 ? new Response(null, { status: 403 }) :
      new Response('0123456789', { status: 206, headers: { 'Content-Type': 'audio/webm', 'Content-Range': 'bytes 500-509/1000',
        'Content-Length': '10', 'Accept-Ranges': 'bytes', Location: 'https://should-not-reach-client.test', 'Set-Cookie': 'private' } }); });
  assert.equal(result.status, 206); assert.equal(await result.text(), '0123456789');
  assert.equal(result.headers.get('Content-Range'), 'bytes 500-509/1000');
  assert.equal(result.headers.get('Accept-Ranges'), 'bytes'); assert.equal(result.headers.has('Location'), false);
  assert.equal(result.headers.has('Set-Cookie'), false); assert.equal(requests.length, 2);
  assert.equal(resolutions[1].force, true); assert.match(requests[1].url, /itag=774/);
  assert.equal(requests[1].init.headers.get('Range'), 'bytes=500-509');
  assert.equal(requests[1].init.headers.get('If-Range'), 'v1');
  assert.equal(requests[1].init.headers.has('Authorization'), false);
});

test('stream exposes 416, returns empty HEAD and bounds a repeated 403', async () => {
  const player = { resolve: async () => ({ formats: [format(774)] }) };
  const head = await streamResponse(new Request('https://host.test/media/youtube/audio/' + id, { method: 'HEAD' }), id, player,
    async () => new Response(null, { status: 206, headers: { 'Content-Type': 'audio/webm', 'Content-Range': 'bytes 0-9/1000', 'Content-Length': '10' } }));
  assert.equal(head.status, 206); assert.equal(await head.text(), '');
  const invalid = await streamResponse(new Request('https://host.test/media/youtube/audio/' + id), id, player,
    async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */1000' } }));
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('Content-Range'), 'bytes */1000');
  let attempts = 0;
  await assert.rejects(streamResponse(new Request('https://host.test/media/youtube/audio/' + id), id, player,
    async () => { attempts++; return new Response(null, { status: 403 }); }), { code: 'YOUTUBE_MEDIA_UNAVAILABLE' });
  assert.equal(attempts, 2);
});

test('Safari selects AAC and explicit format inputs are validated', () => {
  assert.equal(streamOptions(new Request('https://host.test/a', { headers: { 'User-Agent': 'Version/18.0 Safari/605.1.15' } })).codec, 'aac');
  assert.equal(streamOptions(new Request('https://host.test/a', { headers: { 'User-Agent': 'Chrome/140 Safari/537' } })).codec, 'opus');
  assert.throws(() => streamOptions(new Request('https://host.test/a?itag=999')));
  assert.equal(chooseAudio([format(140, 'aac'), format(141, 'aac')], { itag: 141 }).itag, 141);
});

test('image proxy checks host, type and forwards no browser credentials', async () => {
  const req = new Request('https://host.test/media/youtube/image', { headers: { Cookie: 'secret', Authorization: 'secret' } });
  let init;
  const response = await imageResponse(req, 'https://i.ytimg.com/a', async (_, options) => {
    init = options; return new Response('image-data', { headers: { 'Content-Type': 'image/jpeg' } });
  });
  assert.equal(init.headers, undefined); assert.equal(init.redirect, 'manual');
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=86400');
  assert.match(response.headers.get('Content-Security-Policy'), /sandbox/);
  await assert.rejects(imageResponse(req, 'https://i.ytimg.com/a', async () => new Response('html')), { code: 'YOUTUBE_IMAGE_UNAVAILABLE' });
});

test('credential caches separate account replacement and installation epoch', async () => {
  assert.notEqual(await credentialScope(credentials, 'epoch1'), await credentialScope(credentials, 'epoch2'));
  assert.notEqual(await credentialScope(credentials, 'epoch1'), await credentialScope({ ...credentials, refreshToken: 'other' }, 'epoch1'));
  await assert.rejects(credentialScope({}, 'epoch1'), { code: 'YOUTUBE_NOT_CONNECTED' });
  const store = kv(); let refreshes = 0;
  const manager = createSessionManager({ env: { YTM_KV: store }, credentials, epoch: 'token-test', createSession: async () => {
    const session = { oauth: { async refreshAccessToken() { refreshes++; this.oauth2_tokens = { access_token: 'test-access', expiry_date: new Date(Date.now() + 3600000).toISOString() }; } },
      async signIn(token) { this.oauth.oauth2_tokens = token; }, on() {} };
    return { session };
  } });
  await manager.tv(); await manager.tv();
  assert.equal(refreshes, 1); assert.equal(store.writes.length, 1);
  assert.match(store.writes[0].key, /^yt:token:[a-f\d]{64}$/);
});

test('player coalesces requests, persists bounded TTL and reuses scoped KV on new instance', async () => {
  const store = kv(), scope = crypto.randomUUID(); let players = 0, deciphered = 0;
  const expires = Math.floor(Date.now() / 1000) + 21600;
  const manager = { scope: async () => scope, tv: async () => ({ session: { context: { client: {} }, player: { async decipher(url) { deciphered++; return url; } } },
    async getBasicInfo() { players++; return { streaming_data: { adaptive_formats: [{ ...format(774), url: 'https://rr.googlevideo.com/a?expire=' + expires }] } }; } }) };
  const player = createPlayer({ env: { YTM_KV: store }, manager });
  const values = await Promise.all([player.resolve(id), player.resolve(id)]);
  assert.equal(players, 1); assert.equal(deciphered, 1); assert.equal(values[0].formats[0].itag, 774);
  assert.equal(store.writes.length, 1); assert.equal(store.writes[0].options.expirationTtl, 12600);
  // A deliberately distinct video key proves persisted restore rather than L1.
  const otherId = '4D7u5KF7SP8';
  store.values.set(await player.keyFor(otherId), JSON.stringify({ ...values[0], id: otherId }));
  await createPlayer({ env: { YTM_KV: store }, manager }).resolve(otherId);
  assert.equal(players, 1);
  await player.resolve(id, { force: true }); assert.equal(players, 2); assert.equal(store.deletes.length, 1);
});

test('service fetches accurate song metadata using next without needing player, scopes language and sanitizes errors', async () => {
  let infoCalls = 0, hlSeen;
  const manager = { async guest(hl) { hlSeen = hl; return { music: {
    async getUpNext() { return { contents: [{ ...node, id: undefined, video_id: id }] }; },
    async getInfo() { infoCalls++; throw new Error('must not be needed'); },
    async search() { return { contents: [{ contents: [node] }] }; },
  } }; }, tv: async () => ({}) };
  const service = createYouTubeService({ env: {}, services: { manager, player: {} } });
  const song = await service.song(id, { hl: 'ja' });
  assert.equal(song.title, node.title); assert.equal(song.albumId, 'yt:album:' + album); assert.equal(infoCalls, 0); assert.equal(hlSeen, 'ja');
  const search = await service.search('test', { filter: 'song' }); assert.equal(search.songs[0].id, 'yt:' + id);
  await assert.rejects(service.search('  '), { code: 'YOUTUBE_INVALID_SEARCH' });
  assert.deepEqual(publicError(new Error('Bearer private signed-url')), { error: 'YOUTUBE_UPSTREAM_UNAVAILABLE' });
  assert.deepEqual(await service.validateAuth(), { connected: true, profile: 'TV_SAMSUNG_QJS' });
});
