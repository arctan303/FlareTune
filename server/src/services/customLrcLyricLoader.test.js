import { TEST_LYRIC_SOURCES } from '../test/lyricSourceConfigFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LyricSourceError } from './lyricSourceError.js';
import {
  alignTranslationToLines,
  buildCustomLrcSearchKeywords,
  loadCustomLrcSelection,
  parseLrcTimestampEntries,
  parseCustomLrcLyricDocument,
  searchCustomLrcSelections,
} from './customLrcLyricLoader.js';
import { createLyricSourceLoader } from './lyricSourceLoader.js';

const mockResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('buildCustomLrcSearchKeywords generates ordered search variants', () => {
  assert.deepEqual(buildCustomLrcSearchKeywords({}), []);
  assert.deepEqual(buildCustomLrcSearchKeywords({ title: 'COME BABY', artist: 'Elisa Rosselli, Dale Arden' }), [
    'COME BABY Elisa Rosselli, Dale Arden',
    'COME BABY Elisa Rosselli',
    'COME BABY',
  ]);
  assert.deepEqual(buildCustomLrcSearchKeywords({ title: '晴天 (Live版)', artist: '周杰伦' }), [
    '晴天 (Live版) 周杰伦',
    '晴天 周杰伦',
    '晴天 (Live版)',
  ]);
});

test('parseLrcTimestampEntries extracts timed lines and filters metadata', () => {
  const lrc = `
    [ti:COME BABY]
    [ar:Elisa Rosselli]
    [by:肖大能耐]
    [00:01.600]You can call my name
    [00:05.17]You can talk to me
    [00:10.00][00:20.00]Chorus line
  `;
  const entries = parseLrcTimestampEntries(lrc);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { time: 1.6, text: 'You can call my name' });
  assert.deepEqual(entries[1], { time: 5.17, text: 'You can talk to me' });
  assert.deepEqual(entries[2], { time: 10, text: 'Chorus line' });
  assert.deepEqual(entries[3], { time: 20, text: 'Chorus line' });
});

test('alignTranslationToLines aligns translations to lines within tolerance', () => {
  const lines = [
    { time: 1.6, text: 'You can call my name' },
    { time: 5.17, text: 'You can talk to me' },
    { time: 8.8, text: 'You can touch my soul' },
  ];
  const tlyric = `
    [by:肖大能耐]
    [00:01.600]你可以在任意时间呼唤我的名字
    [00:05.190]当出什么事情的时候你可以和我说
  `;
  const aligned = alignTranslationToLines(lines, tlyric);
  assert.equal(aligned[0].tlyric, '你可以在任意时间呼唤我的名字');
  // 5.190 is within 20ms of 5.17 (<= 50ms tolerance)
  assert.equal(aligned[1].tlyric, '当出什么事情的时候你可以和我说');
  assert.equal(aligned[2].tlyric, undefined);
});

test('parseCustomLrcLyricDocument converts raw lyric response to standard LyricDocument', () => {
  const rawData = {
    code: 200,
    lrc: {
      lyric: '[00:01.600]You can call my name\n[00:05.170]You can talk to me',
    },
    tlyric: {
      lyric: '[00:01.600]你可以呼唤我的名字\n[00:05.170]你可以找我倾诉',
    },
  };
  const providerMeta = { providerLyricId: '123', matchedTitle: 'COME BABY', matchedArtist: 'Elisa' };
  const document = parseCustomLrcLyricDocument(rawData, { providerMeta });

  assert.equal(document.source, 'custom_lrc');
  assert.equal(document.format, 'lrc');
  assert.equal(document.syncMode, 'line');
  assert.equal(document.lines.length, 2);
  assert.equal(document.lines[0].text, 'You can call my name');
  assert.equal(document.lines[0].tlyric, '你可以呼唤我的名字');
  assert.equal(document.lines[1].text, 'You can talk to me');
  assert.equal(document.lines[1].tlyric, '你可以找我倾诉');
  assert.equal(document.providerMeta.providerLyricId, '123');
});

test('parseCustomLrcLyricDocument handles untranslated lyrics or missing tlyric gracefully', () => {
  const rawData = {
    code: 200,
    lrc: {
      lyric: '[00:01.600]Single line song',
    },
    tlyric: {
      lyric: '',
    },
  };
  const document = parseCustomLrcLyricDocument(rawData);
  assert.equal(document.source, 'custom_lrc');
  assert.equal(document.format, 'lrc');
  assert.equal(document.syncMode, 'line');
  assert.equal(document.lines.length, 1);
  assert.equal(document.lines[0].tlyric, undefined);
});

test('parseCustomLrcLyricDocument rejects empty, nolyric, or uncollected responses', () => {
  assert.throws(
    () => parseCustomLrcLyricDocument({ code: 200, lrc: { lyric: '' } }),
    (error) => error instanceof LyricSourceError && error.kind === 'unavailable',
  );
  assert.throws(
    () => parseCustomLrcLyricDocument({ code: 200, nolyric: true, lrc: { lyric: '[00:01.00]test' } }),
    (error) => error instanceof LyricSourceError && error.kind === 'unavailable',
  );
  assert.throws(
    () => parseCustomLrcLyricDocument({ code: 200, uncollected: true }),
    (error) => error instanceof LyricSourceError && error.kind === 'unavailable',
  );
});

test('searchCustomLrcSelections finds, normalizes and ranks song candidates', async () => {
  const song = { title: 'COME BABY', artist: 'Elisa Rosselli, Dale Arden', duration: 191 };
  const mockFetch = async (url) => {
    assert.match(url, /lrc\.example\.com\/search/);
    return mockResponse({
      code: 200,
      result: {
        songs: [
          {
            id: 25862807,
            name: 'COME BABY',
            artists: [{ name: 'Elisa Rosselli' }, { name: 'Dale Arden' }],
            album: { name: 'Winx Club In Concerto' },
            duration: 190813,
          },
          {
            id: 99999,
            name: 'COME BABY (DJ Mix)',
            artists: [{ name: 'Other Singer' }],
            album: { name: 'DJ Remixed' },
            duration: 250000,
          },
        ],
      },
    });
  };

  const selections = await searchCustomLrcSelections(song, null, { config: TEST_LYRIC_SOURCES.custom_lrc, fetchImpl: mockFetch });
  assert.equal(selections.length, 1);
  const best = selections[0];
  assert.equal(best.candidate.id, 25862807);
  assert.equal(best.candidate.name, 'COME BABY');
  assert.equal(best.candidate.artistName, 'Elisa Rosselli / Dale Arden');
  assert.equal(best.candidate.albumName, 'Winx Club In Concerto');
  assert.equal(best.exactTitle, true);
  assert.equal(best.artistRatio, 1);
});

test('searchCustomLrcSelections rejects invalid song search input', async () => {
  await assert.rejects(
    () => searchCustomLrcSelections({ title: '' }, null, { config: TEST_LYRIC_SOURCES.custom_lrc }),
    (error) => error instanceof LyricSourceError && error.kind === 'invalid',
  );
  await assert.rejects(
    () => searchCustomLrcSelections({ title: 'Song', artist: '' }, null, { config: TEST_LYRIC_SOURCES.custom_lrc }),
    (error) => error instanceof LyricSourceError && error.kind === 'invalid',
  );
});

test('searchCustomLrcSelections handles search 404 or empty results', async () => {
  const song = { title: 'Nonexistent Song', artist: 'Unknown Singer' };
  const mockFetch = async () => mockResponse({ code: 404 });
  await assert.rejects(
    () => searchCustomLrcSelections(song, null, { config: TEST_LYRIC_SOURCES.custom_lrc, fetchImpl: mockFetch }),
    (error) => error instanceof LyricSourceError && error.kind === 'unavailable',
  );

  const emptyFetch = async () => mockResponse({ code: 200, result: { songs: [] } });
  const emptySelections = await searchCustomLrcSelections(song, null, { config: TEST_LYRIC_SOURCES.custom_lrc, fetchImpl: emptyFetch });
  assert.deepEqual(emptySelections, []);
});

test('loadCustomLrcSelection fetches lyric and parses with provider metadata', async () => {
  const selection = {
    candidate: {
      id: 25862807,
      name: 'COME BABY',
      artistName: 'Elisa Rosselli / Dale Arden',
      albumName: 'Winx Club',
      duration: 191000,
    },
    durationDelta: 0.2,
    score: 170,
  };
  const mockFetch = async (url) => {
    assert.match(url, /lrc\.example\.com\/download\?id=25862807/);
    return mockResponse({
      code: 200,
      lrc: { lyric: '[00:01.000]Lyric line' },
      tlyric: { lyric: '[00:01.000]歌词行' },
    });
  };

  const document = await loadCustomLrcSelection(selection, null, { config: TEST_LYRIC_SOURCES.custom_lrc, fetchImpl: mockFetch });
  assert.equal(document.source, 'custom_lrc');
  assert.equal(document.format, 'lrc');
  assert.equal(document.lines[0].text, 'Lyric line');
  assert.equal(document.lines[0].tlyric, '歌词行');
  assert.equal(document.providerMeta.providerLyricId, '25862807');
});

test('createLyricSourceLoader integrates custom_lrc discovery, preview, and audit evidence', async () => {
  const song = { title: 'COME BABY', artist: 'Elisa Rosselli', duration: 191 };
  const mockFetch = async (url) => {
    if (url.includes('/search')) {
      return mockResponse({
        code: 200,
        result: {
          songs: [{
            id: 12345,
            name: 'COME BABY',
            artists: [{ name: 'Elisa Rosselli' }],
            album: { name: 'Album' },
            duration: 191000,
          }],
        },
      });
    }
    if (url.includes('/download')) {
      return mockResponse({
        code: 200,
        lrc: { lyric: '[00:01.000]Line 1\n[00:05.000]Line 2' },
        tlyric: { lyric: '[00:01.000]第一行\n[00:05.000]第二行' },
      });
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const loader = createLyricSourceLoader({ sources: TEST_LYRIC_SOURCES, fetchImpl: mockFetch });

  // Test candidate listing
  const candidates = await loader.listSourceCandidates('custom_lrc', song);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'custom_lrc');
  assert.equal(candidates[0].providerLyricId, '12345');
  assert.equal(candidates[0].matchedTitle, 'COME BABY');

  // Test candidate inspection snapshot
  const snapshot = await loader.createCandidateInspectionSnapshot('custom_lrc', song);
  assert.deepEqual(snapshot.providerLyricIds, ['12345']);
  const previewDoc = await snapshot.loadDocument('12345');
  assert.equal(previewDoc.source, 'custom_lrc');
  assert.equal(previewDoc.lines[0].tlyric, '第一行');

  // Test audit evidence
  const evidence = await loader.fetchSourceAuditEvidence('custom_lrc', song);
  assert.equal(evidence.document.source, 'custom_lrc');
  assert.equal(evidence.selectedProviderLyricId, '12345');
  assert.equal(evidence.candidates[0].source, 'custom_lrc');

  // Test fetchSourceDocument
  const doc = await loader.fetchSourceDocument('custom_lrc', song);
  assert.equal(doc.source, 'custom_lrc');
  assert.equal(doc.syncMode, 'line');

  // Test fetchSourceLyrics text
  const lrcText = await loader.fetchSourceLyrics('custom_lrc', 'COME BABY', 'Elisa Rosselli', 191);
  assert.match(lrcText, /\[00:01\.000\]Line 1/);
});

test('CustomLrc automatic resolution skips an empty top lyric and reads the next candidate', async () => {
  const song = { title: 'COME BABY', artist: 'Elisa Rosselli', duration: 191 };
  const requestedIds = [];
  const loader = createLyricSourceLoader({ sources: TEST_LYRIC_SOURCES, fetchImpl: async (url) => {
    if (url.includes('/search')) return mockResponse({ code: 200, result: { songs: [
      { id: 12345, name: song.title, artists: [{ name: song.artist }], duration: 191000 },
      { id: 12346, name: song.title, artists: [{ name: song.artist }], duration: 191000 },
    ] } });
    if (url.includes('/download')) {
      const id = new URL(url).searchParams.get('id');
      requestedIds.push(id);
      return mockResponse({ code: 200, lrc: { lyric: id === '12346' ? '[00:01.000]usable lyric' : '' } });
    }
    throw new Error(`Unexpected url: ${url}`);
  } });
  const document = await loader.getCustomLrcDocument(song);
  assert.equal(document.providerMeta.providerLyricId, '12346');
  assert.equal(document.lines[0].text, 'usable lyric');
  assert.deepEqual(requestedIds, ['12345', '12346']);
});
