import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createLyricSourceLoader } from './lyricSourceLoader.js';
import { fetchUpgradeDocument } from './lyricAssetUpgrade.js';

const SONG = { title: 'Night Song', artist: 'Singer', duration: 200 };
const KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
const krc = (prefix = '') => {
  const compressed = deflateSync(Buffer.from(`${prefix}[1000,1000]<0,1000,0>Hello`));
  return Buffer.concat([Buffer.from('krc1'), Buffer.from(Uint8Array.from(compressed,
    (byte, index) => byte ^ KEY[index % KEY.length]))]).toString('base64');
};
const candidate = (id) => ({ id, accesskey: 'mock', song: SONG.title, singer: SONG.artist, duration: 200000 });
const songCandidate = (id) => ({ id, name: SONG.title, artists: [{ name: SONG.artist }], duration: 200000 });
const abortPending = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});

test('upgrade deadline retains a real decoded candidate when its next same-source candidate stalls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let slowStarted;
  const waitingForSlow = new Promise(resolve => { slowStarted = resolve; });
  const loader = createLyricSourceLoader({ fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') return Response.json({ candidates: ['good', 'slow'].map(candidate) });
    const id = parsed.searchParams.get('id'); calls.push(id);
    if (id === 'good') return Response.json({ content: krc() });
    slowStarted();
    return abortPending(init.signal);
  } });
  const pending = fetchUpgradeDocument(SONG, (provider, song, options) => provider === 'kugou'
    ? loader.fetchSourceDocument(provider, song, options) : null, { budgetMs: 100 });
  await waitingForSlow;
  t.mock.timers.tick(100);
  const result = await pending;
  assert.deepEqual(calls, ['good', 'slow']);
  assert.equal(result.syncMode, 'word');
  assert.equal(result.providerMeta.providerLyricId, 'good');
});

for (const source of ['kugou', 'netease', 'lrclib']) {
  test(`${source} reports a usable candidate before slow remaining work while cancellation still rejects`, async () => {
    const controller = new AbortController();
    const progress = [];
    let slowStarted;
    const waitingForSlow = new Promise(resolve => { slowStarted = resolve; });
    const loader = createLyricSourceLoader({ fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (source === 'kugou') {
        if (parsed.pathname === '/search') return Response.json({ candidates: ['good', 'slow'].map(candidate) });
        if (parsed.searchParams.get('id') === 'good') return Response.json({ content: krc() });
      } else if (source === 'netease') {
        if (parsed.pathname.includes('search')) return Response.json({ code: 200, result: { songs: ['good', 'slow'].map(songCandidate) } });
        if (parsed.searchParams.get('id') === 'good') return Response.json({ code: 200, lrc: { lyric: '[00:01.00]Hello' } });
      } else if (parsed.pathname === '/api/get') {
        return Response.json({ id: 'good', trackName: SONG.title, artistName: SONG.artist,
          duration: 200, syncedLyrics: '[00:01.00]Hello' });
      }
      slowStarted();
      return abortPending(init.signal);
    } });
    const result = loader.fetchSourceDocument(source, SONG, { signal: controller.signal,
      onAutomaticCandidate: document => progress.push(document) });
    await waitingForSlow;
    assert.equal(progress.length, 1);
    assert.equal(progress[0].source, source);
    assert.equal(progress[0].providerMeta.providerLyricId, 'good');
    assert.ok(progress[0].lines.length);
    controller.abort();
    await assert.rejects(result, { kind: 'aborted' });
    assert.equal(progress.length, 1, 'cancellation does not report further candidates');
  });
}

test('automatic progress excludes wrong versions, suppresses equal candidates and isolates observer errors', async () => {
  const progress = [];
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/search') return Response.json({ candidates: ['wrong', 'good', 'equal'].map(candidate) });
    return Response.json({ content: krc(parsed.searchParams.get('id') === 'wrong' ? '[ti:Night Song (Live)]\n' : '') });
  } });
  const document = await loader.getKugouDocument(SONG, { onAutomaticCandidate: candidateDocument => {
    progress.push(candidateDocument.providerMeta.providerLyricId);
    throw new Error('observer failure');
  } });
  assert.deepEqual(progress, ['good']);
  assert.equal(document.providerMeta.providerLyricId, 'good');
  await loader.getKugouDocument(SONG, { providerLyricId: 'good', onAutomaticCandidate: () => progress.push('manual') });
  assert.deepEqual(progress, ['good'], 'manual selection never emits upgrade progress');
});

test('LRCLIB progress remains best-so-far across exact and search and rejects cancellation inside the observer', async () => {
  const progress = [];
  const common = { trackName: SONG.title, artistName: SONG.artist, syncedLyrics: '[00:01.00]Hello' };
  const loader = createLyricSourceLoader({ fetchImpl: async (url) => new URL(url).pathname === '/api/get'
    ? Response.json({ ...common, id: 'exact', duration: 200 })
    : Response.json([{ ...common, id: 'worse-search', duration: 204 }]) });
  const document = await loader.getLrclibDocument(SONG, { onAutomaticCandidate: candidateDocument => progress.push(candidateDocument.providerMeta.providerLyricId) });
  assert.deepEqual(progress, ['exact']);
  assert.equal(document.providerMeta.providerLyricId, 'exact');
  const controller = new AbortController();
  await assert.rejects(loader.getLrclibDocument(SONG, { signal: controller.signal,
    onAutomaticCandidate: () => controller.abort() }), { kind: 'aborted' });
});
