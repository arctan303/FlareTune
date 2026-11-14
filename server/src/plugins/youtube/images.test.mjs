import test from 'node:test';
import assert from 'node:assert/strict';
import { item, albumResult, artistResult, highResolutionImageTarget } from './normalize.mjs';
import { imageResponse } from './media.mjs';

const source = 'https://yt3.googleusercontent.com/public-album-identity=w120-h120-l90-rj';
const large = 'https://yt3.googleusercontent.com/public-album-identity=w1200-h1200-l90-rj';
const songId = 'WqkrwFSFeAE';
const proxy = raw => '/media/youtube/image?url=' + encodeURIComponent(raw);

test('YT covers request high resolution independently of preserved list thumbnails', () => {
  const images = [{ url: source, width: 120, height: 120 },
    { url: source.replace('w120-h120', 'w60-h60'), width: 60, height: 60 }];
  const song = item({ id: songId, title: 'Public song', thumbnails: images });
  const cover = new URL(song.cover_url, 'https://site.test');
  assert.equal(cover.searchParams.get('url'), source); assert.equal(cover.searchParams.get('size'), '1200');
  assert.equal(song.coverUrl, song.cover_url);
  assert.equal(song.thumbnails.at(-1).width, 120); assert.equal(song.thumbnails.at(-1).url, proxy(source));
  const album = albumResult({ header: { title: 'Album', thumbnails: images }, contents: [] }, 'MPREb_fixture');
  const artist = artistResult({ header: { title: 'Artist', thumbnails: images }, sections: [] }, 'UCfixture');
  assert.equal(new URL(album.coverUrl, 'https://site.test').searchParams.get('size'), '1200');
  assert.equal(new URL(artist.photoUrl, 'https://site.test').searchParams.get('size'), '1200');
});

test('Google image resizing keeps asset/crop/format/query and preserves aspect ratio', () => {
  assert.equal(highResolutionImageTarget(source), large);
  assert.equal(highResolutionImageTarget('https://lh3.googleusercontent.com/artist=s88-c-k-c0x00ffffff-no-rj'),
    'https://lh3.googleusercontent.com/artist=s1200-c-k-c0x00ffffff-no-rj');
  assert.equal(highResolutionImageTarget('https://yt3.googleusercontent.com/banner=w600-h300-no-rj?fixture=1'),
    'https://yt3.googleusercontent.com/banner=w1200-h600-no-rj?fixture=1');
  const bigger = 'https://yt3.googleusercontent.com/cover=w1600-h1600-l90-rj';
  assert.equal(highResolutionImageTarget(bigger), bigger);
  assert.equal(highResolutionImageTarget('https://yt3.googleusercontent.com/plain-without-size'), 'https://yt3.googleusercontent.com/plain-without-size');
  assert.throws(() => highResolutionImageTarget('https://yt3.googleusercontent.com.evil.test/cover=w120-h120'));
});

test('i.ytimg variants are never guessed or rewritten', async () => {
  const original = 'https://i.ytimg.com/vi/' + songId + '/hqdefault.jpg';
  assert.equal(highResolutionImageTarget(original), original);
  const song = item({ id: songId, title: 'Video', thumbnails: [{ url: original, width: 480, height: 360 }] });
  assert.equal(song.cover_url, proxy(original));
  const targets = [];
  await imageResponse(new Request('https://site.test' + proxy(original) + '&size=1200'), original,
    async target => { targets.push(target); return new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } }); });
  assert.deepEqual(targets, [original]);
});

test('cover proxy fetches high resolution with no browser credentials or redirect following', async () => {
  const response = await imageResponse(new Request('https://site.test' + proxy(source) + '&size=1200',
    { headers: { Cookie: 'private', Authorization: 'Bearer private', 'X-API-Key': 'private' } }), source,
    async (target, init) => {
      assert.equal(target, large); assert.equal(init.redirect, 'manual'); assert.equal(init.headers, undefined);
      return new Response('high-resolution-jpeg', { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '20', ETag: 'high-cover' } });
    });
  assert.equal(await response.text(), 'high-resolution-jpeg'); assert.equal(response.headers.get('ETag'), 'high-cover');
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=86400');
});

test('unavailable or redirecting high-resolution variants fall back only to the original allowed image', async () => {
  for (const first of [() => new Response(null, { status: 404 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/private' } }),
    () => new Response('html', { headers: { 'Content-Type': 'text/html' } }),
    () => { throw new Error('synthetic high-resolution network failure'); }]) {
    const targets = [];
    const response = await imageResponse(new Request('https://site.test' + proxy(source) + '&size=1200'), source,
      async target => { targets.push(target); return targets.length === 1 ? first() : new Response('original-image', { headers: { 'Content-Type': 'image/jpeg' } }); });
    assert.deepEqual(targets, [large, source]); assert.equal(await response.text(), 'original-image');
    assert.equal(response.headers.has('Location'), false);
  }
});

test('HEAD, low-resolution thumbnails and invalid size parameters retain explicit behavior', async () => {
  const targets = [];
  const fetcher = async (target, init) => { targets.push(target); return new Response(init.method === 'HEAD' ? null : 'image',
    { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '5' } }); };
  const head = await imageResponse(new Request('https://site.test' + proxy(source) + '&size=1200', { method: 'HEAD' }), source, fetcher);
  assert.equal(await head.text(), ''); assert.equal(head.headers.get('Content-Length'), '5');
  await imageResponse(new Request('https://site.test' + proxy(source)), source, fetcher);
  assert.deepEqual(targets, [large, source]);
  for (const params of ['size=999999', 'size=1200&size=1200']) {
    await assert.rejects(imageResponse(new Request('https://site.test' + proxy(source) + '&' + params), source, fetcher), { code: 'YOUTUBE_INVALID_IMAGE_SIZE' });
  }
  assert.equal(targets.length, 2);
});
