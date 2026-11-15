import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricDocument } from '../utils/lyricDocument.js';
import { buildReadyLyricArtifact } from './lyricAssetWorkflow.js';
import { selectLyricSource, normalizeLyricSourceResult, effectiveLyricSourceOrder, validateLyricSourceOrder,
  issueLyricResultRef, verifyLyricResultRef, persistAdoptedLyricResult, readLyricsFromChain, fileLyricSource } from './lyricSourceChain.js';
import { computeHash } from '../utils/lyricsParsing.js';
import { projectLyricArtifact } from './lyricAssetWorkflow.js';
import { lyricRouteErrorMessage } from '../routes/lyricSourceRoutes.js';

const song = { id: 's1', title: 'Test', artist: 'Artist', duration: 30, language: 'en' };
const document = createLyricDocument({ source: 'manual', format: 'lrc', lines: [{ text: 'First line', time: 1 }, { text: 'Second line', time: 3 }] });
const value = (quality = 'good') => ({ quality, document, translation: { supported: false, state: 'unavailable' } });
const provider = (id, resolve) => ({ id, claim: () => true, resolve, assertCurrent: async () => {}, epoch: 'epoch', build: 'build' });
const env = { SETUP_SECRET: 'test-setup-secret-with-at-least-32-characters' };
const session = { account: { accountId: 'a1', role: 'admin' }, tokenHash: 'session-hash', mode: 'normal' };
const memory = initial => {
  let artifact = initial;
  let writes = 0;
  return { get: async () => ({ state: artifact ? 'found' : 'missing', artifact, etag: artifact ? 'v1' : null }),
    createIfAbsent: async (_id, next) => { writes++; artifact ||= next; return { state: 'created', artifact, etag: 'v2' }; },
    putIfMatch: async (_id, next) => { writes++; artifact = next; return { state: 'updated', artifact, etag: 'v2' }; },
    current: () => artifact, writes: () => writes };
};
const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

test('first good wins after retaining weak; later sources are not called', async () => {
  const called = [];
  const sources = ['first', 'second', 'third'].map(id => provider(id, async () => { called.push(id); return value(id === 'first' ? 'weak' : 'good'); }));
  const selected = await selectLyricSource({ sources, order: sources.map(s => s.id), song });
  assert.equal(selected.source.id, 'second'); assert.deepEqual(called, ['first', 'second']);
});
test('all weak returns first; empty and nonclaims are skipped', async () => {
  const sources = [provider('empty', () => null), { ...provider('not-mine', () => assert.fail()), claim: () => false }, provider('first', () => value('weak')), provider('last', () => value('weak'))];
  assert.equal((await selectLyricSource({ sources, order: sources.map(s => s.id), song })).source.id, 'first');
});
test('source failure or timeout continues and emits only safe diagnostic codes', async () => {
  const diagnostics = [];
  const timed = { ...provider('slow', (_s, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private text'))))), timeoutMs: 5 };
  const sources = [provider('broken', () => { throw new Error('private token'); }), timed, provider('file', () => value())];
  assert.equal((await selectLyricSource({ sources, order: sources.map(s => s.id), song, onDiagnostic: row => diagnostics.push(row) })).source.id, 'file');
  assert.equal(diagnostics.length, 2); assert.ok(!JSON.stringify(diagnostics).includes('private'));
});
test('source faults without a fallback remain retryable rather than becoming not found', async () => {
  for (const broken of [provider('broken', () => { throw new Error('private upstream detail'); }),
    { ...provider('slow', () => new Promise(() => {})), timeoutMs: 5 },
    provider('adoption', () => ({ ...value(), onAdopt: () => { throw new Error('write failed'); } }))]) {
    const sources = [broken, provider('file', () => null)];
    await assert.rejects(selectLyricSource({ sources, order: sources.map(source => source.id), song, adopt: true }),
      error => error.name === 'LyricSourceError' && !error.message.includes('private'));
  }
  assert.equal(await selectLyricSource({ sources: [provider('file', () => null)], order: ['file'], song }), null);
  const sources = [provider('broken', () => { throw new Error('upstream'); }), provider('weak', () => value('weak'))];
  assert.equal((await selectLyricSource({ sources, order: ['broken', 'weak'], song })).source.id, 'weak');
});
test('parent cancellation does not try another source', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectLyricSource({ sources: [provider('file', () => assert.fail())], order: ['file'], song, signal: controller.signal }));
});
test('a translation must be paired with all canonical rows', () => {
  assert.throws(() => normalizeLyricSourceResult({ ...value(), translation: { supported: true, state: 'ready', lines: ['译文'] } }, 'first'));
  const normalized = normalizeLyricSourceResult({ ...value(), translation: { supported: true, state: 'idle' } }, 'first');
  assert.equal(normalized.translation.supported, true); assert.equal(normalized.translation.state, 'idle');
});
test('the host filters same-language provider rewrites and copied rows before advertising translation', () => {
  const chinese = { ...song, language: 'zh' };
  const chineseDocument = createLyricDocument({ source: 'youtube', format: 'lrc',
    lines: [{ text: '把心事写在日记里', time: 1 }] });
  const normalized = normalizeLyricSourceResult({ quality: 'good', document: chineseDocument,
    translation: { supported: true, state: 'ready', language: 'zh-CN', targetLanguage: 'zh-CN',
      source: 'youtube', lines: ['将心事记在本子上'] } }, 'youtube-music', chinese);
  assert.equal(normalized.translation.supported, false);
  assert.equal(normalized.translation.state, 'not_needed');
  const copied = normalizeLyricSourceResult({ ...value(), translation: { supported: true, state: 'ready',
    language: 'zh', source: 'youtube', lines: document.lines.map(line => line.text) } }, 'youtube-music', song);
  assert.equal(copied.translation.supported, true);
  assert.equal(copied.translation.state, 'failed');
  const partial = normalizeLyricSourceResult({ ...value(), translation: { supported: true, state: 'ready',
    language: 'zh', source: 'youtube', lines: [document.lines[0].text, '第二行'] } }, 'youtube-music', song);
  assert.deepEqual(partial.translation.lines, ['', '第二行']);
  const embedded = normalizeLyricSourceResult({ ...value(), document: { ...document,
    lines: document.lines.map(line => ({ ...line, tlyric: 'undeclared translation' })) } }, 'provider', song);
  assert.ok(embedded.document.lines.every(line => !Object.hasOwn(line, 'tlyric')));
});
test('order excludes retired sources, preserves remaining relative order and appends new providers', () => {
  assert.deepEqual(effectiveLyricSourceOrder(['youtube-music', 'gone', 'file', 'lyrics-workbench'], ['file', 'lyrics-workbench', 'new']), ['file', 'lyrics-workbench', 'new']);
  assert.throws(() => validateLyricSourceOrder(['file', 'file']));
});
test('result refs reject tampering, another account/session and expiry', async () => {
  const identity = { accountId: 'a1', sessionHash: 'owner' };
  const ticket = await issueLyricResultRef(env, { ...identity, sourceId: 'source', songId: 's1', textHash: 'a'.repeat(64), expiresAt: Date.now() + 5000 });
  assert.equal((await verifyLyricResultRef(env, ticket, identity)).sourceId, 'source');
  await assert.rejects(verifyLyricResultRef(env, ticket, { ...identity, accountId: 'other' }));
  await assert.rejects(verifyLyricResultRef(env, ticket, { ...identity, sessionHash: 'other' }));
  await assert.rejects(verifyLyricResultRef(env, ticket.slice(0, -2) + 'ZZ', identity));
  await assert.rejects(verifyLyricResultRef(env, ticket, identity, Date.now() + 10000));
});
test('adopted source fills empty file with provenance and valid paired translation', async () => {
  const store = memory(); const source = provider('youtube-music', () => {});
  const result = { ...value(), document: { ...document, source: 'youtube' }, translation: { supported: true, state: 'ready', source: 'youtube', kind: 'machine', language: 'zh-CN', lines: ['第一行', '第二行'] } };
  await persistAdoptedLyricResult({ store, song, source, result });
  assert.equal(store.current().provenance.managedBy, 'youtube-music');
  assert.equal(store.current().provenance.evaluation, 'unassessed');
  assert.equal(store.current().translation.originalTextHash, store.current().textHash);
});
test('another source and changed text cannot overwrite a protected or old unowned file', async () => {
  const built = (await buildReadyLyricArtifact(song, document)).artifact;
  for (const provenance of [{}, { managedBy: 'lyrics-workbench', evaluation: 'assessed' }, { managedBy: 'youtube-music', evaluation: 'manual' }]) {
    const store = memory({ ...built, provenance });
    await persistAdoptedLyricResult({ store, song, source: provider('youtube-music', () => {}), result: { ...value(), document: { ...document, lines: [{ text: 'Changed text', time: 1 }] } } });
    assert.equal(store.writes(), 0);
  }
});
test('only the adopted source runs its hook; fixed result polling retains original source', async () => {
  let adopted = 0; const store = memory();
  const sources = [provider('first', () => ({ ...value('weak'), onAdopt: () => assert.fail('losing source') })),
    provider('second', () => ({ ...value(), onAdopt: async () => { adopted++; return value(); } }))];
  const deps = { sources, store, requireSession: async () => ({ accountId: 'a1' }) };
  const read = await readLyricsFromChain({ env, db, session, song, deps });
  assert.equal(read.lyrics.sourceId, 'second'); assert.equal(adopted, 1);
  const polled = await readLyricsFromChain({ env, db, session, song, resultRef: read.lyrics.resultRef,
    deps: { ...deps, sources: [provider('first', () => value()), sources[1]] } });
  assert.equal(polled.lyrics.sourceId, 'second'); assert.equal(adopted, 1);
});
test('a retired installation and changed original reject old result refs', async () => {
  const source = provider('first', () => value());
  const deps = { sources: [source], store: memory(), requireSession: async () => ({ accountId: 'a1' }) };
  const read = await readLyricsFromChain({ env, db, session, song, deps });
  await assert.rejects(readLyricsFromChain({ env, db, session, song, resultRef: read.lyrics.resultRef,
    deps: { ...deps, sources: [{ ...source, epoch: 'new' }] } }), e => e.code === 'LYRIC_RESULT_RETIRED');
  await assert.rejects(readLyricsFromChain({ env, db, session, song, resultRef: read.lyrics.resultRef,
    deps: { ...deps, sources: [{ ...source, resolve: () => ({ ...value(), document: { ...document, lines: [{ text: 'New line', time: 1 }] } }) }] } }), e => e.code === 'LYRIC_RESULT_CHANGED');
});
test('file source reads known legacy lyrics without a workbench or any write', async () => {
  const source = fileLyricSource({ get: async () => ({ state: 'legacy', legacyText: JSON.stringify({ success: true,
    data: { source: 'LRCLib', type: 'synced', lyrics: '[00:01.00]Original', translated_lyrics: '[00:01.00]译文' } }) }) });
  const result = await source.resolve(song);
  assert.equal(result.document.lines[0].text, 'Original'); assert.equal(result.translation.state, 'ready');
  assert.deepEqual(result.translation.lines, ['译文']);
});
test('failed adoption continues to the next good source before considering a weak result', async () => {
  const calls = [];
  const sources = [provider('weak', () => value('weak')),
    provider('stale', () => ({ ...value(), onAdopt: () => { throw new Error('stale'); } })),
    provider('file', () => { calls.push('file'); return value(); })];
  const selected = await selectLyricSource({ sources, order: sources.map(source => source.id), song, adopt: true });
  assert.equal(selected.source.id, 'file'); assert.deepEqual(calls, ['file']);
});
test('generic adoption never overwrites a nonempty unowned legacy file', async () => {
  let writes = 0;
  await persistAdoptedLyricResult({ store: { get: async () => ({ state: 'legacy', artifact: null, etag: 'old' }),
    putIfMatch: () => writes++, createIfAbsent: () => writes++ }, song, source: provider('youtube-music', () => {}), result: value() });
  assert.equal(writes, 0);
});
test('an existing YT Chinese translation satisfies a generic Chinese target without regeneration', async () => {
  const built = (await buildReadyLyricArtifact(song, document)).artifact;
  const artifact = { ...built, translation: { source: 'youtube', kind: 'machine', language: 'zh-CN',
    lines: ['第一行', '第二行'], originalTextHash: built.textHash, updatedAt: built.updatedAt } };
  assert.equal(projectLyricArtifact(artifact, { song, targetLanguage: 'zh' }).translationAvailable, true);
  assert.equal(projectLyricArtifact(artifact, { song, targetLanguage: 'zh-TW' }).translationAvailable, false);
});
test('a timing-only change retires the playback result but preserves reusable text identity', async () => {
  const source = provider('first', () => value());
  const deps = { sources: [source], store: memory(), requireSession: async () => ({ accountId: 'a1' }) };
  const read = await readLyricsFromChain({ env, db, session, song, deps });
  const changed = { ...source, resolve: () => ({ ...value(), document: { ...document,
    lines: document.lines.map(line => ({ ...line, time: line.time + 1 })) } }) };
  await assert.rejects(readLyricsFromChain({ env, db, session, song, resultRef: read.lyrics.resultRef,
    deps: { ...deps, sources: [changed] } }), error => error.code === 'LYRIC_RESULT_CHANGED');
});
test('unified errors are localized and ticket refs cannot serialize upstream credentials', async () => {
  assert.match(lyricRouteErrorMessage(409, 'en-US'), /Reload/);
  assert.match(lyricRouteErrorMessage(403, 'ja'), /権限/);
  assert.match(lyricRouteErrorMessage(503, 'ko'), /가사/);
  assert.match(lyricRouteErrorMessage(409, 'zh-TW'), /載入/);
  await assert.rejects(issueLyricResultRef(env, { sourceRef: { continuationToken: 'private' } }));
});
