import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricArtifactStore } from './lyricArtifactStore.js';
import { readOrCreateLyricArtifact } from './lyricAssetWorkflow.js';
import { LYRIC_UPGRADE_INTERVAL_MS, fetchUpgradeDocument } from './lyricAssetUpgrade.js';
import { createMemoryR2Bucket, makeReadyArtifact, makeLyricDocument, makeSong } from '../test/lyricAssetFixtures.js';

const initialTime = Date.parse('2026-10-05T00:00:00Z');
const checkedAt = new Date(initialTime).toISOString();
const later = () => initialTime + LYRIC_UPGRADE_INTERVAL_MS;
const song = makeSong();
const lineArtifact = () => makeReadyArtifact({
  original: { source: 'kugou', format: 'lrc', syncMode: 'line', lines: [{ time: 1, text: 'Hello' }] },
  provenance: { matchedDuration: song.duration }, updatedAt: checkedAt,
});
function context() {
  const tasks = [];
  return { tasks, waitUntil(task) { tasks.push(task); },
    async finish() { await Promise.allSettled(tasks); } };
}
async function fixture(artifact = lineArtifact(), automatic = true) {
  const bucket = createMemoryR2Bucket();
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  await store.createIfAbsent(song.id, artifact, automatic ? { automation: { checkedAt } } : {});
  return { store, bucket };
}

test('bounded parallel upgrade preserves a completed result and cancels a stalled provider', async () => {
  const started = []; const aborted = [];
  const result = await fetchUpgradeDocument(song, async (provider, _song, { signal }) => {
    started.push(provider);
    if (provider === 'kugou') return makeLyricDocument();
    return new Promise(resolve => signal.addEventListener('abort', () => {
      aborted.push(provider); resolve(null);
    }, { once: true }));
  }, { budgetMs: 20 });
  assert.equal(started.length, 3);
  assert.equal(aborted.length, 2);
  assert.equal(result.source, 'kugou');
  assert.equal(result.syncMode, 'word');
});

test('a provider ignoring cancellation cannot hold the upgrade past its deadline', async () => {
  const result = await fetchUpgradeDocument(song, () => new Promise(() => {}), { budgetMs: 20 });
  assert.equal(result, null);
});

test('internal automatic ownership round-trips through R2 metadata, never JSON backups', async () => {
  const { store, bucket } = await fixture();
  const read = await store.get(song.id);
  assert.deepEqual(read.automation, { checkedAt });
  assert.equal('automation' in read.artifact, false);
  assert.equal(bucket.json(store.key(song.id)).schemaVersion, 1);
  await store.putIfMatch(song.id, read.artifact, read.etag);
  assert.equal((await store.get(song.id)).automation, undefined, 'ordinary manual save revokes replacement even for unchanged text');
});

test('first automatic fetch grants ownership but an imported copy does not', async () => {
  const store = createLyricArtifactStore({ MEDIA_BUCKET: createMemoryR2Bucket() });
  const first = await readOrCreateLyricArtifact({ env: {}, song, store, now: () => initialTime,
    fetchDocument: async (provider) => provider === 'kugou' ? makeLyricDocument() : null });
  assert.deepEqual((await store.get(song.id)).automation, { checkedAt });
  const imported = createLyricArtifactStore({ MEDIA_BUCKET: createMemoryR2Bucket() });
  await imported.createIfAbsent(song.id, JSON.parse(JSON.stringify(first.artifact)));
  assert.equal((await imported.get(song.id)).automation, undefined);
});

test('ready response stays line-synced while one background task upgrades the next read', async () => {
  const { store } = await fixture();
  const ctx = context();
  let calls = 0; let release;
  const held = new Promise(resolve => { release = resolve; });
  const fetchDocument = async provider => {
    calls += 1;
    await held;
    return provider === 'kugou' ? makeLyricDocument() : null;
  };
  const reads = await Promise.all(Array.from({ length: 4 }, () => readOrCreateLyricArtifact({
    env: {}, song, store, executionContext: ctx, now: later, fetchDocument,
  })));
  assert.ok(reads.every(read => read.artifact.original.syncMode === 'line'));
  release(); await ctx.finish();
  assert.equal(calls, 3, 'concurrent readers share one provider pass');
  assert.equal((await store.get(song.id)).artifact.original.syncMode, 'word');
});

test('manual edits and deletion markers win against an in-flight automatic upgrade', async t => {
  for (const action of ['manual', 'deleting']) await t.test(action, async () => {
    const { store } = await fixture(); const ctx = context();
    let release; let began;
    const started = new Promise(resolve => { began = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await readOrCreateLyricArtifact({ env: {}, song, store, executionContext: ctx, now: later,
      fetchDocument: async provider => { began(); await held; return provider === 'kugou' ? makeLyricDocument() : null; } });
    await started;
    const current = await store.get(song.id);
    const replacement = action === 'manual' ? { ...lineArtifact(), offsetMs: 250 }
      : { schemaVersion: 1, songId: song.id, status: 'deleting', operationId: 'deletion-1', updatedAt: checkedAt };
    await store.putIfMatch(song.id, replacement, current.etag);
    release(); await ctx.finish();
    const final = await store.get(song.id);
    assert.equal(final.automation, undefined);
    assert.deepEqual(final.artifact, replacement);
  });
});

test('failed background search keeps the existing lyric and persists a bounded cooldown', async () => {
  const { store } = await fixture(); const ctx = context(); let calls = 0;
  const fetchDocument = async () => { calls += 1; throw new Error('offline'); };
  const options = { env: {}, song, store, now: later, executionContext: ctx, fetchDocument };
  await readOrCreateLyricArtifact(options); await ctx.finish();
  const final = await store.get(song.id);
  assert.equal(final.artifact.status, 'ready');
  assert.equal(final.artifact.original.syncMode, 'line');
  assert.equal(calls, 3);
  await readOrCreateLyricArtifact(options); await ctx.finish();
  assert.equal(calls, 3, 'no immediate repeat or replacement with not_found');
});

test('unknown origin, manual content, offsets, word timing and pending AI never trigger an upgrade', async t => {
  const variants = [
    ['legacy', lineArtifact(), false],
    ['manual', { ...lineArtifact(), original: { ...lineArtifact().original, source: 'manual' } }, true],
    ['offset', { ...lineArtifact(), offsetMs: 50 }, true],
    ['word', makeReadyArtifact(), true],
    ['pending', { ...lineArtifact(), aiCompletion: { status: 'pending', updatedAt: checkedAt } }, true],
  ];
  for (const [name, artifact, automatic] of variants) await t.test(name, async () => {
    const { store } = await fixture(artifact, automatic); const ctx = context();
    await readOrCreateLyricArtifact({ env: {}, song, store, executionContext: ctx, now: later,
      fetchDocument: async () => { throw new Error('must not fetch'); } });
    assert.equal(ctx.tasks.length, 0);
  });
});

test('an unreliable duration or equal precision is never accepted as an upgrade', async t => {
  for (const [name, candidate] of [
    ['duration', makeLyricDocument({ providerMeta: { durationDelta: 14 } })],
    ['same-quality', makeLyricDocument({ format: 'lrc', lines: [{ time: 1, text: 'Different line' }] })],
    ['unknown-duration', makeLyricDocument({ providerMeta: {} })],
  ]) await t.test(name, async () => {
    const { store } = await fixture(); const ctx = context();
    await readOrCreateLyricArtifact({ env: {}, song, store, executionContext: ctx, now: later,
      fetchDocument: async provider => provider === 'kugou' ? candidate : null });
    await ctx.finish();
    assert.equal((await store.get(song.id)).artifact.original.syncMode, 'line');
  });
});
