import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocalMetadataReadRoute } from '../routes/localMetadataRead.js';
import { youtubeLyricDependencies } from '../routes/youtubeIntegration.js';
import { readPlaybackLyrics } from './playbackLyrics.js';
import { createLyricDocument } from '../utils/lyricDocument.js';
import { isLyricSourceId } from '../../../shared/lyricSources.js';
import { createMemoryLyricStore, makeLyricDocument, makeReadyArtifact, makeSong } from '../test/lyricAssetFixtures.js';

const song = makeSong({ id: 'yt:WqkrwFSFeAE', title: 'Example', artist: 'Singer', language: null });
const native = () => createLyricDocument({ source: 'youtube', format: 'plain',
  lines: [{ text: 'First native line' }, { text: 'Second native line' }],
  providerMeta: { matchedDuration: song.duration, durationDelta: 0 } });
const db = { prepare(sql) {
  assert.doesNotMatch(sql, /\bSongs\b/u);
  return { bind() { return this; }, first: async () => null, all: async () => ({ results: [] }) };
} };
const read = async deps => {
  const req = new Request('https://tune.test/api/lyrics?songId=' + encodeURIComponent(song.id));
  const response = await handleLocalMetadataReadRoute(req, new URL(req.url), db, {}, 'member', {}, {
    resolveSong: async () => song, songStillExists: async () => true, ...deps,
  });
  return { status: response.status, body: await response.json() };
};

test('ordinary YT playback automatically caches native plain lyrics once without fabricated timestamps', async () => {
  const store = createMemoryLyricStore(); let calls = 0;
  const deps = { store, fetchDocument: async () => null, fetchNativeDocument: async () => { calls++; return native(); } };
  for (let n = 0; n < 2; n++) {
    const result = await read(deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.source, 'youtube');
    assert.equal(result.body.data.syncMode, 'none');
    assert.equal(result.body.data.lines.length, 2);
    assert.ok(result.body.data.lines.every(line => !Object.hasOwn(line, 'time')));
  }
  assert.equal(calls, 1);
  assert.equal(store.calls.create, 1);
  assert.equal(isLyricSourceId('youtube'), false, 'native source cannot be selected as a configurable scraper');
});

test('native lyrics survive scraper failures, while native failures preserve an automatic timed match', async () => {
  const fromNative = await read({ store: createMemoryLyricStore(), fetchDocument: async () => { throw new Error('source down'); },
    fetchNativeDocument: async () => native() });
  assert.equal(fromNative.status, 200);
  assert.equal(fromNative.body.data.source, 'youtube');
  const fromScraper = await read({ store: createMemoryLyricStore(),
    fetchDocument: async source => source === 'lrclib' ? makeLyricDocument({ source, format: 'lrc', lines: [{ time: 1, text: 'Timed match' }] }) : null,
    fetchNativeDocument: async () => { throw new Error('private upstream error'); } });
  assert.equal(fromScraper.status, 200);
  assert.equal(fromScraper.body.data.syncMode, 'line');
  assert.equal(fromScraper.body.data.source, 'lrclib');
});

test('the automatic timed match wins over plain native text on first playback', async () => {
  const result = await read({ store: createMemoryLyricStore(), fetchNativeDocument: async () => native(),
    fetchDocument: async source => source === 'lrclib' ? makeLyricDocument({ source, format: 'lrc', lines: [{ time: 1, text: 'Timed match' }],
      providerMeta: { matchedDuration: song.duration, durationDelta: 0 } }) : null });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.source, 'lrclib');
  assert.equal(result.body.data.syncMode, 'line');
});

test('temporary native failure with no automatic match does not write a negative cache', async () => {
  const store = createMemoryLyricStore();
  const result = await read({ store, fetchDocument: async () => null,
    fetchNativeDocument: async () => { throw new Error('private upstream error'); } });
  assert.equal(result.status, 503);
  assert.equal(store.calls.create, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /private upstream/);
});

test('native completion after source retirement cannot create a lyric asset', async () => {
  const store = createMemoryLyricStore(); let active = true;
  const result = await read({ store, songStillExists: async () => active, fetchDocument: async () => null,
    fetchNativeDocument: async () => { active = false; return native(); } });
  assert.equal(result.status, 404);
  assert.equal(store.calls.create, 0);
});

for (const ready of [true, false]) for (const abortAt of [1, 2]) {
  test(`last-consumer cancellation during authority check ${abortAt} prevents a ${ready ? 'ready' : 'negative'} write`, async () => {
    const store = createMemoryLyricStore(); const controller = new AbortController();
    let fetched = false, checks = 0;
    await assert.rejects(readPlaybackLyrics({ env: {}, db, song, signal: controller.signal, deps: {
      store, fetchDocument: async () => null,
      fetchNativeDocument: async () => { fetched = true; return ready ? native() : null; },
      songStillExists: async () => {
        if (fetched && ++checks === abortAt) controller.abort();
        return true;
      },
    } }), { name: 'AbortError' });
    assert.equal(store.calls.create, 0);
    assert.equal(store.calls.put, 0);
  });
}

test('an existing manual lyric document remains unchanged and local songs never call native YouTube', async () => {
  const artifact = makeReadyArtifact({ songId: song.id, original: { source: 'manual', format: 'lrc', syncMode: 'line',
    lines: [{ text: 'Existing human edit', time: 1 }] } });
  // Build through the fixture's normal canonical document rather than depending
  // on caller-supplied metadata fields to authorize a replacement.
  const store = createMemoryLyricStore(artifact); let nativeCalls = 0;
  const result = await read({ store, fetchDocument: async () => { throw new Error('must not fetch'); },
    fetchNativeDocument: async () => { nativeCalls++; return native(); } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.source, 'manual');
  assert.equal(result.body.data.lines[0].text, 'Existing human edit');
  assert.equal(nativeCalls, 0);
  const localSong = makeSong({ id: 'local', language: 'en' });
  const localDb = { prepare() { return { bind() { return this; }, first: async () => localSong }; } };
  await readPlaybackLyrics({ env: {}, db: localDb, song: localSong, deps: {
    store: createMemoryLyricStore(), fetchDocument: async source => source === 'lrclib' ? makeLyricDocument({ source }) : null,
    fetchNativeDocument: async () => { nativeCalls++; return native(); },
  } });
  assert.equal(nativeCalls, 0);
});

test('native lyric bridge shares captured authority, validates exact ID and retains untimed line structure', async () => {
  let accesses = 0, checks = 0, live = true;
  const deps = youtubeLyricDependencies({}, {}, {}, { getAccess: async () => {
    accesses++;
    return { assertCurrent: async () => { checks++; if (!live) throw new Error('retired'); return true; },
      service: { song: async () => song, lyrics: async id => {
        assert.equal(id, 'WqkrwFSFeAE'); return { status: 'available', text: 'Native one\nNative two' };
      } } };
  } });
  assert.equal(await deps.fetchNativeDocument({ id: 'yt:invalid' }), null);
  assert.equal((await deps.resolveSong(song.id)).id, song.id);
  const document = await deps.fetchNativeDocument(song);
  assert.equal(document.syncMode, 'none');
  assert.equal(document.lines.length, 2);
  live = false;
  await assert.rejects(deps.fetchNativeDocument(song));
  assert.equal(await deps.songStillExists(song.id), false);
  assert.equal(accesses, 1);
  assert.ok(checks >= 3);
});

test('native line cues survive the host bridge and canonical asset instead of being flattened into plain text', async () => {
  const deps = youtubeLyricDependencies({}, {}, {}, { getAccess: async () => ({ assertCurrent: async () => true,
    service: { lyrics: async () => ({ status: 'available', text: 'One\nTwo', syncMode: 'line',
      lines: [{ text: 'One', time: 2.75, endTime: 6.59 }, { text: 'Two', time: 6.59, endTime: 11.52 }] }) },
  }) });
  const store = createMemoryLyricStore();
  const result = await read({ store, ...deps, resolveSong: async () => song, fetchDocument: async () => null });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.source, 'youtube');
  assert.equal(result.body.data.syncMode, 'line');
  assert.equal(result.body.data.lines[0].time, 2.75);
  assert.equal(store.current().original.lines[1].endTime, 11.52);
});

test('an eligible cached native plain asset can automatically upgrade to real native timing', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact({ songId: song.id, original: {
    source: 'youtube', format: 'plain', syncMode: 'none', lines: [{ text: 'Old plain line' }],
  } }));
  const originalGet = store.get;
  store.get = async id => ({ ...await originalGet(id), automation: { checkedAt: '2026-01-01T00:00:00.000Z' } });
  const tasks = [];
  await readPlaybackLyrics({ env: {}, db, song, executionContext: { waitUntil: task => tasks.push(task) }, deps: {
    store, songStillExists: async () => true, fetchDocument: async () => null,
    fetchNativeDocument: async () => createLyricDocument({ source: 'youtube', format: 'lrc',
      lines: [{ text: 'Native timed line', time: 2.75, endTime: 6.59 }],
      providerMeta: { matchedDuration: song.duration, durationDelta: 0 } }),
  } });
  await Promise.all(tasks);
  assert.ok(tasks.length > 0);
  assert.equal(store.current().original.source, 'youtube');
  assert.equal(store.current().original.syncMode, 'line');
  assert.equal(store.current().original.lines[0].time, 2.75);
});
