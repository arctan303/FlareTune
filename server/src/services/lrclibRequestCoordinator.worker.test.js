import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise the production workspace route, source configuration and adapters.
// Only session/database/storage and LRCLIB itself are local deterministic fakes.
const script = `
  import { handleLocalLyricsManageRoute } from './server/src/routes/localLyricsManage.js';
  import { makeSongDb, makeSong, createMemoryLyricStore } from './server/src/test/lyricAssetFixtures.js';
  const db = makeSongDb([makeSong({ title:'Song', artist:'Artist', duration:180, album:'' })]);
  const session = { mode:'normal', account:{accountId:'worker-fixture',role:'admin'} };
  export default { async fetch(request, env, ctx) {
    const input = new URL(request.url);
    if (input.pathname === '/warmup') return new Response('ready');
    let waitUntilCalls = 0;
    const operationContext = { waitUntil(task) { waitUntilCalls++; ctx.waitUntil(task); } };
    const controller = new AbortController();
    const abortAfter = Number(input.searchParams.get('abortAfter'));
    let timer;
    if (abortAfter > 0) timer = setTimeout(() => controller.abort(), abortAfter);
    const title = input.searchParams.get('title') || 'Song';
    const action = input.searchParams.get('action') || 'candidates';
    let target = 'https://app.test/api/lyrics/workspace/song-1';
    let method = 'GET', body;
    if (action === 'inspect') {
      target += '/candidates/inspect'; method = 'POST';
      body = { candidates:[{source:'lrclib',providerLyricId:'1'}], searchTitle:title };
    } else if (action === 'import') {
      method = 'PUT'; body = { source:'lrclib', providerLyricId:'1', etag:null, searchTitle:title };
    } else target += '/candidates?source=lrclib&title=' + encodeURIComponent(title);
    const routed = new Request(target, { method, signal:controller.signal,
      ...(body ? { headers:{'Content-Type':'application/json'},body:JSON.stringify(body) } : {}) });
    try {
      const response = await handleLocalLyricsManageRoute(routed, new URL(target), db, {}, session, {},
        { ctx:operationContext, store:createMemoryLyricStore() });
      response.headers.set('X-Registered-Tasks', String(waitUntilCalls));
      return response;
    } finally { clearTimeout(timer); }
  } };`;

let bundle;
async function fixture(t, outbound) {
  bundle ||= build({ stdin: { resolveDir: resolve('.'), contents: script }, bundle: true, write: false,
    format: 'esm', platform: 'browser' });
  const built = await bundle;
  const calls = [];
  const starts = new Map();
  const waiters = new Map();
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'lyrics-owner-lifetime', modules: true, compatibilityDate: '2026-09-23',
    script: built.outputFiles[0].text,
    outboundService: async request => {
      const url = new URL(request.url);
      const title = url.searchParams.get('track_name');
      calls.push({ title, startedAt: Date.now() });
      starts.set(title, (starts.get(title) || 0) + 1);
      waiters.get(title)?.();
      await outbound?.(title, starts.get(title), request);
      return Response.json([{ id: 1, trackName: title, artistName: 'Artist', duration: 180,
        syncedLyrics: '[00:01.000]Shared fixture lyric' }]);
    },
  }] }));
  t.after(() => mf.dispose());
  await mf.dispatchFetch('https://local.test/warmup');
  return {
    calls,
    started(title) {
      if (starts.has(title)) return Promise.resolve();
      return new Promise(resolve => { waiters.set(title, resolve); });
    },
    async request(title, { action = 'candidates', abortAfter = 0 } = {}) {
      const response = await mf.dispatchFetch('https://local.test/run?' + new URLSearchParams({ title, action, abortAfter }));
      return { status: response.status, registered: Number(response.headers.get('X-Registered-Tasks')),
        body: await response.json() };
    },
  };
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function within(task, milliseconds = 6500) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker operation exceeded the host deadline')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('workspace candidate owner may cancel and return while a different HTTP inspection subscriber succeeds', { timeout: 15_000 }, async t => {
  const app = await fixture(t, () => wait(900));
  const owner = app.request('Shared inspection', { abortAfter: 300 });
  await app.started('Shared inspection');
  const follower = app.request('Shared inspection', { action: 'inspect' });
  const cancelled = await within(owner);
  assert.equal(cancelled.status, 503);
  assert.ok(cancelled.registered >= 1, 'route → resolution → loader registered the I/O owner with waitUntil');
  let followerFinished = false;
  follower.then(() => { followerFinished = true; });
  await wait(50);
  assert.equal(followerFinished, false, 'the owner HTTP response finished before upstream work');
  const result = await within(follower);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.results[0].state, 'ready');
  assert.ok(result.registered >= 1, 'route → inspection → snapshot retained executionContext');
  assert.equal(app.calls.length, 1, 'both HTTP actions shared one real LRCLIB search');
});

test('workspace selection import survives an earlier candidate owner cancellation with one fresh search', { timeout: 15_000 }, async t => {
  const app = await fixture(t, () => wait(900));
  const owner = app.request('Shared import', { abortAfter: 300 });
  await app.started('Shared import');
  const imported = app.request('Shared import', { action: 'import' });
  assert.equal((await within(owner)).status, 503);
  const result = await within(imported);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.asset.original.lines[0].text, 'Shared fixture lyric');
  assert.ok(result.registered >= 1, 'PUT source selection → getLrclibDocument → gate retained context');
  assert.equal(app.calls.length, 1);
});

test('shared Worker deadline still fires after owner response and frees the flight for a later request', { timeout: 15_000 }, async t => {
  const app = await fixture(t, (_title, attempt) => attempt === 1 ? wait(5500) : undefined);
  const owner = app.request('Shared timeout', { abortAfter: 300 });
  await app.started('Shared timeout');
  const follower = app.request('Shared timeout');
  assert.equal((await within(owner)).status, 503);
  const result = await within(follower);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.warnings, [{ source: 'lrclib', code: 'timeout' }]);
  const recovered = await within(app.request('Shared timeout'));
  assert.equal(recovered.body.data.candidates[0].providerLyricId, '1');
  assert.equal(app.calls.length, 2, 'a timed-out request leaves no blocked flight/queue slot');
});

test('all Worker subscribers can cancel, then immediately replace the same upstream flight', { timeout: 15_000 }, async t => {
  const app = await fixture(t, (_title, attempt) => attempt === 1 ? wait(900) : undefined);
  const owner = app.request('All cancelled', { abortAfter: 300 });
  await app.started('All cancelled');
  const follower = app.request('All cancelled', { abortAfter: 400 });
  assert.equal((await within(owner)).status, 503);
  assert.equal((await within(follower)).status, 503);
  const result = await within(app.request('All cancelled'));
  assert.equal(result.body.data.candidates[0].providerLyricId, '1');
  assert.equal(app.calls.length, 2);
});

test('queued Worker timers survive earlier completion and cancellation of a newer queued request', { timeout: 15_000 }, async t => {
  const app = await fixture(t, () => wait(50));
  const first = app.request('Queue first');
  await app.started('Queue first');
  const middle = app.request('Queue middle');
  const cancelled = app.request('Queue cancelled', { abortAfter: 150 });
  assert.equal((await within(first)).status, 200);
  assert.equal((await within(cancelled)).status, 503);
  assert.equal((await within(middle)).body.data.candidates[0].providerLyricId, '1');
  assert.deepEqual(app.calls.map(call => call.title), ['Queue first', 'Queue middle']);
  assert.ok(app.calls[1].startedAt - app.calls[0].startedAt >= 350, 'separate request starts remain paced');
});
