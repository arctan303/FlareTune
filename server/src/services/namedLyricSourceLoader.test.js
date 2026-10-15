import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LYRIC_CHANNELS, DEFAULT_LYRIC_SOURCES, normalizeLyricChannels } from '../../../shared/lyricSources.js';
import { createNamedLyricSourceLoader } from './namedLyricSourceLoader.js';
import { fetchLyricsDocumentWithFallback, fetchLyricsAuditEvidenceWithFallback, createCachedSourceDocumentFetcher } from './lyricSourceLoader.js';
import { listLyricsResolutionCandidates } from './lyricResolution.js';
import { inspectLyricCandidates } from './lyricCandidateInspection.js';
import { buildReadyLyricArtifact, projectLyricArtifact } from './lyricAssetWorkflow.js';
import { validateLyricArtifact } from './lyricArtifactStore.js';

const song = { id: 'song-1', title: 'Song', artist: 'Artist', duration: 200 };
const source = (digit, patch = {}) => ({ id: 'lyric_' + digit.repeat(32), name: 'Service ' + digit,
  note: 'Separate account ' + digit, protocol: 'custom_lrc', enabled: true,
  searchUrl: `https://source${digit}.example.com/search`, downloadUrl: `https://source${digit}.example.com/download`,
  translationLanguage: 'en', ...patch });
const config = sources => ({ version: 2, sources });
function fixture(sources = [source('1'), source('2')]) {
  const calls = [];
  const loader = createNamedLyricSourceLoader({ channels: config(sources), fetchImpl: async (url, init) => {
    url = new URL(url); calls.push(url.href);
    assert.equal(init.redirect, 'manual');
    assert.equal(url.hostname === 'lrclib.net', false, 'a selected custom source must never fall through to LRCLIB');
    return Response.json(url.pathname === '/search'
      ? { code: 200, result: { songs: [{ id: 'same-id', name: 'Song', artists: [{ name: 'Artist' }], duration: 200000 }] } }
      : { code: 200, lrc: { lyric: `[00:01.000]Hello from ${url.hostname}` }, tlyric: { lyric: '[00:01.000]Translated lyric' } });
  } });
  return { loader, calls };
}

test('legacy conversion preserves configured IDs and endpoints; LRCLIB is immutable and implicit', () => {
  const old = structuredClone(DEFAULT_LYRIC_SOURCES);
  old.custom_krc = { enabled: true, searchUrl: 'https://words.example.com/search', downloadUrl: 'https://words.example.com/download', translationLanguage: 'ja' };
  const next = normalizeLyricChannels(old);
  assert.equal(next.sources.length, 1);
  assert.deepEqual(next.sources[0], { id: 'custom_krc', name: '自定义逐字源', note: '', protocol: 'custom_krc', ...old.custom_krc });
  assert.deepEqual(normalizeLyricChannels(DEFAULT_LYRIC_SOURCES), DEFAULT_LYRIC_CHANNELS);
  old.lrclib.enabled = false;
  assert.throws(() => normalizeLyricChannels(old));
  assert.deepEqual(normalizeLyricChannels(old, { migrateLegacy: true }), next);
  assert.throws(() => normalizeLyricChannels({ ...config([]), lrclib: { enabled: false } }));
  assert.throws(() => normalizeLyricChannels(config([source('1', { id: 'lrclib' })])));
});

test('names, notes, IDs, endpoints and source count are bounded without restricting duplicate protocols', () => {
  assert.equal(normalizeLyricChannels(config([source('1'), source('2')])).sources.length, 2);
  assert.equal(normalizeLyricChannels(config([source('1', { name: '  Lyrics  ', note: 'First\nSecond' })])).sources[0].name, 'Lyrics');
  for (const patch of [{ id: '__proto__' }, { id: 'custom_krc' }, { name: ' ' }, { name: 'x'.repeat(81) }, { note: 'x'.repeat(501) },
    { note: '\u0000' }, { protocol: 'unknown' }, { searchUrl: 'http://service.example.com/search' }, { translationLanguage: 'unknown' }]) {
    assert.throws(() => normalizeLyricChannels(config([source('1', patch)])), undefined, JSON.stringify(patch));
  }
  assert.throws(() => normalizeLyricChannels(config([source('1'), source('1')])));
  assert.throws(() => normalizeLyricChannels(config(Array.from({ length: 9 }, (_, i) => source(String(i))))));
});

test('same-protocol services and identical candidate IDs keep search, inspection, cache, audit and translation isolated', async () => {
  const { loader, calls } = fixture();
  const [a, b] = loader.enabledSources;
  const candidates = await listLyricsResolutionCandidates(song, { enabledSources: [a, b], listCandidates: loader.listSourceCandidates });
  assert.equal(candidates.candidates.length, 2);
  assert.deepEqual(new Set(candidates.candidates.map(item => item.source)), new Set([a, b]));
  assert.ok(candidates.candidates.every(item => item.providerLyricId === 'same-id'));
  const inspected = await inspectLyricCandidates(song, [a, b].map(source => ({ source, providerLyricId: 'same-id' })), {
    createProviderSnapshot: loader.createCandidateInspectionSnapshot,
  });
  assert.ok(inspected.items.every(item => item.state === 'ready'));
  assert.deepEqual(inspected.items.map(item => item.source), [a, b]);
  const cached = createCachedSourceDocumentFetcher(loader.fetchSourceDocument);
  for (const [id, host] of [[a, 'source1.example.com'], [b, 'source2.example.com']]) {
    const doc = await cached(id, song, { providerLyricId: 'same-id' });
    assert.equal(doc.source, id); assert.match(doc.lines[0].text, new RegExp(host));
    assert.equal(doc.providerMeta.translationLanguage, 'en');
    const before = calls.length;
    assert.deepEqual(await cached(id, song, { providerLyricId: 'same-id' }), doc);
    assert.equal(calls.length, before);
    const evidence = await fetchLyricsAuditEvidenceWithFallback(id, song, loader.fetchSourceAuditEvidence, { enabledSources: loader.enabledSources });
    assert.equal(evidence.document.source, id); assert.ok(evidence.candidates.every(item => item.source === id));
    const { artifact } = await buildReadyLyricArtifact(song, doc);
    assert.equal(artifact.original.source, id); assert.equal(artifact.translation.source, id); assert.equal(artifact.translation.language, 'en');
    assert.equal(validateLyricArtifact(artifact).valid, true);
    assert.ok(projectLyricArtifact(artifact, { song, targetLanguage: 'en' }));
  }
  const onlyA = calls.filter(url => new URL(url).hostname === 'source1.example.com');
  assert.ok(onlyA.length); assert.ok(calls.some(url => new URL(url).hostname === 'source2.example.com'));
});

test('disabled, deleted and unknown sources never fetch or redirect; enabled custom source participates in automatic selection', async () => {
  const { loader, calls } = fixture([source('1'), source('2', { enabled: false })]);
  const a = source('1').id;
  assert.deepEqual(loader.enabledSources, [a, 'lrclib']);
  for (const id of [source('2').id, source('3').id, 'custom_lrc', '__proto__']) {
    for (const method of ['fetchSourceDocument', 'listSourceCandidates', 'createCandidateInspectionSnapshot', 'fetchSourceAuditEvidence']) {
      await assert.rejects(loader[method](id, song), { kind: 'unavailable', provider: id });
    }
  }
  assert.equal(calls.length, 0);
  let progress;
  const doc = await fetchLyricsDocumentWithFallback('auto', song, loader.fetchSourceDocument, { enabledSources: [a], onAutomaticCandidate: value => { progress = value; } });
  assert.equal(doc.source, a); assert.equal(progress.source, a);
  assert.ok(calls.every(url => new URL(url).hostname === 'source1.example.com'));
  const deleted = fixture([]);
  await assert.rejects(deleted.loader.fetchSourceDocument(a, song), { kind: 'unavailable' });
  assert.equal(deleted.calls.length, 0);
});

test('member-facing source metadata contains only enabled names and IDs', () => {
  const { loader } = fixture([source('1'), source('2', { enabled: false })]);
  assert.deepEqual(loader.sourceDetails, [{ id: source('1').id, name: 'Service 1' }, { id: 'lrclib', name: 'LRCLIB' }]);
  assert.doesNotMatch(JSON.stringify(loader.sourceDetails), /https|Separate|searchUrl|downloadUrl/);
});

test('snapshot download failures identify the configured source rather than its shared protocol', async () => {
  const entry=source('a');
  const loader=createNamedLyricSourceLoader({channels:config([entry]),fetchImpl:async url=>new URL(url).pathname==='/search'
    ? Response.json({code:200,result:{songs:[{id:'same-id',name:'Song',artists:[{name:'Artist'}],duration:200000}]}})
    : new Response('',{status:503})});
  const snapshot=await loader.createCandidateInspectionSnapshot(entry.id,song);
  await assert.rejects(snapshot.loadDocument('same-id'),{kind:'upstream',provider:entry.id,stage:'download-lyric'});
});
