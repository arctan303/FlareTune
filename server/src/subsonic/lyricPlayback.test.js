import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './test-support.js';
import { buildReadyLyricArtifact } from '../services/lyricAssetWorkflow.js';
import { DEFAULT_LYRIC_AI_CONFIG } from '../utils/lyricAiConfig.js';

const payload = async response => (await response.json())['subsonic-response'];
const config = (f, overrides = {}) => f.sqlite.prepare(`INSERT OR REPLACE INTO instance_settings
  (key,value_json,revision,updated_at,updated_by) VALUES ('lyrics.ai',?,1,1,'test')`)
  .run(JSON.stringify({ ...DEFAULT_LYRIC_AI_CONFIG, completionEnabled: false, ...overrides }));
async function saved(f, id, text = 'Hello', lines) {
  const song = f.sqlite.prepare('SELECT * FROM Songs WHERE id=?').get(id);
  const { artifact } = await buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc',
    lines: lines || [{ time: 1, text }] });
  f.objects.set(`media/lyrics/${id}.json`, { bytes: new TextEncoder().encode(JSON.stringify(artifact)), type: 'application/json' });
  return artifact;
}
function sourceStub(t, song, onFetch) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input); calls.push(url.hostname + url.pathname);
    onFetch?.(url);
    if (url.hostname === 'lyrics.kugou.com') return Response.json({ candidates: [] });
    if (url.hostname === 'music.163.com') return Response.json({ code: 200, result: { songs: [] } });
    assert.equal(url.hostname, 'lrclib.net');
    const candidate = { id: 201, trackName: song.title, artistName: song.artist, albumName: song.album,
      duration: song.duration, syncedLyrics: '[00:01.00]Hello\n[00:05.00]Sing together' };
    return Response.json(url.pathname.endsWith('/search') ? [candidate] : candidate);
  });
  return calls;
}

test('first authenticated third-party lyric read fetches and saves once without web playback; stream stays independent', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  f.sqlite.exec("UPDATE Songs SET title='First third-party play',language='en' WHERE id='s1'");
  const song = f.sqlite.prepare("SELECT * FROM Songs WHERE id='s1'").get();
  const calls = sourceStub(t, song); const tasks = [];
  assert.equal((await f.rest('stream', { id: 's1' })).status, 200);
  assert.equal(calls.length, 0); assert.equal(f.objects.has('media/lyrics/s1.json'), false);
  const options = { executionContext: { waitUntil: task => tasks.push(task) } };
  const first = await Promise.all([1, 2, 3].map(() => f.rest('getLyricsBySongId', { id: 's1' }, options).then(payload)));
  for (const result of first) {
    assert.equal(result.status, 'ok'); assert.equal(result.lyricsList.structuredLyrics[0].line[0].value, 'Hello');
  }
  await Promise.all(tasks);
  assert.ok(calls.length > 0); assert.equal(calls.filter(value => value === 'lrclib.net/api/get').length, 1);
  assert.ok(f.objects.has('media/lyrics/s1.json'));
  const prior = calls.length;
  assert.equal((await payload(await f.rest('getLyrics', { id: 's1' }))).lyrics.value, 'Hello\nSing together');
  const web = await (await f.api('lyrics?songId=s1')).json();
  assert.equal(web.data.lines[0].text, 'Hello'); assert.equal(calls.length, prior);
});

test('legacy optional parameters, id fallback and normalized emitted artists resolve saved lyrics', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  const provider = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No source query expected'); });
  for (const params of [{}, { artist: ' ', title: ' ' }]) {
    assert.deepEqual((await payload(await f.rest('getLyrics', params))).lyrics, {});
  }
  await saved(f, 's1');
  assert.equal((await payload(await f.rest('getLyrics', { id: 's1' }))).lyrics.value, 'Hello');
  for (const artist of [' Artist ', '', null]) {
    f.sqlite.prepare('UPDATE Songs SET artist=? WHERE id=?').run(artist, 's1');
    const song = (await payload(await f.rest('getSong', { id: 's1' }))).song;
    const result = await payload(await f.rest('getLyrics', { title: song.title, artist: song.artist }));
    assert.equal(result.lyrics.value, 'Hello');
  }
  assert.equal(provider.mock.calls.length, 0);
});

test('legacy duplicate names prefer an existing asset and do not fetch ambiguous missing recordings', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  const provider = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Ambiguous name must not fetch'); });
  f.sqlite.exec("UPDATE Songs SET title='Same name',artist='Artist' WHERE id IN ('s1','s2')");
  assert.deepEqual((await payload(await f.rest('getLyrics', { title: 'Same name', artist: 'Artist' }))).lyrics, {});
  await saved(f, 's2', 'Saved second version');
  assert.equal((await payload(await f.rest('getLyrics', { title: 'Same name', artist: 'Artist' }))).lyrics.value, 'Saved second version');
  assert.equal(provider.mock.calls.length, 0);
});

test('an unambiguous legacy name request also performs first-time source retrieval', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  f.sqlite.exec("UPDATE Songs SET title='Unique legacy first play',language='en' WHERE id='s1'");
  const song = f.sqlite.prepare("SELECT * FROM Songs WHERE id='s1'").get();
  const calls = sourceStub(t, song);
  const result = await payload(await f.rest('getLyrics', { title: song.title, artist: song.artist }));
  assert.equal(result.lyrics.value, 'Hello\nSing together');
  assert.ok(calls.length > 0); assert.ok(f.objects.has('media/lyrics/s1.json'));
});

test('instrumental and unauthorized requests do not read assets, fetch providers or start AI', async t => {
  const f = await fixture(); t.after(f.close); config(f, { completionEnabled: true });
  const provider = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external work expected'); });
  const before = f.mediaReads();
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }))).error.code, 40);
  await f.enable(); f.sqlite.exec("UPDATE Songs SET language='instrumental' WHERE id='s1'");
  assert.deepEqual((await payload(await f.rest('getLyricsBySongId', { id: 's1', enhanced: true }))).lyricsList.structuredLyrics, []);
  assert.equal((await payload(await f.rest('getLyrics', { id: 's1' }))).lyrics.value, '');
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1', t: 'bad' }))).error.code, 40);
  assert.equal(f.mediaReads(), before); assert.equal(provider.mock.calls.length, 0);
});

test('temporary provider failures return a retryable protocol failure and never save a no-lyrics marker', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  f.sqlite.exec("UPDATE Songs SET title='Temporary provider failure',language='en' WHERE id='s1'");
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const response = await f.rest('getLyricsBySongId', { id: 's1' });
  assert.equal(response.status, 503);
  assert.deepEqual((await payload(response)).error, { code: 0, message: 'Lyric source temporarily unavailable' });
  assert.equal(f.objects.has('media/lyrics/s1.json'), false);
});

test('confirmed empty providers return empty lyrics and persist a short-lived miss', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  f.sqlite.exec("UPDATE Songs SET title='Confirmed lyric miss',language='en' WHERE id='s1'");
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input); calls += 1;
    if (url.hostname === 'lyrics.kugou.com') return Response.json({ candidates: [] });
    if (url.hostname === 'music.163.com') return Response.json({ code: 200, result: { songs: [] } });
    assert.equal(url.hostname, 'lrclib.net');
    return url.pathname.endsWith('/get') ? new Response('', { status: 404 }) : Response.json([]);
  });
  assert.deepEqual((await payload(await f.rest('getLyricsBySongId', { id: 's1' }))).lyricsList.structuredLyrics, []);
  assert.equal(JSON.parse(new TextDecoder().decode(f.objects.get('media/lyrics/s1.json').bytes)).status, 'not_found');
  const before = calls;
  await f.rest('getLyricsBySongId', { id: 's1' }); assert.equal(calls, before);
});

test('deleting a song during source retrieval cannot recreate its lyric asset', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  f.sqlite.exec("UPDATE Songs SET title='Deleted during lyric fetch',language='en' WHERE id='s1'");
  const song = f.sqlite.prepare("SELECT * FROM Songs WHERE id='s1'").get();
  sourceStub(t, song, url => { if (url.hostname === 'lrclib.net') f.sqlite.exec("DELETE FROM Songs WHERE id='s1'"); });
  const result = await payload(await f.rest('getLyricsBySongId', { id: 's1' }));
  assert.equal(result.error.code, 70); assert.equal(f.objects.has('media/lyrics/s1.json'), false);
});

test('unreadable stored lyrics return protocol failure instead of empty lyrics or exposed storage details', async t => {
  const f = await fixture(); t.after(f.close); await f.enable(); config(f);
  f.objects.set('media/lyrics/s1.json', { bytes: new TextEncoder().encode('{broken-json'), type: 'application/json' });
  const response = await f.rest('getLyricsBySongId', { id: 's1' });
  assert.equal(response.status, 503);
  assert.deepEqual((await payload(response)).error, { code: 0, message: 'Lyric storage temporarily unavailable' });
});

test('member third-party playback follows both web automatic-AI switches and completes through waitUntil', async t => {
  for (const [completionEnabled, automaticCompletionEnabled] of [[false, true], [true, false], [true, true]]) {
    const f = await fixture();
    try {
      const member = await f.signIn('member'); await f.enable(member);
      config(f, { completionEnabled, automaticCompletionEnabled });
      f.sqlite.exec("UPDATE Songs SET language='en' WHERE id='s1'");
      await saved(f, 's1'); f.env.DEEPSEEK_API_KEY = 'test-only-key';
      const tasks = []; let aiCalls = 0;
      const mock = t.mock.method(globalThis, 'fetch', async input => {
        assert.ok(new URL(input).hostname.includes('deepseek'));
        aiCalls += 1;
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          songLanguage: 'en', discardLineIndices: [], translations: [{ unitId: 0, text: '你好' }],
        }) } }] });
      });
      const options = { username: 'member', executionContext: { waitUntil: task => tasks.push(task) } };
      const result = await payload(await f.rest('getLyricsBySongId', { id: 's1', enhanced: true }, options));
      assert.equal(result.status, 'ok');
      await Promise.all(tasks);
      const read = JSON.parse(new TextDecoder().decode(f.objects.get('media/lyrics/s1.json').bytes));
      if (completionEnabled && automaticCompletionEnabled) {
        assert.ok(tasks.length > 0); assert.equal(aiCalls, 1, JSON.stringify(read.aiCompletion)); assert.equal(read.translation?.lines[0], '你好');
        const refresh = await payload(await f.rest('getLyricsBySongId', { id: 's1', enhanced: true }, options));
        assert.equal(refresh.lyricsList.structuredLyrics[1].line[0].value, '你好');
        assert.equal(aiCalls, 1);
      } else { assert.equal(aiCalls, 0); assert.equal(read.aiCompletion, null); }
      mock.mock.restore();
    } finally { f.close(); }
  }
});
