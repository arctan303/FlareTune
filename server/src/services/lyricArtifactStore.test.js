import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LYRIC_ARTIFACT_SCHEMA_VERSION,
  LyricArtifactStoreError,
  LyricArtifactValidationError,
  buildLyricArtifactMarker,
  createLyricArtifactStore,
  validateLyricArtifact,
} from './lyricArtifactStore.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = '2026-09-10T12:00:00.000Z';

const legacyLyricPayload = (overrides = {}) => ({
  success: true,
  data: {
    source: 'Netease',
    type: 'synced',
    lyrics: '[00:01.00]Legacy lyric',
    translated_lyrics: '[00:01.00]旧译文',
  },
  ...overrides,
});

const readyArtifact = (overrides = {}) => ({
  schemaVersion: LYRIC_ARTIFACT_SCHEMA_VERSION,
  songId: 'song-1',
  status: 'ready',
  original: {
    source: 'kugou',
    format: 'krc',
    syncMode: 'word',
    lines: [{
      time: 1,
      endTime: 2,
      text: 'Hello',
      words: [{ text: 'Hello', startTime: 1, endTime: 2 }],
    }],
  },
  translation: {
    source: 'kugou',
    originalTextHash: HASH_A,
    lines: ['你好'],
    updatedAt: NOW,
  },
  aiCompletion: null,
  offsetMs: 0,
  textHash: HASH_A,
  provenance: {
    providerLyricId: '12345',
    matchedTitle: 'Hello',
    matchedArtist: 'Singer',
    matchedDuration: 255,
  },
  updatedAt: NOW,
  ...overrides,
});

const notFoundArtifact = (songId = 'song-1') => ({
  schemaVersion: LYRIC_ARTIFACT_SCHEMA_VERSION,
  songId,
  status: 'not_found',
  updatedAt: NOW,
});

class MemoryR2Bucket {
  constructor() {
    this.objects = new Map();
    this.putCalls = [];
    this.deleteCalls = [];
    this.nextEtag = 1;
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      size: new TextEncoder().encode(stored.text).byteLength,
      etag: stored.etag,
      httpEtag: `"${stored.etag}"`,
      text: async () => stored.text,
    };
  }

  async put(key, value, options = {}) {
    this.putCalls.push({ key, value, options });
    const existing = this.objects.get(key);
    if (options.onlyIf?.etagDoesNotMatch === '*' && existing) return null;
    if (options.onlyIf?.etagMatches !== undefined
      && (!existing || existing.etag !== options.onlyIf.etagMatches)) return null;
    const etag = `etag-${this.nextEtag++}`;
    const text = String(value);
    this.objects.set(key, { text, etag });
    return { size: new TextEncoder().encode(text).byteLength, etag, httpEtag: `"${etag}"` };
  }

  async delete(key) {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }
}

test('store uses the configured media prefix and reports a real miss separately from failures', async () => {
  const bucket = new MemoryR2Bucket();
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket, MEDIA_PREFIX: 'tenant/music' });
  assert.equal(store.key('song-1'), 'tenant/music/lyrics/song-1.json');
  assert.deepEqual(await store.get('song-1'), {
    state: 'missing',
    key: 'tenant/music/lyrics/song-1.json',
    artifact: null,
    etag: null,
  });
  assert.throws(() => store.key('../song'), LyricArtifactValidationError);
  assert.throws(
    () => createLyricArtifactStore({ MEDIA_PREFIX: 'media' }),
    (error) => error instanceof LyricArtifactStoreError && error.code === 'r2_unavailable',
  );
});

test('ready and not_found artifacts round-trip as canonical public JSON with ETags', async () => {
  const bucket = new MemoryR2Bucket();
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });

  const created = await store.createIfAbsent('song-1', readyArtifact());
  assert.equal(created.state, 'created');
  assert.equal(created.key, 'media/lyrics/song-1.json');
  assert.equal(created.etag, 'etag-1');
  assert.deepEqual((await store.get('song-1')).artifact, readyArtifact());
  assert.deepEqual(bucket.putCalls[0].options, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  assert.equal(bucket.putCalls[0].value.includes('accesskey'), false);

  const missingCreated = await store.createIfAbsent('song-2', notFoundArtifact('song-2'));
  assert.equal(missingCreated.state, 'created');
  const storedMissing = await store.get('song-2');
  assert.equal(storedMissing.state, 'found');
  assert.deepEqual(storedMissing.artifact, notFoundArtifact('song-2'));
});

test('completed analysis without a translation is a valid stored asset state', async () => {
  const store = createLyricArtifactStore({ MEDIA_BUCKET: new MemoryR2Bucket() });
  const artifact = readyArtifact({ translation: null,
    aiCompletion: { status: 'completed', processingKey: 'zh|1|1|1|0', updatedAt: NOW } });
  assert.equal((await store.createIfAbsent('song-1', artifact)).state, 'created');
  assert.deepEqual((await store.get('song-1')).artifact, artifact);
});

test('older completed markers without a processing key remain readable', async () => {
  const store = createLyricArtifactStore({ MEDIA_BUCKET: new MemoryR2Bucket() });
  const artifact = readyArtifact({ translation: null,
    aiCompletion: { status: 'completed', updatedAt: NOW } });
  assert.equal((await store.createIfAbsent('song-1', artifact)).state, 'created');
  assert.deepEqual((await store.get('song-1')).artifact, artifact);
});

test('current six-flag processing keys survive real storage CAS and invalid arities fail', async () => {
  const store = createLyricArtifactStore({ MEDIA_BUCKET: new MemoryR2Bucket() });
  await store.createIfAbsent('song-1', readyArtifact());
  const read = await store.get('song-1');
  const artifact = readyArtifact({ translation: null,
    aiCompletion: { status: 'completed', processingKey: 'zh|1|1|1|0|1|1', updatedAt: NOW } });
  await store.putIfMatch('song-1', artifact, read.etag);
  assert.deepEqual((await store.get('song-1')).artifact, artifact);
  for (const key of ['zh|1|1|1', 'zh|1|1|1|0|1', 'zh|1|1|1|0|1|1|1', 'zh|2|1|1|0|1|1']) {
    assert.equal(validateLyricArtifact(readyArtifact({ aiCompletion: {
      status: 'completed', processingKey: key, updatedAt: NOW,
    } })).valid, false);
  }
});

test('reset and deleting markers use a minimal strict public schema', async () => {
  const bucket = new MemoryR2Bucket();
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  const reset = buildLyricArtifactMarker('song-1', 'reset', {
    now: Date.parse(NOW),
  });
  const deleting = buildLyricArtifactMarker('song-2', 'deleting', {
    now: Date.parse(NOW),
    operationId: 'delete-operation_1',
  });
  assert.equal((await store.createIfAbsent('song-1', reset)).state, 'created');
  assert.equal((await store.createIfAbsent('song-2', deleting)).state, 'created');
  assert.deepEqual((await store.get('song-1')).artifact, reset);
  assert.deepEqual((await store.get('song-2')).artifact, deleting);
  assert.equal(validateLyricArtifact({ ...reset, reason: 'private' }).valid, false);
  assert.equal(validateLyricArtifact({ ...deleting, operationId: '../unsafe' }).valid, false);
  assert.throws(
    () => buildLyricArtifactMarker('song-1', 'deleting', { now: Date.parse(NOW) }),
    LyricArtifactValidationError,
  );
});

test('strict schema rejects private fields, foreign song ids, unsafe values, and non-canonical lyrics', () => {
  const cases = [
    readyArtifact({ accesskey: 'secret' }),
    readyArtifact({ songId: 'other-song' }),
    readyArtifact({ offsetMs: 5_001 }),
    readyArtifact({ textHash: 'not-a-hash' }),
    readyArtifact({
      provenance: { ...readyArtifact().provenance, downloadUrl: 'https://private.test/file' },
    }),
    readyArtifact({
      translation: { ...readyArtifact().translation, accesskey: 'secret' },
    }),
    readyArtifact({
      original: { ...readyArtifact().original, syncMode: 'line' },
    }),
    readyArtifact({
      original: { ...readyArtifact().original, tlyric: 'must be split out' },
    }),
    readyArtifact({
      translation: { ...readyArtifact().translation, originalTextHash: HASH_B },
    }),
  ];
  for (const artifact of cases) {
    const result = validateLyricArtifact(artifact, { expectedSongId: 'song-1' });
    assert.equal(result.valid, false, JSON.stringify(artifact));
  }
  const oversized = validateLyricArtifact(readyArtifact(), { maxBytes: 32 });
  assert.equal(oversized.valid, false);
  assert.match(oversized.errors[0], /byte limit/);
});

test('create-if-absent has one winner and never overwrites the existing object', async () => {
  const bucket = new MemoryR2Bucket();
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  const first = readyArtifact();
  const second = readyArtifact({
    textHash: HASH_B,
    translation: null,
    updatedAt: '2026-09-10T12:01:00.000Z',
  });

  const winner = await store.createIfAbsent('song-1', first);
  const loser = await store.createIfAbsent('song-1', second);
  assert.equal(winner.state, 'created');
  assert.deepEqual(loser, {
    state: 'conflict',
    key: 'media/lyrics/song-1.json',
    artifact: null,
    etag: null,
  });
  assert.deepEqual((await store.get('song-1')).artifact, first);
});

test('ETag conditional put updates only the version that was read', async () => {
  const bucket = new MemoryR2Bucket();
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  await store.createIfAbsent('song-1', readyArtifact());
  const read = await store.get('song-1');
  const updatedArtifact = readyArtifact({ offsetMs: 50, updatedAt: '2026-09-10T12:02:00.000Z' });

  const updated = await store.putIfMatch('song-1', updatedArtifact, read.etag);
  assert.equal(updated.state, 'updated');
  assert.equal(updated.etag, 'etag-2');
  assert.deepEqual(bucket.putCalls.at(-1).options.onlyIf, { etagMatches: 'etag-1' });

  const stale = await store.putIfMatch('song-1', readyArtifact({ offsetMs: 100 }), read.etag);
  assert.equal(stale.state, 'conflict');
  assert.equal((await store.get('song-1')).artifact.offsetMs, 50);
  assert.throws(() => store.putIfMatch('song-1', readyArtifact(), ''), LyricArtifactValidationError);
});

test('known pre-Phase-72 lyric payloads retain exact bytes as explicit legacy state', async () => {
  const payloads = [
    legacyLyricPayload(),
    legacyLyricPayload({
      data: {
        source: 'LRCLib',
        type: 'plain',
        lyrics: 'Legacy plain lyric',
        translated_lyrics: '',
      },
    }),
    legacyLyricPayload({
      success: false,
      data: { source: '', type: 'plain', lyrics: '', translated_lyrics: '' },
    }),
  ];

  for (const [index, payload] of payloads.entries()) {
    const bucket = new MemoryR2Bucket();
    const legacyText = JSON.stringify(payload, null, 2);
    bucket.objects.set('media/lyrics/song-1.json', {
      text: legacyText,
      etag: `legacy-etag-${index}`,
    });
    const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
    assert.deepEqual(await store.get('song-1'), {
      state: 'legacy',
      key: 'media/lyrics/song-1.json',
      artifact: null,
      etag: `legacy-etag-${index}`,
      legacyText,
    });
  }
});

test('legacy restoration is exact, validated, and scoped to the deleting marker ETag', async () => {
  const key = 'media/lyrics/song-1.json';
  const legacyText = JSON.stringify(legacyLyricPayload(), null, 2);
  const bucket = new MemoryR2Bucket();
  bucket.objects.set(key, { text: legacyText, etag: 'legacy-etag' });
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket });
  const previous = await store.get('song-1');
  const deleting = buildLyricArtifactMarker('song-1', 'deleting', {
    now: Date.parse(NOW),
    operationId: 'delete-legacy-1',
  });
  const prepared = await store.putIfMatch('song-1', deleting, previous.etag);

  assert.equal((await store.restoreLegacyIfMatch('song-1', legacyText, previous.etag)).state, 'conflict');
  assert.equal((await store.restoreLegacyIfMatch('song-1', legacyText, prepared.etag)).state, 'updated');
  assert.equal(bucket.objects.get(key).text, legacyText);
  await assert.rejects(
    store.restoreLegacyIfMatch(
      'song-1',
      JSON.stringify(legacyLyricPayload({ accesskey: 'must-not-be-restored' })),
      bucket.objects.get(key).etag,
    ),
    LyricArtifactValidationError,
  );
});

test('invalid stored data and R2 read failures are typed errors, not misses', async () => {
  const malformedBucket = new MemoryR2Bucket();
  malformedBucket.objects.set('media/lyrics/song-1.json', { text: '{bad json', etag: 'bad-1' });
  const malformedStore = createLyricArtifactStore({ MEDIA_BUCKET: malformedBucket });
  await assert.rejects(
    malformedStore.get('song-1'),
    (error) => error instanceof LyricArtifactStoreError && error.code === 'invalid_stored_artifact',
  );

  const unknownShapeBucket = new MemoryR2Bucket();
  unknownShapeBucket.objects.set('media/lyrics/song-1.json', {
    text: JSON.stringify(legacyLyricPayload({ accesskey: 'must-not-be-migrated' })),
    etag: 'unknown-1',
  });
  const unknownShapeStore = createLyricArtifactStore({ MEDIA_BUCKET: unknownShapeBucket });
  await assert.rejects(
    unknownShapeStore.get('song-1'),
    (error) => error instanceof LyricArtifactStoreError && error.code === 'invalid_stored_artifact',
  );

  const failedStore = createLyricArtifactStore({
    MEDIA_BUCKET: {
      async get() { throw new Error('temporary R2 outage'); },
      async put() { throw new Error('temporary R2 outage'); },
      async delete() { throw new Error('temporary R2 outage'); },
    },
  });
  await assert.rejects(
    failedStore.get('song-1'),
    (error) => error instanceof LyricArtifactStoreError && error.code === 'r2_read_failed',
  );
  await assert.rejects(
    failedStore.createIfAbsent('song-1', readyArtifact()),
    (error) => error instanceof LyricArtifactStoreError && error.code === 'r2_write_failed',
  );
  await assert.rejects(
    failedStore.delete('song-1'),
    (error) => error instanceof LyricArtifactStoreError && error.code === 'r2_delete_failed',
  );
});

test('delete is scoped to the fixed lyrics key', async () => {
  const bucket = new MemoryR2Bucket();
  const store = createLyricArtifactStore({ MEDIA_BUCKET: bucket, MEDIA_PREFIX: 'local' });
  await store.createIfAbsent('song-1', readyArtifact());
  const result = await store.delete('song-1');
  assert.deepEqual(result, { state: 'deleted', key: 'local/lyrics/song-1.json' });
  assert.deepEqual(bucket.deleteCalls, ['local/lyrics/song-1.json']);
  assert.equal((await store.get('song-1')).state, 'missing');
});

test('singleflight shares one in-flight task per song and clears success or failure', async () => {
  const store = createLyricArtifactStore({ MEDIA_BUCKET: new MemoryR2Bucket() });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = store.singleflight('song-1', async () => {
    calls += 1;
    await gate;
    return 'winner';
  });
  const second = store.singleflight('song-1', async () => {
    calls += 1;
    return 'loser';
  });
  assert.equal(first, second);
  release();
  assert.equal(await first, 'winner');
  assert.equal(calls, 1);
  assert.equal(await store.singleflight('song-1', async () => 'next'), 'next');

  await assert.rejects(store.singleflight('song-2', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await store.singleflight('song-2', async () => 'retry'), 'retry');
});
