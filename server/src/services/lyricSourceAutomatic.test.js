import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createLyricSourceLoader, fetchLyricsDocumentWithFallback } from './lyricSourceLoader.js';

const SONG = { title: 'Night Song', artist: 'Singer A', duration: 200 };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
const encodedKrc = (text) => {
  const bytes = deflateSync(Buffer.from(text));
  return Buffer.concat([Buffer.from('krc1'), Buffer.from(Uint8Array.from(bytes,
    (byte, index) => byte ^ KEY[index % KEY.length]))]).toString('base64');
};
const candidate = (id, extra = {}) => ({ id, accesskey: 'mock-key', song: SONG.title,
  singer: SONG.artist, duration: 200000, ...extra });
const content = (prefix = '') => encodedKrc(`${prefix}[1000,1000]<0,1000,0>Sing together`);
const scoped = (loader) => (provider, ...args) => provider === 'kugou'
  ? loader.fetchSourceDocument(provider, ...args) : null;

test('automatic Kugou resolution skips an embedded wrong version and loads the next valid word timeline', async () => {
  const downloaded = [];
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') return json({ candidates: [candidate('bad-live'), candidate('good')] });
    const id = parsed.searchParams.get('id');
    downloaded.push(id);
    return json({ content: content(id === 'bad-live' ? '[ti:Night Song (Live)]\n' : '') });
  } });
  const document = await fetchLyricsDocumentWithFallback('auto', SONG, scoped(loader));
  assert.equal(document.providerMeta.providerLyricId, 'good');
  assert.equal(document.syncMode, 'word');
  assert.deepEqual(downloaded, ['bad-live', 'good']);
});

test('automatic Kugou resolution compares translated word candidates instead of returning the first word candidate', async () => {
  const language = Buffer.from(JSON.stringify({ version: 1,
    content: [{ type: 1, lyricContent: [['一起唱歌']] }] })).toString('base64');
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') return json({ candidates: [candidate('untranslated'), candidate('translated')] });
    return json({ content: content(parsed.searchParams.get('id') === 'translated' ? `[language:${language}]\n` : '') });
  } });
  const document = await loader.getKugouDocument(SONG);
  assert.equal(document.providerMeta.providerLyricId, 'translated');
  assert.equal(document.lines[0].tlyric, '一起唱歌');
});

test('automatic download budget excludes unreliable summaries and still limits downloads to five candidates', async () => {
  const downloaded = [];
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') return json({ candidates: [
      ...Array.from({ length: 5 }, (_, index) => candidate(`wrong-${index}`, { song: `${SONG.title} (Live)` })),
      ...Array.from({ length: 6 }, (_, index) => candidate(`valid-${index}`, { duration: 215000, singer: 'Singer A / Guest / Guest2 / Guest3' })),
    ] });
    downloaded.push(parsed.searchParams.get('id'));
    return json({ content: content() });
  } });
  const candidates = await loader.listSourceCandidates('kugou', SONG);
  assert.equal(candidates[0].versionMismatch, true, 'fixture puts unreliable metadata before valid candidates');
  const document = await loader.getKugouDocument(SONG);
  assert.equal(document.providerMeta.providerLyricId, 'valid-0');
  assert.deepEqual(downloaded, ['valid-0', 'valid-1', 'valid-2', 'valid-3', 'valid-4']);
});

test('a later empty Kugou candidate cannot turn an earlier timeout into a negative lyric result', async () => {
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') return json({ candidates: [candidate('temporary'), candidate('empty')] });
    return json({}, parsed.searchParams.get('id') === 'temporary' && parsed.searchParams.get('fmt') === 'krc' ? 504 : 404);
  } });
  await assert.rejects(fetchLyricsDocumentWithFallback('auto', SONG, scoped(loader)), { kind: 'timeout' });
});

test('a later empty Netease candidate cannot overwrite a timeout and multiple actionable errors retain priority', async () => {
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes('search')) return json({ code: 200, result: { songs: [1, 2, 3].map((id) => ({
      id, name: SONG.title, artists: [{ name: SONG.artist }], duration: 200000,
    })) } });
    if (parsed.searchParams.get('id') === '1') return json({}, 504);
    if (parsed.searchParams.get('id') === '2') return json({}, 429);
    return json({ code: 200, nolyric: true });
  } });
  await assert.rejects(loader.getNeteaseDocument(SONG), error => error.kind === 'timeout'
    && error.cause.errors.length === 2);
});

test('cancellation during Kugou KRC download stops before LRC fallback and other candidates', async () => {
  const controller = new AbortController();
  const downloads = [];
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') return json({ candidates: [candidate('first'), candidate('second')] });
    downloads.push(`${parsed.searchParams.get('id')}:${parsed.searchParams.get('fmt')}`);
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  } });
  await assert.rejects(loader.getKugouDocument(SONG, { signal: controller.signal }), { kind: 'aborted' });
  assert.deepEqual(downloads, ['first:krc']);
});

test('LRCLIB exact word timing does not conceal a closer search candidate', async () => {
  const lyricsfile = `version: '1.0'\nlines:\n  - text: 'Sing'\n    start_ms: 1000\n    end_ms: 2000\n    words:\n      - { text: 'Sing', start_ms: 1000, end_ms: 2000 }`;
  const common = { trackName: SONG.title, artistName: SONG.artist, lyricsfile };
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => new URL(url).pathname === '/api/get'
    ? json({ ...common, id: 'exact', duration: 201 })
    : json([{ ...common, id: 'closer', duration: 200 }]) });
  const document = await loader.getLrclibDocument(SONG);
  assert.equal(document.syncMode, 'word');
  assert.equal(document.providerMeta.providerLyricId, 'closer');
});
