import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicVisibilityGate, publicVisibilityTarget } from './public-visibility.mjs';
import { createYouTubeService } from './service.mjs';
import { createPlayer, PROFILE } from './player.mjs';

const id = 'QBtVFL0Qefs';
function publicFixture(videoId = id) {
  return { version: '1.0', type: 'video', provider_name: 'YouTube', provider_url: 'https://www.youtube.com/',
    title: 'Public music fixture', author_name: 'Public singer', author_url: 'https://www.youtube.com/channel/UCfixture',
    html: '<iframe src="https://www.youtube.com/embed/' + videoId + '?feature=oembed"></iframe>' };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('anonymous proof uses only a fixed no-credential oEmbed destination and coalesces positive checks', async () => {
  let checks = 0, currentTime = 1000;
  const gate = createPublicVisibilityGate({ now: () => currentTime, async fetchImpl(target, init) {
    checks++;
    const url = new URL(target);
    assert.equal(url.origin, 'https://www.youtube.com'); assert.equal(url.pathname, '/oembed');
    assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=' + id);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    for (const header of ['Cookie', 'Authorization', 'X-API-Key']) assert.equal(headers.has(header), false);
    return json(publicFixture());
  } });
  assert.deepEqual(await Promise.all([gate(id), gate(id)]), [true, true]);
  assert.equal(checks, 1);
  assert.equal(await gate(id), true); assert.equal(checks, 1);
  currentTime += 30001;
  assert.equal(await gate(id), true); assert.equal(checks, 2);
  assert.throws(() => publicVisibilityTarget('https://private.test/'), { code: 'YOUTUBE_INVALID_VIDEO_ID' });
});

test('redirects, unavailable videos, private placeholders and malformed/oversized proof fail closed', async () => {
  const cases = [
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/' } }),
    () => json({ title: '[Private video]', is_private: false }),
    () => json({ ...publicFixture(), author_name: '' }),
    () => json({ ...publicFixture(), html: '<iframe src="https://www.youtube.com/embed/4D7u5KF7SP8"></iframe>' }),
    () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('x'.repeat(16385), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
  ];
  for (const response of cases) {
    const gate = createPublicVisibilityGate({ fetchImpl: async () => response() });
    await assert.rejects(gate(id), error => error.code === 'YOUTUBE_VIDEO_NOT_PUBLIC' || error.code === 'YOUTUBE_VISIBILITY_UNAVAILABLE');
  }
});

test('guest rejection never reaches a privileged player, even with a cached next placeholder', async () => {
  let anonymousChecks = 0, privilegedResolutions = 0, mediaRequests = 0;
  const gate = createPublicVisibilityGate({ async fetchImpl() { anonymousChecks++; return new Response(null, { status: 404 }); } });
  const service = createYouTubeService({ env: {}, services: {
    manager: { guest: async () => ({ music: { getUpNext: async () => ({ contents: [{ video_id: id, title: '[Private video]', is_private: false }] }) } }) },
    player: { async resolve() { privilegedResolutions++; throw new Error('must never reach member player'); } },
    assertPublicVideo: gate, fetchMedia: async () => { mediaRequests++; throw new Error('must never fetch private media'); },
  } });
  // Metadata/next placeholders are deliberately not treated as visibility proof.
  await service.song(id, { hl: 'fr' });
  await assert.rejects(service.stream(new Request('https://site.test/media/youtube/audio/' + id), id), { code: 'YOUTUBE_VIDEO_NOT_PUBLIC' });
  assert.equal(anonymousChecks, 1); assert.equal(privilegedResolutions, 0); assert.equal(mediaRequests, 0);
});

test('expired anonymous visibility is rechecked before both hot player L1 and persisted KV media', async () => {
  const scope = crypto.randomUUID();
  let currentTime = 1000, publicNow = true, anonymousChecks = 0, privilegedResolutions = 0, kvReads = 0, mediaRequests = 0;
  const gate = createPublicVisibilityGate({ now: () => currentTime, async fetchImpl() {
    anonymousChecks++; return publicNow ? json(publicFixture()) : new Response(null, { status: 404 });
  } });
  const entry = { id, expiresAt: Date.now() + 3600000, formats: [{ itag: 774, url: 'https://rr.googlevideo.com/public-fixture',
    mime_type: 'audio/webm; codecs="opus"', has_audio: true, has_video: false, bitrate: 256000 }] };
  const env = { YTM_KV: { async get(key) { kvReads++; assert.equal(key, `yt:stream:${scope}:${PROFILE}:${id}`); return entry; } } };
  const manager = { scope: async () => scope, async tv() { privilegedResolutions++; throw new Error('not needed with cached stream'); } };
  const service = createYouTubeService({ env, services: { manager, player: createPlayer({ env, manager }), assertPublicVideo: gate,
    async fetchMedia() { mediaRequests++; return new Response('audio-fixture', { status: 206, headers: { 'Content-Type': 'audio/webm' } }); } } });
  assert.equal((await service.stream(new Request('https://site.test/media/youtube/audio/' + id), id)).status, 206);
  assert.equal(kvReads, 1); assert.equal(mediaRequests, 1);
  publicNow = false; currentTime += 30001;
  await assert.rejects(service.stream(new Request('https://site.test/media/youtube/audio/' + id), id), { code: 'YOUTUBE_VIDEO_NOT_PUBLIC' });
  // An independent new player would restore KV, but is also gated before reading it.
  const cold = createYouTubeService({ env, services: { manager, player: createPlayer({ env, manager }), assertPublicVideo: gate } });
  await assert.rejects(cold.stream(new Request('https://site.test/media/youtube/audio/' + id), id), { code: 'YOUTUBE_VIDEO_NOT_PUBLIC' });
  assert.equal(anonymousChecks, 3); assert.equal(kvReads, 1); assert.equal(privilegedResolutions, 0); assert.equal(mediaRequests, 1);
});
