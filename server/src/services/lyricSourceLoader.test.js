import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createLyricDocument } from '../utils/lyricDocument.js';
import {
  LyricSourceError,
  createCachedSourceDocumentFetcher,
  createLyricSourceLoader,
  createSingleFlightDocumentFetcher,
  buildKugouSearchKeyword,
  buildKugouSearchKeywords,
  decodeKrcContent,
  fetchLyricsAuditEvidenceWithFallback,
  fetchLyricsDocumentWithFallback,
  parseKrcLyrics,
  parseLyricsfile,
  resolveLyricSourceOrder,
} from './lyricSourceLoader.js';

const SONG = { id: 'song-1', title: '夜航', artist: '歌手甲、歌手乙', album: '夜航集', duration: 200 };
const KRC_KEY = Uint8Array.from([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]);

const encodeKrc = (text) => {
  const compressed = deflateSync(Buffer.from(text, 'utf8'));
  const encrypted = Uint8Array.from(compressed, (byte, index) => byte ^ KRC_KEY[index % KRC_KEY.length]);
  return Buffer.concat([Buffer.from('krc1'), Buffer.from(encrypted)]).toString('base64');
};

const encodeKrcLanguage = (content) => Buffer.from(JSON.stringify({
  version: 1,
  content,
}), 'utf8').toString('base64');

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

const lineDocument = (source, text = 'line') => createLyricDocument({
  source,
  format: 'lrc',
  lines: [{ time: 1, text }],
});

const wordDocument = (source, text = 'word') => createLyricDocument({
  source,
  format: source === 'kugou' ? 'krc' : 'lyricsfile',
  lines: [{
    time: 1,
    endTime: 2,
    text,
    words: [{ text, startTime: 1, endTime: 2 }],
  }],
});

test('KRC decoder verifies krc1, XOR-decrypts, inflates, and parser preserves absolute word timing', async () => {
  const source = '[offset:100]\n[1000,1200]<0,400,0>Hello <400,800,0>world';
  assert.equal(await decodeKrcContent(encodeKrc(source)), source);
  const document = parseKrcLyrics(source);
  assert.equal(document.syncMode, 'word');
  assert.deepEqual(document.lines[0], {
    time: 1.1,
    endTime: 2.3,
    text: 'Hello world',
    words: [
      { text: 'Hello ', startTime: 1.1, endTime: 1.5 },
      { text: 'world', startTime: 1.5, endTime: 2.3 },
    ],
  });
  await assert.rejects(() => decodeKrcContent(Buffer.from('not-krc').toString('base64')), {
    name: 'LyricSourceError', kind: 'invalid', stage: 'decode-krc',
  });
});

test('KRC parser aligns type=1 translations to canonical lines and ignores type=0 romanization', () => {
  const language = encodeKrcLanguage([
    { type: 0, language: 0, lyricContent: [['Bokura wa ima'], ['Kutsu o nugu']] },
    { type: 1, language: 0, lyricContent: [['现在我们'], ['脱下鞋子']] },
  ]);
  const document = parseKrcLyrics([
    `[language:${language}]`,
    '[1000,1000]<0,1000,0>僕らは今',
    '[2000,1000]<0,1000,0>靴を脱ぐ',
  ].join('\n'));

  assert.equal(document.syncMode, 'word');
  assert.deepEqual(document.lines.map((line) => line.tlyric), ['现在我们', '脱下鞋子']);
  assert.equal(JSON.stringify(document).includes('Bokura wa ima'), false);
});

test('KRC parser exempts leading metadata and credit lines from requiring translation', () => {
  const language = encodeKrcLanguage([{
    type: 1,
    lyricContent: [
      [''],
      [''],
      [''],
      ['如果这是一场梦该有多好'],
      ['至今你依然是我的光芒'],
    ],
  }]);
  const document = parseKrcLyrics([
    `[language:${language}]`,
    '[0,1000]<0,1000,0>Lemon',
    '[1000,1000]<0,1000,0>米津玄師',
    '[2000,1000]<0,1000,0>作词/作曲：米津玄師',
    '[5000,2000]<0,1000,0>夢ならば<1000,1000,0>よかった',
    '[8000,2000]<0,1000,0>わたしの<1000,1000,0>光',
  ].join('\n'), {
    providerMeta: { matchedTitle: 'Lemon', matchedArtist: '米津玄師' },
  });

  assert.equal(document.syncMode, 'word');
  assert.equal(document.lines[0].tlyric, undefined);
  assert.equal(document.lines[1].tlyric, undefined);
  assert.equal(document.lines[2].tlyric, undefined);
  assert.equal(document.lines[3].tlyric, '如果这是一场梦该有多好');
  assert.equal(document.lines[4].tlyric, '至今你依然是我的光芒');
});

test('damaged, misaligned, or type=0-only KRC language blocks never discard original lyrics', () => {
  const original = [
    '[1000,1000]<0,1000,0>僕らは今',
    '[2000,1000]<0,1000,0>靴を脱ぐ',
  ].join('\n');
  const cases = [
    '%%%',
    Buffer.from('{broken', 'utf8').toString('base64'),
    encodeKrcLanguage([{ type: 1, lyricContent: [['只有一行']] }]),
    encodeKrcLanguage([{ type: 1, lyricContent: [['第一行'], [42]] }]),
    encodeKrcLanguage([{ type: 1, lyricContent: [['第一行'], ['']] }]),
    encodeKrcLanguage([{ type: 0, lyricContent: [['Bokura'], ['Kutsu']] }]),
  ];

  for (const encoded of cases) {
    const document = parseKrcLyrics(`[language:${encoded}]\n${original}`);
    assert.deepEqual(document.lines.map((line) => line.text), ['僕らは今', '靴を脱ぐ']);
    assert.equal(document.lines.some((line) => line.tlyric), false);
  }
});

test('Kugou adapter uses HTTPS duration-aware search and fmt=krc without exposing accesskey', async () => {
  const urls = [];
  const inits = [];
  const content = encodeKrc('[1000,1200]<0,400,0>Hello <400,800,0>world');
  const loader = createLyricSourceLoader({
    fetchImpl: async (url, init) => {
      urls.push(url);
      inits.push(init);
      if (urls.length === 1) return jsonResponse({ candidates: [
        { id: 'lyric-id', accesskey: 'secret', song: '夜航', singer: '歌手甲、歌手乙', duration: 200_400 },
      ] });
      return jsonResponse({ content });
    },
  });

  const document = await loader.getKugouDocument(SONG);
  assert.equal(document.syncMode, 'word');
  assert.equal(document.providerMeta.providerLyricId, 'lyric-id');
  assert.equal(JSON.stringify(document).includes('secret'), false);
  assert.equal(urls.length, 2);
  const searchUrl = new URL(urls[0]);
  assert.equal(searchUrl.protocol, 'https:');
  assert.equal(searchUrl.pathname, '/search');
  assert.equal(searchUrl.searchParams.get('duration'), '200000');
  assert.equal(searchUrl.searchParams.get('keyword'), '歌手甲、歌手乙-夜航');
  const downloadUrl = new URL(urls[1]);
  assert.equal(downloadUrl.searchParams.get('fmt'), 'krc');
  assert.equal(inits[0].headers['User-Agent'], undefined);
});

test('candidate inspection snapshot searches once and retains private download credentials only in its closure', async () => {
  const urls = [];
  const content = encodeKrc('[1000,900]<0,900,0>Night');
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      urls.push(url);
      if (new URL(url).pathname === '/search') return jsonResponse({ candidates: [
        { id: 'lyric-a', accesskey: 'private-a', song: '夜航', singer: '歌手甲、歌手乙', duration: 200_000 },
        { id: 'lyric-b', accesskey: 'private-b', song: '夜航', singer: '歌手甲、歌手乙', duration: 200_100 },
      ] });
      return jsonResponse({ content });
    },
  });
  const snapshot = await loader.createCandidateInspectionSnapshot('kugou', SONG);
  assert.deepEqual(snapshot.providerLyricIds, ['lyric-a', 'lyric-b']);
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
  assert.equal((await snapshot.loadDocument('lyric-a')).providerMeta.providerLyricId, 'lyric-a');
  assert.equal((await snapshot.loadDocument('lyric-b')).providerMeta.providerLyricId, 'lyric-b');
  assert.equal(urls.filter((url) => new URL(url).pathname === '/search').length, 1);
  assert.equal(urls.filter((url) => new URL(url).pathname === '/download').length, 2);
});

test('buildKugouSearchKeyword prefers artist-title for high recall without space tokenization failure', () => {
  assert.equal(buildKugouSearchKeyword({ title: '搁浅', artist: '周杰伦' }), '周杰伦-搁浅');
  assert.equal(buildKugouSearchKeyword({ title: '夜航', artist: '歌手甲、歌手乙' }), '歌手甲、歌手乙-夜航');
  assert.equal(buildKugouSearchKeyword({ title: '纯音乐' }), '纯音乐');
  assert.equal(buildKugouSearchKeyword({ title: '纯音乐', artist: '' }), '纯音乐');
  assert.equal(buildKugouSearchKeyword({}), '');
});

test('Kugou query variants remove translated/version suffixes and normalize multiple artists', () => {
  assert.deepEqual(buildKugouSearchKeywords({
    title: 'Под луной (月下) [Live]',
    artist: 'Miyagi & Andy Panda',
  }), [
    'Miyagi & Andy Panda-Под луной (月下) [Live]',
    'Miyagi & Andy Panda-Под луной',
    'Miyagi、Andy Panda-Под луной',
    'Miyagi-Под луной',
  ]);
});

test('Kugou retries a simplified query and keeps a large duration mismatch as a warning', async () => {
  const urls = [];
  const content = encodeKrc('[1000,1000]<0,1000,0>Я вижу луну');
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/search') {
        if (parsed.searchParams.get('keyword').includes('(月下)')) {
          return jsonResponse({ candidates: [] });
        }
        return jsonResponse({ candidates: [{
          id: 'short-duration', accesskey: 'secret', song: 'Под луной',
          singer: 'Miyagi & Andy Panda', duration: 43_000,
        }] });
      }
      return jsonResponse({ content });
    },
  });
  const document = await loader.getKugouDocument({
    title: 'Под луной (月下)', artist: 'Miyagi & Andy Panda', duration: 255,
  });
  assert.equal(urls.length, 3);
  assert.equal(new URL(urls[0]).searchParams.get('keyword'), 'Miyagi & Andy Panda-Под луной (月下)');
  assert.equal(new URL(urls[1]).searchParams.get('keyword'), 'Miyagi & Andy Panda-Под луной');
  assert.equal(document.providerMeta.durationDelta, 212);
  assert.equal(document.providerMeta.matchedDuration, 43);
});

test('candidate discovery exposes only safe ranked metadata and a requested Kugou id is re-searched before download', async () => {
  const urls = [];
  const content = encodeKrc('[1000,1000]<0,1000,0>chosen');
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      urls.push(url);
      if (new URL(url).pathname === '/search') return jsonResponse({ candidates: [
        { id: 'best', accesskey: 'best-secret', song: '夜航', singer: '歌手甲、歌手乙', album: '夜航集', duration: 200_000 },
        { id: 'chosen', accesskey: 'chosen-secret', song: '夜航', singer: '歌手甲、歌手乙', album: '另一专辑', duration: 200_500 },
        { id: 'wrong-artist', accesskey: 'wrong-secret', song: '夜航', singer: '另一位歌手', duration: 200_000 },
      ] });
      return jsonResponse({ content });
    },
  });
  const candidates = await loader.listSourceCandidates('kugou', SONG);
  assert.deepEqual(candidates.map(({ providerLyricId }) => providerLyricId), ['best', 'chosen']);
  assert.deepEqual(candidates[1], {
    source: 'kugou',
    providerLyricId: 'chosen',
    matchedTitle: '夜航',
    matchedArtist: '歌手甲、歌手乙',
    matchedAlbum: '另一专辑',
    matchedDuration: 200.5,
    durationDelta: 0.5,
    versionMismatch: false,
    score: 174.6,
  });
  assert.equal(JSON.stringify(candidates).includes('secret'), false);

  urls.length = 0;
  const document = await loader.getKugouDocument(SONG, { providerLyricId: 'chosen' });
  assert.equal(document.providerMeta.providerLyricId, 'chosen');
  assert.equal(new URL(urls[1]).searchParams.get('id'), 'chosen');
  assert.equal(new URL(urls[1]).searchParams.get('accesskey'), 'chosen-secret');
  await assert.rejects(() => loader.getKugouDocument(SONG, { providerLyricId: 'gone' }), {
    name: 'LyricSourceError', kind: 'unavailable', stage: 'override-candidate',
  });
  await assert.rejects(() => loader.getKugouDocument(SONG, { providerLyricId: 'wrong-artist' }), {
    name: 'LyricSourceError', kind: 'unavailable', stage: 'override-candidate',
  });
});

test('Kugou audit evidence downloads the top candidate from its one ranked search snapshot', async () => {
  const urls = [];
  const content = encodeKrc('[1000,1000]<0,1000,0>selected');
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      urls.push(url);
      if (new URL(url).pathname === '/search') return jsonResponse({ candidates: [
        { id: 'selected', accesskey: 'selected-secret', song: '夜航', singer: '歌手甲、歌手乙', album: '夜航集', duration: 200_000 },
        { id: 'runner-up', accesskey: 'runner-secret', song: '夜航', singer: '歌手甲、歌手乙', album: '别集', duration: 200_500 },
      ] });
      return jsonResponse({ content });
    },
  });

  const evidence = await loader.fetchSourceAuditEvidence('kugou', SONG);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).pathname, '/search');
  assert.equal(new URL(urls[1]).pathname, '/download');
  assert.equal(new URL(urls[1]).searchParams.get('id'), 'selected');
  assert.equal(new URL(urls[1]).searchParams.get('accesskey'), 'selected-secret');
  assert.equal(evidence.document.providerMeta.providerLyricId, 'selected');
  assert.equal(evidence.selectedProviderLyricId, 'selected');
  assert.equal(evidence.candidates[0].providerLyricId, 'selected');
  assert.deepEqual(Object.keys(evidence.candidates[0]).sort(), [
    'durationDelta', 'providerLyricId', 'score', 'source',
  ]);
  assert.equal(JSON.stringify(evidence.candidates).includes('secret'), false);
  assert.equal(JSON.stringify(evidence.candidates).includes('selected-secret'), false);
});

test('Kugou invalid KRC falls back to the selected candidate LRC', async () => {
  const urls = [];
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      urls.push(url);
      if (urls.length === 1) return jsonResponse({ candidates: [
        { id: 'lyric-id', accesskey: 'secret', song: '夜航', singer: '歌手甲、歌手乙', duration: 200_000 },
      ] });
      if (urls.length === 2) return jsonResponse({ content: Buffer.from('broken').toString('base64') });
      return jsonResponse({ content: Buffer.from('[00:01.00]line fallback', 'utf8').toString('base64') });
    },
  });
  const document = await loader.getKugouDocument(SONG);
  assert.equal(document.syncMode, 'line');
  assert.equal(document.lines[0].text, 'line fallback');
  assert.equal(new URL(urls[2]).searchParams.get('fmt'), 'lrc');
});

test('Kugou preserves an actionable KRC error when its LRC backup is unavailable', async () => {
  let calls = 0;
  const loader = createLyricSourceLoader({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ candidates: [
        { id: 'lyric-id', accesskey: 'secret', song: '夜航', singer: '歌手甲、歌手乙', duration: 200_000 },
      ] });
      if (calls === 2) return jsonResponse({ content: Buffer.from('broken').toString('base64') });
      return jsonResponse({}, 404);
    },
  });
  await assert.rejects(() => loader.getKugouDocument(SONG), {
    name: 'LyricSourceError', kind: 'invalid', stage: 'decode-krc',
  });
  assert.equal(calls, 3);
});

test('KRC parser rejects any suspicious damaged timed line instead of returning a partial document', () => {
  const valid = '[1000,1000]<0,1000,0>valid';
  for (const damaged of [
    '[2000,broken]<0,1000,0>bad',
    '[-1,1000]<0,1000,0>bad',
    '[2000,1000<0,1000,0>bad',
    '[2000,1000]<broken>tag',
    '[2000,1000]<-1,1000,0>bad',
    '[2000,1000]<0,1000,bad>bad',
    '[2000,1000]<0,1000,0,extra>bad',
  ]) {
    assert.throws(() => parseKrcLyrics(`${valid}\n${damaged}`), {
      name: 'LyricSourceError', kind: 'invalid', stage: 'parse-krc',
    });
  }
  const withMetadata = parseKrcLyrics(`[ar:歌手甲]\n[language:e30=]\n${valid}`);
  assert.equal(withMetadata.syncMode, 'word');
  assert.equal(withMetadata.lines.length, 1);
  const indented = parseKrcLyrics(`  ${valid}`);
  assert.equal(indented.lines[0].text, 'valid');
});

test('Lyricsfile parser derives only deterministic missing word ends and downgrades an unknowable last end', () => {
  const complete = parseLyricsfile(`
version: '1.0'
metadata:
  title: 夜航
  artist: 歌手甲
lines:
  - text: '僕らは今'
    start_ms: 1000
    end_ms: 2200
    words:
      - text: '僕らは'
        start_ms: 1000
      - text: '今'
        start_ms: 1800
`);
  assert.equal(complete.syncMode, 'word');
  assert.deepEqual(complete.lines[0].words, [
    { text: '僕らは', startTime: 1, endTime: 1.8 },
    { text: '今', startTime: 1.8, endTime: 2.2 },
  ]);

  const incomplete = parseLyricsfile(`
version: '1.0'
metadata: { title: 夜航, artist: 歌手甲 }
lines:
  - text: '僕らは今'
    start_ms: 1000
    words:
      - { text: '僕らは', start_ms: 1000 }
      - { text: '今', start_ms: 1800 }
`);
  assert.equal(incomplete.syncMode, 'line');
  assert.equal(incomplete.lines[0].words, undefined);
});

test('LRCLIB adapter prefers exact get Lyricsfile and sends album/duration/client identity', async () => {
  const seen = [];
  const loader = createLyricSourceLoader({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({
        id: 12,
        trackName: '夜航',
        artistName: '歌手甲、歌手乙',
        albumName: '夜航集',
        duration: 200.1,
        lyricsfile: `version: '1.0'\nmetadata: { title: 夜航, artist: 歌手甲 }\nlines:\n  - text: 'AB'\n    start_ms: 1000\n    end_ms: 2000\n    words:\n      - { text: 'A', start_ms: 1000 }\n      - { text: 'B', start_ms: 1500 }`,
      });
    },
  });
  const document = await loader.getLrclibDocument(SONG);
  assert.equal(document.syncMode, 'word');
  assert.equal(seen.length, 1);
  const url = new URL(seen[0].url);
  assert.equal(url.pathname, '/api/get');
  assert.equal(url.searchParams.get('album_name'), '夜航集');
  assert.equal(url.searchParams.get('duration'), '200');
  assert.equal(seen[0].init.headers['Lrclib-Client'], 'FlareTune');
  assert.equal(seen[0].init.headers['User-Agent'], 'FlareTune/1.0.0');
});

test('LRCLIB 404 uses scored search rather than taking the first result', async () => {
  let calls = 0;
  const loader = createLyricSourceLoader({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 404);
      return jsonResponse([
        { id: 1, trackName: '夜航 (Live)', artistName: '歌手甲、歌手乙', duration: 200, syncedLyrics: '[00:01.00]wrong' },
        { id: 2, trackName: '夜航', artistName: '歌手甲、歌手乙', duration: 200.2, syncedLyrics: '[00:01.00]right' },
      ]);
    },
  });
  const document = await loader.getLrclibDocument(SONG);
  assert.equal(calls, 2);
  assert.equal(document.lines[0].text, 'right');
  assert.equal(document.providerMeta.providerLyricId, '2');
});

test('LRCLIB automatic resolution tries the next reliable candidate when the top result has no lyrics', async () => {
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => new URL(url).pathname === '/api/get'
      ? jsonResponse({}, 404)
      : jsonResponse([
        { id: 1, trackName: '夜航', artistName: '歌手甲、歌手乙', duration: 200.1 },
        { id: 2, trackName: '夜航', artistName: '歌手甲、歌手乙', duration: 200.2,
          syncedLyrics: '[00:01.00]usable lyric' },
      ]),
  });
  const document = await loader.getLrclibDocument(SONG);
  assert.equal(document.providerMeta.providerLyricId, '2');
  assert.equal(document.lines[0].text, 'usable lyric');
});

test('LRCLIB automatic resolution checks search when the exact response has a title-version difference', async () => {
  const paths = [];
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/api/get') return jsonResponse({
        id: 'shared',
        trackName: '夜航 (Live)',
        artistName: '歌手甲、歌手乙',
        duration: 200,
        syncedLyrics: '[00:01.00]unreliable exact',
      });
      return jsonResponse([{
        id: 'shared',
        trackName: '夜航',
        artistName: '歌手甲、歌手乙',
        duration: 200,
        syncedLyrics: '[00:01.00]reliable search',
      }]);
    },
  });

  const document = await loader.getLrclibDocument(SONG);
  assert.deepEqual(paths, ['/api/get', '/api/search']);
  assert.equal(document.providerMeta.providerLyricId, 'shared');
  assert.equal(document.lines[0].text, 'reliable search');
});

test('LRCLIB audit evidence merges exact and search before one selection snapshot', async () => {
  const paths = [];
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/api/get') return jsonResponse({
        id: 'exact',
        trackName: '夜航',
        artistName: '歌手甲、歌手乙',
        albumName: '别集',
        duration: 200.5,
        syncedLyrics: '[00:01.00]exact result',
      });
      return jsonResponse([
        {
          id: 'search-best',
          trackName: '夜航',
          artistName: '歌手甲、歌手乙',
          albumName: '夜航集',
          duration: 200,
          syncedLyrics: '[00:01.00]search selected',
        },
        {
          id: 'exact',
          trackName: '夜航',
          artistName: '歌手甲、歌手乙',
          albumName: '夜航集',
          duration: 200.5,
          syncedLyrics: '[00:01.00]duplicate must not replace exact',
        },
      ]);
    },
  });

  const evidence = await loader.fetchSourceAuditEvidence('lrclib', SONG);
  assert.deepEqual(paths, ['/api/get', '/api/search']);
  assert.deepEqual(evidence.candidates.map(({ providerLyricId }) => providerLyricId), ['search-best', 'exact']);
  assert.equal(evidence.selectedProviderLyricId, 'exact');
  assert.equal(evidence.document.providerMeta.providerLyricId, 'exact');
  assert.equal(evidence.candidates.some(({ providerLyricId }) => (
    providerLyricId === evidence.selectedProviderLyricId
  )), true);
  assert.equal(evidence.document.lines[0].text, 'exact result');
  assert.equal(JSON.stringify(evidence.candidates).includes('search selected'), false);
  assert.equal(JSON.stringify(evidence.candidates).includes('夜航'), false);
});

test('audit evidence preserves no-candidate and provider-error semantics', async (t) => {
  await t.test('empty Kugou ranking is unavailable', async () => {
    const loader = createLyricSourceLoader({ fetchImpl: async () => jsonResponse({ candidates: [] }) });
    await assert.rejects(() => loader.fetchSourceAuditEvidence('kugou', SONG), {
      name: 'LyricSourceError', kind: 'unavailable', provider: 'kugou', stage: 'match',
    });
  });

  await t.test('LRCLIB search failure is not converted to an empty ambiguity snapshot', async () => {
    const loader = createLyricSourceLoader({
      fetchImpl: async (url) => (new URL(url).pathname === '/api/get'
        ? jsonResponse({
          id: 'exact', trackName: '夜航', artistName: '歌手甲、歌手乙', duration: 200,
          syncedLyrics: '[00:01.00]exact',
        })
        : jsonResponse({}, 503)),
    });
    await assert.rejects(() => loader.fetchSourceAuditEvidence('lrclib', SONG), {
      name: 'LyricSourceError', kind: 'upstream', provider: 'lrclib', stage: 'search',
    });
  });
});

test('requested LRCLIB candidate id is selected only from a fresh scored search', async () => {
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, '/api/search');
      return jsonResponse([
        { id: 1, trackName: '夜航', artistName: '歌手甲、歌手乙', albumName: '夜航集', duration: 200, syncedLyrics: '[00:01.00]best' },
        { id: 2, trackName: '夜航', artistName: '歌手甲、歌手乙', albumName: '别集', duration: 200.2, syncedLyrics: '[00:01.00]chosen' },
      ]);
    },
  });
  const document = await loader.getLrclibDocument(SONG, { providerLyricId: '2' });
  assert.equal(document.providerMeta.providerLyricId, '2');
  assert.equal(document.lines[0].text, 'chosen');
  await assert.rejects(() => loader.getLrclibDocument(SONG, { providerLyricId: '3' }), {
    name: 'LyricSourceError', kind: 'unavailable', stage: 'override-candidate',
  });
});

test('LRCLIB preserves malformed Lyricsfile errors unless a legacy representation succeeds', async () => {
  const candidate = {
    id: 12,
    trackName: '夜航',
    artistName: '歌手甲、歌手乙',
    albumName: '夜航集',
    duration: 200,
    lyricsfile: 'version: [broken',
  };
  const broken = createLyricSourceLoader({ fetchImpl: async () => jsonResponse(candidate) });
  await assert.rejects(() => broken.getLrclibDocument(SONG), {
    name: 'LyricSourceError', kind: 'invalid', stage: 'parse-lyricsfile',
  });

  const recovered = createLyricSourceLoader({
    fetchImpl: async () => jsonResponse({ ...candidate, syncedLyrics: '[00:01.00]legacy works' }),
  });
  const document = await recovered.getLrclibDocument(SONG);
  assert.equal(document.syncMode, 'line');
  assert.equal(document.lines[0].text, 'legacy works');
});

test('auto fallback selects the best usable document, locks explicit source, and returns null for none', async () => {
  const calls = [];
  const documents = { kugou: lineDocument('kugou', 'kg line'), lrclib: wordDocument('lrclib', 'lr word') };
  const resolver = async (provider) => {
    calls.push(provider);
    return documents[provider];
  };
  assert.equal((await fetchLyricsDocumentWithFallback('auto', SONG, resolver)).source, 'lrclib');
  assert.deepEqual(calls, ['kugou', 'netease', 'lrclib']);

  calls.length = 0;
  documents.kugou = null;
  documents.lrclib = lineDocument('lrclib', 'lr line');
  assert.equal((await fetchLyricsDocumentWithFallback('auto', SONG, resolver)).source, 'lrclib');
  assert.deepEqual(calls, ['kugou', 'netease', 'lrclib']);

  calls.length = 0;
  documents.kugou = lineDocument('kugou', 'kg line');
  assert.equal((await fetchLyricsDocumentWithFallback('kugou', SONG, resolver)).source, 'kugou');
  assert.deepEqual(calls, ['kugou']);
  assert.equal(await fetchLyricsDocumentWithFallback('auto', SONG, async () => null), null);
  assert.equal(await fetchLyricsDocumentWithFallback('auto', SONG, async (provider) => createLyricDocument({
    source: provider, format: 'plain', lines: [],
  })), null);
  assert.equal(await fetchLyricsDocumentWithFallback('auto', SONG, async (provider) => createLyricDocument({
    source: provider, format: 'plain', lines: [{ text: 'Lyrics by: Someone', tlyric: '署名' }],
  })), null);
  assert.equal(await fetchLyricsDocumentWithFallback('auto', SONG, async (provider) => createLyricDocument({
    source: provider, format: 'plain', providerMeta: { matchedTitle: SONG.title },
    lines: [{ text: SONG.title, tlyric: '歌名' }],
  })), null);
  await assert.rejects(() => fetchLyricsDocumentWithFallback('auto', SONG, async () => ({ source: 'forged' })), {
    name: 'LyricSourceError', kind: 'invalid',
  });
  await assert.rejects(() => fetchLyricsDocumentWithFallback('kugou', SONG, async () => lineDocument('lrclib')), {
    name: 'LyricSourceError', kind: 'invalid', provider: 'kugou',
  });
  await assert.rejects(() => fetchLyricsDocumentWithFallback('auto', SONG, async (provider) => {
    if (provider === 'kugou') throw new LyricSourceError('timeout', provider, 'search', 'timeout');
    return null;
  }), { name: 'LyricSourceError', kind: 'timeout', provider: 'multiple' });
  assert.equal((await fetchLyricsDocumentWithFallback('auto', SONG, async (provider) => {
    if (provider === 'lrclib') throw new LyricSourceError('timeout', provider, 'get', 'timeout');
    return lineDocument('kugou');
  })).source, 'kugou');
});

test('automatic resolution rejects a mismatched word version before ranking lyric quality', async () => {
  const mismatched = wordDocument('kugou', 'wrong live words');
  mismatched.providerMeta = { versionMismatch: true, durationDelta: 24 };
  const matching = lineDocument('lrclib', 'matching studio line');
  matching.providerMeta = { durationDelta: 1 };
  const resolve = async (provider) => ({ kugou: mismatched, lrclib: matching })[provider] || null;
  const result = await fetchLyricsDocumentWithFallback('auto', SONG, resolve);
  assert.equal(result.source, 'lrclib');
  assert.equal(await fetchLyricsDocumentWithFallback('auto', SONG,
    async (provider) => provider === 'kugou' ? mismatched : null), null);
  mismatched.providerMeta = { durationDelta: 14 };
  assert.equal((await fetchLyricsDocumentWithFallback('auto', SONG, resolve)).source, 'lrclib');
  assert.equal((await fetchLyricsDocumentWithFallback('kugou', SONG, resolve)).source, 'kugou');
});

test('audit fallback keeps the chosen document paired with its source snapshot', async () => {
  const calls = [];
  const evidenceFor = (source, syncMode) => {
    const providerLyricId = `${source}-selected`;
    const document = createLyricDocument({
      source,
      format: syncMode === 'word' ? (source === 'kugou' ? 'krc' : 'lyricsfile') : 'lrc',
      lines: syncMode === 'word'
        ? [{
          time: 1,
          endTime: 2,
          text: 'word',
          words: [{ text: 'word', startTime: 1, endTime: 2 }],
        }]
        : [{ time: 1, text: 'line' }],
      providerMeta: { providerLyricId },
    });
    return {
      document,
      candidates: [{ source, providerLyricId, durationDelta: 0, score: 175 }],
      selectedProviderLyricId: providerLyricId,
    };
  };
  const result = await fetchLyricsAuditEvidenceWithFallback('auto', SONG, async (provider) => {
    calls.push(provider);
    return evidenceFor(provider, provider === 'lrclib' ? 'word' : 'line');
  });
  assert.deepEqual(calls, ['kugou', 'netease', 'lrclib']);
  assert.equal(result.document.source, 'lrclib');
  assert.equal(result.candidates[0].source, 'lrclib');
  assert.equal(result.document.providerMeta.providerLyricId, result.selectedProviderLyricId);
  assert.equal(result.candidates[0].providerLyricId, result.selectedProviderLyricId);

  await assert.rejects(() => fetchLyricsAuditEvidenceWithFallback(
    'kugou',
    SONG,
    async () => ({
      ...evidenceFor('kugou', 'line'),
      candidates: [{ source: 'kugou', providerLyricId: 'different', durationDelta: 0, score: 175 }],
    }),
  ), { name: 'LyricSourceError', kind: 'invalid', provider: 'kugou', stage: 'fallback' });
  assert.equal(await fetchLyricsAuditEvidenceWithFallback('auto', SONG, async () => null), null);
});

test('single-flight shares only concurrent work and bounded cache applies distinct word, line, and negative TTLs', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const singleFlight = createSingleFlightDocumentFetcher(async () => {
    calls += 1;
    await pending;
    return wordDocument('kugou');
  });
  const first = singleFlight('kugou', SONG);
  const second = singleFlight('kugou', { ...SONG });
  release();
  assert.equal(await first, await second);
  assert.equal(calls, 1);
  await singleFlight('kugou', SONG);
  assert.equal(calls, 2);

  let now = 1_000;
  let mode = 'word';
  let cacheCalls = 0;
  const cached = createCachedSourceDocumentFetcher(async (provider) => {
    cacheCalls += 1;
    if (mode === 'none') return null;
    return mode === 'word' ? wordDocument(provider) : lineDocument(provider);
  }, { now: () => now, wordTtlMs: 100, lineTtlMs: 50, negativeTtlMs: 10, maxEntries: 2 });
  await cached('kugou', SONG);
  await cached('kugou', SONG);
  assert.equal(cacheCalls, 1);
  now += 101;
  mode = 'line';
  await cached('kugou', SONG);
  now += 51;
  mode = 'none';
  await cached('kugou', SONG);
  await cached('kugou', SONG);
  assert.equal(cacheCalls, 3);
  now += 11;
  await cached('kugou', SONG);
  assert.equal(cacheCalls, 4);

  let unavailableCalls = 0;
  const negativeCached = createCachedSourceDocumentFetcher(async () => {
    unavailableCalls += 1;
    throw new LyricSourceError('unavailable', 'kugou', 'match', 'none');
  }, { now: () => now, negativeTtlMs: 10 });
  assert.equal(await negativeCached('kugou', SONG), null);
  assert.equal(await negativeCached('kugou', SONG), null);
  assert.equal(unavailableCalls, 1);
  now += 11;
  assert.equal(await negativeCached('kugou', SONG), null);
  assert.equal(unavailableCalls, 2);

  let timeoutCalls = 0;
  const notCached = createCachedSourceDocumentFetcher(async () => {
    timeoutCalls += 1;
    throw new LyricSourceError('timeout', 'kugou', 'search', 'timeout');
  }, { now: () => now });
  await assert.rejects(() => notCached('kugou', SONG), { kind: 'timeout' });
  await assert.rejects(() => notCached('kugou', SONG), { kind: 'timeout' });
  assert.equal(timeoutCalls, 2);
});

test('document cache isolates override candidates and revisions and invalidates every variant for a song', async () => {
  let calls = 0;
  const cached = createCachedSourceDocumentFetcher(async (provider, _song, options) => {
    calls += 1;
    return createLyricDocument({
      source: provider,
      format: 'lrc',
      providerMeta: { providerLyricId: options.providerLyricId || 'best' },
      lines: [{ time: 1, text: options.providerLyricId || 'best' }],
    });
  });
  await cached('kugou', SONG, { providerLyricId: 'one', cacheScope: 'override:1' });
  await cached('kugou', SONG, { providerLyricId: 'one', cacheScope: 'override:1' });
  await cached('kugou', SONG, { providerLyricId: 'two', cacheScope: 'override:1' });
  await cached('kugou', SONG, { providerLyricId: 'one', cacheScope: 'override:2' });
  assert.equal(calls, 3);
  assert.equal(cached.invalidateSong('song-1'), 3);
  await cached('kugou', SONG, { providerLyricId: 'one', cacheScope: 'override:1' });
  assert.equal(calls, 4);
});

test('document cache invalidation isolates new work from an older pending request and blocks stale refill', async () => {
  const releases = [];
  let calls = 0;
  const singleFlight = createSingleFlightDocumentFetcher(async (provider) => {
    const call = ++calls;
    return new Promise((resolve) => {
      releases[call - 1] = () => resolve(lineDocument(provider, `call-${call}`));
    });
  });
  const cached = createCachedSourceDocumentFetcher(singleFlight);

  const beforeInvalidation = cached('kugou', SONG);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  cached.invalidateSong(SONG.id);

  const afterInvalidation = cached('kugou', SONG);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, 'post-invalidation work must not join the old single-flight');

  releases[1]();
  assert.equal((await afterInvalidation).lines[0].text, 'call-2');
  releases[0]();
  assert.equal((await beforeInvalidation).lines[0].text, 'call-1');

  assert.equal((await cached('kugou', SONG)).lines[0].text, 'call-2');
  assert.equal(calls, 2, 'the stale completion must not overwrite the new cached document');
});

test('request abort reaches search and stalled response bodies as an aborted source error', async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let fallbackCalls = 0;
  await assert.rejects(() => fetchLyricsDocumentWithFallback('auto', SONG, async () => {
    fallbackCalls += 1;
    return null;
  }, { signal: alreadyAborted.signal }), { kind: 'aborted' });
  assert.equal(fallbackCalls, 0);

  let searchSignalAborted = false;
  const searchLoader = createLyricSourceLoader({
    timeoutMs: 10_000,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        searchSignalAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  const searchController = new AbortController();
  const searchRequest = searchLoader.getKugouDocument(SONG, { signal: searchController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  searchController.abort(new Error('client left'));
  await assert.rejects(() => searchRequest, { name: 'LyricSourceError', kind: 'aborted' });
  assert.equal(searchSignalAborted, true);

  const stalledLoader = createLyricSourceLoader({
    timeoutMs: 10_000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text() {},
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
    }),
  });
  const bodyController = new AbortController();
  const bodyRequest = stalledLoader.getLrclibDocument(SONG, { signal: bodyController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  bodyController.abort(new Error('client left'));
  await assert.rejects(() => bodyRequest, { name: 'LyricSourceError', kind: 'aborted' });
});

test('single-flight cancels one waiter independently and aborts shared work only after the last waiter cancels', async () => {
  let releaseShared;
  let sharedAbortCount = 0;
  const singleFlight = createSingleFlightDocumentFetcher(async (provider, song, { signal }) => (
    new Promise((resolve, reject) => {
      releaseShared = () => resolve(wordDocument(provider));
      signal.addEventListener('abort', () => {
        sharedAbortCount += 1;
        reject(signal.reason);
      }, { once: true });
    })
  ));
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = singleFlight('kugou', SONG, { signal: firstController.signal });
  const second = singleFlight('kugou', SONG, { signal: secondController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  firstController.abort();
  await assert.rejects(() => first, { kind: 'aborted' });
  assert.equal(sharedAbortCount, 0);
  releaseShared();
  assert.equal((await second).syncMode, 'word');
  assert.equal(sharedAbortCount, 0);

  let allAbortCount = 0;
  let allFetchCount = 0;
  const allCancel = createSingleFlightDocumentFetcher(async (provider, song, { signal }) => {
    allFetchCount += 1;
    if (allFetchCount > 1) return wordDocument(provider);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        allAbortCount += 1;
        reject(signal.reason);
      }, { once: true });
    });
  });
  const thirdController = new AbortController();
  const fourthController = new AbortController();
  const third = allCancel('kugou', SONG, { signal: thirdController.signal });
  const fourth = allCancel('kugou', SONG, { signal: fourthController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  thirdController.abort();
  assert.equal(allAbortCount, 0);
  fourthController.abort();
  const fifth = allCancel('kugou', SONG);
  await Promise.all([
    assert.rejects(() => third, { kind: 'aborted' }),
    assert.rejects(() => fourth, { kind: 'aborted' }),
  ]);
  assert.equal((await fifth).syncMode, 'word');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(allAbortCount, 1);
  assert.equal(allFetchCount, 2);
});

test('circuit counts concurrent infrastructure failures and unavailable breaks the consecutive failure streak', async () => {
  let releaseFailures;
  const failureGate = new Promise((resolve) => { releaseFailures = resolve; });
  let concurrentCalls = 0;
  const concurrent = createLyricSourceLoader({
    circuitFailureThreshold: 2,
    circuitCooldownMs: 60_000,
    fetchImpl: async () => {
      concurrentCalls += 1;
      await failureGate;
      throw new Error('network down');
    },
  });
  const first = concurrent.getLrclibDocument({ ...SONG, id: 'one' });
  const second = concurrent.getLrclibDocument({ ...SONG, id: 'two' });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFailures();
  await Promise.allSettled([first, second]);
  await assert.rejects(() => concurrent.getLrclibDocument({ ...SONG, id: 'three' }), { kind: 'circuit_open' });
  assert.equal(concurrentCalls, 2);

  let step = 0;
  const reset = createLyricSourceLoader({
    circuitFailureThreshold: 2,
    circuitCooldownMs: 60_000,
    fetchImpl: async () => {
      step += 1;
      if (step === 1 || step === 3 || step === 4) throw new Error('network down');
      return jsonResponse({ candidates: [] });
    },
  });
  const singleQuerySong = { ...SONG, artist: '歌手甲' };
  await assert.rejects(() => reset.getKugouDocument(singleQuerySong), { kind: 'network' });
  await assert.rejects(() => reset.getKugouDocument(singleQuerySong), { kind: 'unavailable' });
  await assert.rejects(() => reset.getKugouDocument(singleQuerySong), { kind: 'network' });
  await assert.rejects(() => reset.getKugouDocument(singleQuerySong), { kind: 'network' });
  await assert.rejects(() => reset.getKugouDocument(singleQuerySong), { kind: 'circuit_open' });
  assert.equal(step, 4);
});

test('lyric source helpers retain the current provider order', async () => {
  assert.deepEqual(resolveLyricSourceOrder('auto'), ['kugou', 'netease', 'lrclib']);
  assert.deepEqual(resolveLyricSourceOrder('netease'), ['netease']);
  assert.deepEqual(resolveLyricSourceOrder('kugou'), ['kugou']);
  assert.ok(LyricSourceError.prototype instanceof Error);
});
