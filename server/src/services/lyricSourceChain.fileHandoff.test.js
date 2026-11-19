import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadyLyricArtifact, projectLyricArtifact } from './lyricAssetWorkflow.js';
import { createLyricDocument } from '../utils/lyricDocument.js';
import { createMemoryLyricStore } from '../test/lyricAssetFixtures.js';
import { fileLyricSource, selectLyricSource } from './lyricSourceChain.js';

const song = { id: 'handoff-song', title: 'Fixture song', artist: 'Fixture singer', duration: 100, language: 'en' };
const lines = [{ time: 1, endTime: 4, text: 'We sing beneath the summer sky' },
  { time: 8, endTime: 12, text: 'The stars will guide us safely home' }];
const fail = code => Object.assign(new Error(code), { code });
async function fixture({ source = 'youtube', provenance = {}, completion = null, translation = null,
  changeCandidate, beforeFile, beforeAdopt, rejectAdopt = false, fileAdoptFails = false } = {}) {
  const initial = (await buildReadyLyricArtifact(song, { source, format: 'lrc', lines,
    providerMeta: { matchedTitle: song.title, matchedArtist: song.artist, matchedDuration: song.duration } })).artifact;
  initial.provenance = { ...initial.provenance, managedBy: 'youtube-music', evaluation: 'unassessed', quality: 'good', ...provenance };
  initial.aiCompletion = completion;
  if (translation) initial.translation = { source: 'youtube', kind: 'machine', language: 'zh',
    originalTextHash: initial.textHash, lines: ['我们在夏夜歌唱', '星光指引我们平安回家'], updatedAt: initial.updatedAt, ...translation };
  const store = createMemoryLyricStore(initial), calls = { resolve: 0, adopt: 0, ai: 0, otherAdopt: 0 }, diagnostics = [];
  const resultFor = read => {
    const projected = projectLyricArtifact(read.artifact, { song, targetLanguage: 'zh' });
    return { quality: 'weak', document: createLyricDocument(read.artifact.original), artifact: read.artifact, etag: read.etag,
      translation: { supported: true, state: projected.translation ? 'ready' : read.artifact.aiCompletion?.status === 'pending' ? 'pending' : 'idle',
        targetLanguage: 'zh', ...(projected.translation || {}) } };
  };
  const workbench = { id: 'lyrics-workbench', claim: () => true, async resolve() {
    calls.resolve++;
    const read = await store.get(song.id), candidate = resultFor(read);
    candidate.artifact.provenance = { ...candidate.artifact.provenance, managedBy: 'lyrics-workbench', evaluation: 'assessed', quality: 'weak' };
    changeCandidate?.(candidate);
    return { ...candidate, onAdopt: async () => {
      calls.adopt++;
      await beforeAdopt?.({ store, read, calls });
      if (rejectAdopt) throw fail('LYRIC_RESULT_STALE');
      const next = { ...candidate.artifact, ...(candidate.translation.state === 'ready' ? {} : {
        aiCompletion: { status: 'pending', updatedAt: new Date().toISOString() } }) };
      const written = await store.putIfMatch(song.id, next, read.etag);
      if (written.state !== 'updated') throw fail('LYRIC_RESULT_STALE');
      if (candidate.translation.state !== 'ready') calls.ai++;
      return resultFor(written);
    } };
  } };
  const builtin = fileLyricSource(store), file = { ...builtin, async resolve(...args) {
    await beforeFile?.({ store, calls });
    const result = await builtin.resolve(...args);
    return fileAdoptFails ? { ...result, onAdopt: async () => { throw fail('FILE_ADOPTION_FAILED'); } } : result;
  } };
  const select = (extra = {}) => selectLyricSource({ sources: [workbench, file], order: ['lyrics-workbench', 'file'],
    song, adopt: true, onDiagnostic: row => diagnostics.push(row), ...extra });
  return { initial, store, workbench, file, calls, diagnostics, select };
}

test('a good unprocessed line file selected after a weak word-preference workbench candidate dispatches its matching adoption once', async () => {
  const f = await fixture(), selected = await f.select();
  assert.equal(selected.source.id, 'lyrics-workbench'); assert.equal(selected.result.translation.state, 'pending');
  assert.equal(f.calls.resolve, 1); assert.equal(f.calls.adopt, 1); assert.equal(f.calls.ai, 1);
  assert.deepEqual(selected.result.document.lines, f.initial.original.lines);
  assert.deepEqual(f.store.current().original, f.initial.original); assert.equal(f.store.current().offsetMs, f.initial.offsetMs);
});

test('same-asset handoff never promotes another original, source, timestamp, word timeline or offset over the selected file', async () => {
  const changes = [
    candidate => { candidate.document.lines[0].text = 'A different chosen original'; },
    candidate => { candidate.artifact.original.lines[0].text = 'A different saved original'; },
    candidate => { candidate.document.lines[0].time += .01; },
    candidate => { candidate.artifact.original.lines[0].endTime += .01; },
    candidate => { candidate.artifact.original.lines[0].words = [{ text: 'We', startTime: 1, endTime: 2 }]; },
    candidate => { candidate.artifact.offsetMs = 100; },
    candidate => { candidate.artifact.original.source = 'lrclib'; },
    candidate => { candidate.artifact.textHash = 'b'.repeat(64); },
    candidate => { candidate.etag = 'another-file-version'; },
    candidate => { candidate.etag = null; },
    candidate => { candidate.artifact.songId = 'another-song'; },
  ];
  for (const changeCandidate of changes) {
    const f = await fixture({ changeCandidate }), selected = await f.select();
    assert.equal(selected.source.id, 'file'); assert.deepEqual(selected.result.document.lines, f.initial.original.lines);
    assert.equal(f.calls.adopt, 0); assert.equal(f.calls.ai, 0); assert.equal(f.store.calls.put, 0);
  }
});

test('manual, assessed, failed and pending files do not enter file-to-workbench adoption', async () => {
  for (const options of [{ source: 'manual' }, { provenance: { evaluation: 'manual' } },
    { provenance: { managedBy: 'lyrics-workbench', evaluation: 'assessed', quality: 'good' } },
    { completion: { status: 'failed', errorCode: 'ai_timeout', updatedAt: new Date().toISOString() } },
    { completion: { status: 'pending', updatedAt: new Date().toISOString() } }]) {
    const f = await fixture(options), selected = await f.select();
    assert.equal(selected.source.id, 'file'); assert.equal(f.calls.adopt, 0); assert.equal(f.calls.ai, 0); assert.equal(f.store.calls.put, 0);
    assert.deepEqual(f.store.current(), f.initial);
  }
});

test('a valid provider target translation remains ready without starting AI during same-file handoff', async () => {
  const f = await fixture({ translation: {} }), selected = await f.select();
  assert.equal(selected.result.translation.state, 'ready'); assert.deepEqual(selected.result.translation.lines, f.initial.translation.lines);
  assert.equal(f.calls.ai, 0); assert.deepEqual(f.store.current().original, f.initial.original);
});

test('a failed handoff is not retried when file adoption also fails and another weak provider is considered', async () => {
  const f = await fixture({ rejectAdopt: true, fileAdoptFails: true });
  const other = { id: 'other', claim: () => true, resolve: async () => ({ quality: 'weak', document: createLyricDocument(f.initial.original),
    translation: { supported: false, state: 'unavailable' }, onAdopt: async () => { f.calls.otherAdopt++; return {
      quality: 'weak', document: createLyricDocument(f.initial.original), translation: { supported: false, state: 'unavailable' } }; } }) };
  const selected = await f.select({ sources: [f.workbench, other, f.file], order: ['lyrics-workbench', 'other', 'file'] });
  assert.equal(selected.source.id, 'other'); assert.equal(f.calls.adopt, 1); assert.equal(f.calls.otherAdopt, 1); assert.equal(f.calls.ai, 0);
  assert.equal(f.diagnostics.filter(row => row.sourceId === 'lyrics-workbench').length, 1);
});

test('a newer manual save made before file selection wins without invoking the old workbench adoption', async () => {
  const f = await fixture({ beforeFile: async ({ store }) => {
    const current = await store.get(song.id), edited = { ...current.artifact, offsetMs: 350,
      original: { ...current.artifact.original, source: 'manual', lines: [{ time: 2, text: 'A newly saved original' }] } };
    await store.putIfMatch(song.id, edited, current.etag);
  } });
  const selected = await f.select(); assert.equal(selected.source.id, 'file'); assert.equal(selected.result.artifact.offsetMs, 350);
  assert.equal(f.calls.adopt, 0); assert.equal(f.calls.ai, 0); assert.equal(f.store.current().original.lines[0].text, 'A newly saved original');
});

test('a save racing the handoff CAS is preserved and cannot start the stale candidate AI', async () => {
  const f = await fixture({ beforeAdopt: async ({ store }) => {
    const current = await store.get(song.id);
    await store.putIfMatch(song.id, { ...current.artifact, offsetMs: 600, provenance: { evaluation: 'manual' } }, current.etag);
  } });
  const selected = await f.select(); assert.equal(selected.source.id, 'file'); assert.equal(f.calls.adopt, 1); assert.equal(f.calls.ai, 0);
  assert.equal(f.store.current().offsetMs, 600); assert.equal(f.store.current().provenance.evaluation, 'manual');
});

test('concurrent selections retain one conditional winner and one AI start for the same file', async () => {
  const f = await fixture();
  const results = await Promise.all([f.select(), f.select()]);
  assert.ok(results.every(result => ['file', 'lyrics-workbench'].includes(result.source.id)));
  assert.equal(f.calls.ai, 1); assert.deepEqual(f.store.current().original, f.initial.original);
});

test('no adoption occurs when file comes first or selection is only previewed', async () => {
  for (const extra of [{ order: ['file', 'lyrics-workbench'] }, { adopt: false }]) {
    const f = await fixture(), selected = await f.select(extra);
    assert.equal(selected.source.id, 'file'); assert.equal(f.calls.adopt, 0); assert.equal(f.calls.ai, 0); assert.equal(f.store.calls.put, 0);
  }
});
