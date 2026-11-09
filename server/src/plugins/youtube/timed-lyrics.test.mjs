import test from 'node:test';
import assert from 'node:assert/strict';
import { Innertube } from 'youtubei.js/cf-worker';
import { fetchTimedLyrics, normalizeTimedLyrics } from './timed-lyrics.mjs';
import { createSessionManager } from './upstream.mjs';
import { createYouTubeService } from './service.mjs';

const id = 'WqkrwFSFeAE';
const payload = lines => ({ contents: { elementRenderer: { newElement: { type: { componentType: {
  model: { timedLyricsModel: { lyricsData: { timedLyricsData: lines, sourceMessage: 'Source attribution' } } },
} } } } } });
const line = (text, start, end) => ({ lyricLine: text,
  cueRange: { startTimeMilliseconds: String(start), endTimeMilliseconds: String(end) } });
const raw = () => payload([line('First line', 2750, 6590), line('Second line', 6590, 11520)]);
const web = () => ({ actions: { execute: async () => ({ contents_memo: { getType: () => [{ endpoint: {
  payload: { browseId: 'MPLYt_native', browseEndpointContextSupportedConfigs: {
    browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' },
  } },
} }] } }) }, music: { getLyrics: async () => ({ description: 'Plain fallback' }) } });

test('native millisecond cues retain actual start/end times and do not invent word timing', () => {
  const result = normalizeTimedLyrics(raw());
  assert.equal(result.source, 'youtube');
  assert.equal(result.syncMode, 'line');
  assert.deepEqual(result.lines, [{ text: 'First line', time: 2.75, endTime: 6.59 },
    { text: 'Second line', time: 6.59, endTime: 11.52 }]);
  assert.equal(result.attribution, 'Source attribution');
  assert.ok(result.lines.every(value => !value.words));
});

test('missing, all-zero, partial or malformed cues remain untimed instead of being treated as synchronization', () => {
  for (const lines of [
    [line('One', 0, 0), line('Two', 0, 0)],
    [line('One', 10, 20), { lyricLine: 'Two' }],
    [line('One', -1, 20)], [line('One', 20, 10)],
    [line('One', 20, 30), line('Two', 5, 10)],
  ]) {
    const result = normalizeTimedLyrics(payload(lines));
    assert.equal(result.syncMode, 'none');
    assert.ok(result.lines.every(value => !Object.hasOwn(value, 'time')));
  }
  assert.equal(normalizeTimedLyrics({ contents: {} }), null);
  assert.equal(normalizeTimedLyrics(payload([])), null);
  assert.throws(() => normalizeTimedLyrics(payload([{ lyricLine: 'a'.repeat(4001) }])));
});

test('SDK raw browse reuses the next lyrics pointer without passing the obsolete mobile client alias', async () => {
  let call;
  const result = await fetchTimedLyrics(web(), { actions: { execute: async (...args) => {
    call = args; return { data: raw() };
  } } }, id);
  assert.equal(result.syncMode, 'line');
  assert.deepEqual(call, ['/browse', { browseId: 'MPLYt_native', parse: false }]);
});

test('the isolated anonymous mobile session preserves 7.21.50 in the real SDK HTTP request', async () => {
  const calls = [];
  const manager = createSessionManager({ env: {}, createSession: options => Innertube.create({ ...options,
    generate_session_locally: true, fetch: async (input, init) => {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
      calls.push({ headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(raw()), { headers: { 'Content-Type': 'application/json' } });
    },
  }) });
  const guest = await manager.guest('en');
  const before = structuredClone(guest.session.context.client);
  const mobile = await manager.musicMobile('en');
  await mobile.actions.execute('/browse', { browseId: 'MPLYt_native', parse: false });
  assert.deepEqual(guest.session.context.client, before);
  assert.notEqual(mobile, guest);
  assert.equal(calls[0].body.context.client.clientName, 'ANDROID_MUSIC');
  assert.equal(calls[0].body.context.client.clientVersion, '7.21.50');
  assert.equal(calls[0].headers.get('X-Youtube-Client-Version'), '7.21.50');
  assert.equal(calls[0].headers.get('X-Youtube-Client-Name'), '21');
  assert.equal(calls[0].headers.has('Authorization'), false);
});

test('service returns native line timing and retains WEB text fallback when mobile timing is unavailable', async () => {
  for (const available of [true, false]) {
    const guest = web(); let fallbackCalls = 0;
    guest.music.getLyrics = async () => { fallbackCalls++; return { description: 'Plain fallback' }; };
    const service = createYouTubeService({ env: {}, services: { player: {}, manager: {
      guest: async () => guest, musicMobile: async () => ({ actions: { execute: async () => {
        if (!available) throw new Error('private upstream failure');
        return { data: raw() };
      } } }),
    } } });
    const result = await service.lyrics(id);
    assert.equal(result.syncMode, available ? 'line' : 'none');
    assert.equal(fallbackCalls, available ? 0 : 1);
  }
});

test('transient mobile timing failure plus missing WEB text stays an error instead of a confirmed miss', async () => {
  for (const plain of [async () => undefined, async () => { throw new Error('Lyrics not available.'); }]) {
    const guest = web(); guest.music.getLyrics = plain;
    const service = createYouTubeService({ env: {}, services: { player: {}, manager: {
      guest: async () => guest, musicMobile: async () => ({ actions: { execute: async () => {
        throw new Error('private mobile network failure');
      } } }),
    } } });
    await assert.rejects(service.lyrics(id), error => error.code === 'YOUTUBE_LYRICS_UNAVAILABLE'
      && !error.message.includes('private'));
  }
});
