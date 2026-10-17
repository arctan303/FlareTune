import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamedLyricSourceLoader } from './namedLyricSourceLoader.js';
import { fetchLyricsDocumentWithFallback, fetchLyricsAuditEvidenceWithFallback,
  createCachedSourceDocumentFetcher, createSingleFlightDocumentFetcher } from './lyricSourceLoader.js';
import { listLyricsResolutionCandidates } from './lyricResolution.js';
import { inspectLyricCandidates } from './lyricCandidateInspection.js';
import { fetchUpgradeDocument } from './lyricAssetUpgrade.js';
import { createLyricRequestBudget } from './lyricRequestBudget.js';

const SONG = { id: 'budget-song', title: 'Song (feat. Guest)', artist: 'Artist / Singer', duration: 200.6 };
const SOURCES = Array.from({ length: 8 }, (_, index) => ({
  id: 'lyric_' + String(index + 1).repeat(32), name: `Source ${index + 1}`, note: '',
  protocol: 'custom_krc', enabled: true,
  searchUrl: `https://source${index + 1}.example.com/search`,
  downloadUrl: `https://source${index + 1}.example.com/download`, translationLanguage: 'en',
}));
function fixture({ freeLimit = Infinity } = {}) {
  const calls = [];
  const loader = createNamedLyricSourceLoader({ channels: { version: 2, sources: SOURCES },
    fetchImpl: async url => {
      url = new URL(url); calls.push(url);
      if (calls.length > freeLimit) throw new Error('Too many subrequests');
      if (url.hostname !== 'lrclib.net') return Response.json({ candidates: [] });
      const candidate = { id: 1, trackName: SONG.title, artistName: SONG.artist,
        duration: SONG.duration, syncedLyrics: '[00:01.000]Reliable lyric' };
      return Response.json(url.pathname === '/api/get' ? candidate : [candidate]);
    } });
  return { loader, calls };
}

test('eight empty custom sources leave LRCLIB reachable below the Workers Free ceiling', async () => {
  const { loader, calls } = fixture({ freeLimit: 50 });
  const result = await fetchLyricsDocumentWithFallback('auto', SONG, loader.fetchSourceDocument,
    { enabledSources: loader.enabledSources });
  assert.equal(result?.source, 'lrclib');
  assert.ok(calls.length <= 32, `${calls.length} external requests`);
  assert.equal(calls.filter(url => url.hostname === 'lrclib.net').length, 2);
});

test('candidate aggregation shares one bounded budget and reports source limits without losing LRCLIB', async () => {
  const { loader, calls } = fixture();
  const result = await listLyricsResolutionCandidates(SONG, { enabledSources: loader.enabledSources,
    listCandidates: loader.listSourceCandidates });
  assert.ok(calls.length <= 32, `${calls.length} external requests`);
  assert.equal(result.candidates[0]?.source, 'lrclib');
  assert.ok(result.warnings.some(warning => warning.code === 'request_budget_exceeded'));
});

test('manual candidate inspection bounds concurrent fresh searches across eight sources', async () => {
  const { loader, calls } = fixture();
  const result = await inspectLyricCandidates(SONG,
    SOURCES.map(source => ({ source: source.id, providerLyricId: 'missing' })),
    { createProviderSnapshot: loader.createCandidateInspectionSnapshot });
  assert.ok(calls.length <= 32, `${calls.length} external requests`);
  assert.ok(result.items.some(item => item.error?.code === 'search_request_budget_exceeded'));
});

test('background upgrade bounds parallel source searches while retaining reliable completed LRCLIB', async () => {
  const { loader, calls } = fixture();
  const result = await fetchUpgradeDocument(SONG, loader.fetchSourceDocument,
    { enabledSources: loader.enabledSources });
  assert.ok(calls.length <= 32, `${calls.length} external requests`);
  assert.equal(result?.source, 'lrclib');
});

test('audit resolution shares the allowance and still captures the built-in ranked snapshot', async () => {
  const { loader, calls } = fixture();
  const result = await fetchLyricsAuditEvidenceWithFallback('auto', SONG, loader.fetchSourceAuditEvidence,
    { enabledSources: loader.enabledSources });
  assert.equal(result.document.source, 'lrclib');
  assert.ok(calls.length <= 32, `${calls.length} external requests`);
  assert.equal(result.selectedProviderLyricId, '1');
});

test('the long-lived loader gives concurrent songs and subsequent requests separate allowances', async () => {
  const { loader, calls } = fixture();
  const resolve = song => fetchLyricsDocumentWithFallback('auto', song, loader.fetchSourceDocument,
    { enabledSources: loader.enabledSources });
  const [first, second] = await Promise.all([resolve(SONG), resolve({ ...SONG, id: 'another-song' })]);
  assert.equal(first.source, 'lrclib');
  assert.equal(second.source, 'lrclib');
  assert.equal(calls.length, 62, 'the two concurrent operations share the same LRCLIB get/search requests');
  assert.equal((await resolve(SONG)).source, 'lrclib');
  assert.equal(calls.length, 94, 'local allowance exhaustion never opens an upstream circuit');
});

test('local budget rejection cannot mark a healthy configured source circuit as unavailable', async () => {
  const { loader, calls } = fixture();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestBudget = createLyricRequestBudget();
    for (let index = 0; index < 30; index += 1) requestBudget.consume('custom_krc');
    await assert.rejects(loader.listSourceCandidates(SOURCES[0].id, SONG, { requestBudget }),
      { kind: 'rate_limited', stage: 'budget' });
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await loader.listSourceCandidates(SOURCES[0].id, SONG), []);
  assert.equal(calls.length, 12);
});

test('cache and singleflight preserve the operation budget without caching a limited source as absent', async () => {
  const { loader, calls } = fixture();
  const cached = createCachedSourceDocumentFetcher(createSingleFlightDocumentFetcher(loader.fetchSourceDocument));
  const limited = createLyricRequestBudget();
  for (let index = 0; index < 30; index += 1) limited.consume('custom_krc');
  await assert.rejects(cached(SOURCES[0].id, SONG, { requestBudget: limited }),
    { kind: 'rate_limited', stage: 'budget' });
  assert.equal(calls.length, 0);
  const result = await fetchLyricsDocumentWithFallback('auto', SONG, cached,
    { enabledSources: loader.enabledSources });
  assert.equal(result.source, 'lrclib');
  assert.equal(calls.length, 32);
});

test('manual inspection counts searches and both download formats together, keeping completed previews', async () => {
  let calls = 0;
  const loader = createNamedLyricSourceLoader({ channels: { version: 2, sources: SOURCES },
    fetchImpl: async url => {
      calls += 1; url = new URL(url);
      if (url.pathname === '/search') return Response.json({ candidates: ['first', 'second'].map(id => ({
        id, accesskey: 'private', song: SONG.title, singer: SONG.artist, duration: 200600,
      })) });
      return Response.json({ content: url.searchParams.get('fmt') === 'krc' ? 'invalid'
        : Buffer.from('[00:01.000]Completed preview').toString('base64') });
    } });
  const candidates = SOURCES.flatMap((source, index) => (index < 4 ? ['first', 'second'] : ['first'])
    .map(providerLyricId => ({ source: source.id, providerLyricId })));
  const result = await inspectLyricCandidates(SONG, candidates,
    { createProviderSnapshot: loader.createCandidateInspectionSnapshot });
  assert.equal(calls, 30);
  assert.ok(result.items.some(item => item.state === 'ready'));
  assert.ok(result.items.some(item => item.error?.code === 'download_request_budget_exceeded'));
  assert.ok(result.items.filter(item => item.state === 'ready').every(item => item.lyrics.lines[0].text === 'Completed preview'));
});

test('automatic source resolution retains its completed reliable candidate when a later download reaches the limit', async () => {
  let calls = 0;
  const loader = createNamedLyricSourceLoader({ channels: { version: 2, sources: [SOURCES[0]] },
    fetchImpl: async url => {
      calls += 1; url = new URL(url);
      if (url.pathname === '/search') return Response.json({ candidates: ['first', 'second'].map(id => ({
        id, accesskey: 'private', song: SONG.title, singer: SONG.artist, duration: 200600,
      })) });
      return Response.json({ content: url.searchParams.get('fmt') === 'krc' ? 'invalid'
        : Buffer.from('[00:01.000]Completed reliable lyric').toString('base64') });
    } });
  const requestBudget = createLyricRequestBudget();
  for (let index = 0; index < 27; index += 1) requestBudget.consume('custom_krc');
  const result = await loader.fetchSourceDocument(SOURCES[0].id, SONG, { requestBudget });
  assert.equal(calls, 3);
  assert.equal(result.providerMeta.providerLyricId, 'first');
  assert.equal(result.lines[0].text, 'Completed reliable lyric');
});

test('background work continues the caller allowance instead of resetting the same operation', async () => {
  const { loader, calls } = fixture();
  const requestBudget = createLyricRequestBudget();
  await listLyricsResolutionCandidates(SONG, { enabledSources: [SOURCES[0].id],
    listCandidates: loader.listSourceCandidates, requestBudget });
  assert.equal(calls.length, 12);
  const result = await fetchUpgradeDocument(SONG, loader.fetchSourceDocument,
    { enabledSources: loader.enabledSources, requestBudget });
  assert.equal(result.source, 'lrclib');
  assert.equal(calls.length, 32);
});
