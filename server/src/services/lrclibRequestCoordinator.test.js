import test from 'node:test';
import assert from 'node:assert/strict';
import { createLrclibRequestCoordinator, LRCLIB_REQUEST_LIMITS } from './lrclibRequestCoordinator.js';
import { parseLyricRetryAfter } from './lyricSourceHttp.js';
import { createLyricSourceLoader, createSingleFlightDocumentFetcher, fetchLyricsDocumentWithFallback, fetchLyricsAuditEvidenceWithFallback } from './lyricSourceLoader.js';
import { createNamedLyricSourceLoader } from './namedLyricSourceLoader.js';
import { listLyricsResolutionCandidates } from './lyricResolution.js';
import { inspectLyricCandidates } from './lyricCandidateInspection.js';
import { createLyricRequestBudget } from './lyricRequestBudget.js';

const url = 'https://lrclib.net/api/search?track_name=Song';
const song = { title: 'Song', artist: 'Artist', duration: 180 };
const candidate = { id: 1, trackName: 'Song', artistName: 'Artist', duration: 180,
  syncedLyrics: '[00:01.000]Hello', accesskey: 'must-never-cache' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const clock = (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_100 });
  return async milliseconds => { t.mock.timers.tick(milliseconds); await flush(); };
};

test('identical LRCLIB requests share one fetch; one subscriber cannot cancel another', async t => {
  const advance = clock(t);
  let calls = 0, finish, fetchSignal;
  const coordinator = createLrclibRequestCoordinator({ fetchImpl: (_, init) => {
    calls += 1; fetchSignal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  const controller = new AbortController();
  const first = coordinator.request(url, { stage: 'search', signal: controller.signal });
  const firstRejection = assert.rejects(first, { kind: 'aborted' });
  const second = coordinator.request(url, { stage: 'search' });
  await advance(0);
  controller.abort();
  await firstRejection;
  assert.equal(calls, 1);
  assert.equal(fetchSignal.aborted, false);
  finish(Response.json([candidate]));
  assert.deepEqual(await second, [candidate]);
});

test('all subscriber cancellation removes the flight before a same-URL immediate replacement', async t => {
  const advance = clock(t);
  const signals = [];
  const coordinator = createLrclibRequestCoordinator({ fetchImpl: (_, init) => {
    signals.push(init.signal);
    if (signals.length > 1) return Response.json([]);
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const first = coordinator.request(url, { stage: 'search', signal: controller.signal });
  const rejected = assert.rejects(first, { kind: 'aborted' });
  await advance(0);
  controller.abort();
  const replacement = coordinator.request(url, { stage: 'search' });
  await rejected;
  await advance(400);
  assert.deepEqual(await replacement, []);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test('every real fetch including a single 503 retry is paced and charged to its original budget', async t => {
  const advance = clock(t);
  const starts = [];
  let used = 0;
  const coordinator = createLrclibRequestCoordinator({ fetchImpl: target => {
    starts.push([Date.now(), target]);
    return starts.length === 1 ? new Response(null, { status: 503, headers: { 'retry-after': '0' } }) : Response.json([]);
  } });
  const first = coordinator.request(url, { stage: 'search', requestBudget: { consume() { used += 1; } } });
  const second = coordinator.request(url + '2', { stage: 'search' });
  await advance(0);
  await advance(400);
  await advance(400);
  await Promise.all([first, second]);
  assert.equal(starts.length, 3);
  assert.equal(used, 2);
  assert.ok(starts[1][0] - starts[0][0] >= 400);
  assert.ok(starts[2][0] - starts[1][0] >= 400);
});

test('a 429 rejects already queued URLs and suppresses requests until the Retry-After deadline', async t => {
  const advance = clock(t);
  let calls = 0;
  const coordinator = createLrclibRequestCoordinator({ fetchImpl: () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '2' } }) : Response.json([]);
  } });
  const first = assert.rejects(coordinator.request(url, { stage: 'search' }), { kind: 'rate_limited', retryAfterSeconds: 2 });
  const queued = assert.rejects(coordinator.request(url + '2', { stage: 'search' }), { kind: 'rate_limited', retryAfterSeconds: 2 });
  await advance(0);
  await Promise.all([first, queued]);
  await advance(1001);
  await assert.rejects(coordinator.request(url + '3', { stage: 'search' }), { kind: 'rate_limited', retryAfterSeconds: 1 });
  assert.equal(calls, 1);
  await advance(1000);
  assert.deepEqual(await coordinator.request(url, { stage: 'search' }), []);
  assert.equal(calls, 2);
});

test('Retry-After supports safe delta-seconds, ceil HTTP-date and a 30-second invalid/missing default', () => {
  const now = Date.parse('2026-10-17T00:00:00.100Z');
  assert.equal(parseLyricRetryAfter('12', now), 12);
  assert.equal(parseLyricRetryAfter('0', now), 1);
  assert.equal(parseLyricRetryAfter('Sat, 17 Oct 2026 00:00:02 GMT', now), 2);
  for (const invalid of [null, '', 'invalid', '-1', '1.5', '99999999999999999999999999']) {
    assert.equal(parseLyricRetryAfter(invalid, now), 30);
  }
});

test('candidate summary cache expires, evicts its oldest entry and enforces a byte bound', t => {
  clock(t);
  const coordinator = createLrclibRequestCoordinator({ fetchImpl: () => Response.json([]) });
  for (let index = 0; index < 33; index += 1) coordinator.setCandidates(String(index), [{ providerLyricId: String(index) }]);
  assert.equal(coordinator.getCandidates('0'), undefined);
  assert.deepEqual(coordinator.getCandidates('1'), [{ providerLyricId: '1' }]);
  const copy = coordinator.getCandidates('1');
  copy[0].providerLyricId = 'changed';
  assert.equal(coordinator.getCandidates('1')[0].providerLyricId, '1');
  coordinator.setCandidates('too-large', ['a'.repeat(LRCLIB_REQUEST_LIMITS.maxCandidateBytes)]);
  assert.equal(coordinator.getCandidates('too-large'), undefined);
  t.mock.timers.tick(15_000);
  assert.equal(coordinator.getCandidates('1'), undefined);
});

test('HTTP-date cooldown rounds up and keeps the original retry deadline', async t => {
  const advance = clock(t);
  const deadline = new Date(Date.now() + 1900).toUTCString();
  let calls = 0;
  const coordinator = createLrclibRequestCoordinator({ fetchImpl: () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': deadline } }) : Response.json([]);
  } });
  await assert.rejects(coordinator.request(url, { stage: 'search' }), { retryAfterSeconds: 2 });
  await advance(1900);
  await assert.rejects(coordinator.request(url, { stage: 'search' }), { retryAfterSeconds: 1 });
  assert.equal(calls, 1);
  await advance(100);
  assert.deepEqual(await coordinator.request(url, { stage: 'search' }), []);
  assert.equal(calls, 2);
});

test('queued wait and 503 retry share the original 5-second deadline', async t => {
  const advance = clock(t);
  let calls = 0, used = 0;
  const coordinator = createLrclibRequestCoordinator({ timeoutMs: 500, fetchImpl: () => {
    calls += 1;
    return new Response(null, { status: 503, headers: { 'retry-after': '1' } });
  } });
  const first = assert.rejects(coordinator.request(url, { stage: 'search', requestBudget: { consume() { used += 1; } } }), { kind: 'timeout' });
  const second = assert.rejects(coordinator.request(url + '2', { stage: 'search' }), { kind: 'timeout' });
  await advance(0);
  await advance(400);
  await advance(100);
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(used, 1);
  await advance(5000);
  assert.equal(calls, 2, 'neither timed-out operation starts its retry');
});

test('subscriber admission is bounded even when all subscribers share a URL', async t => {
  const advance = clock(t);
  let calls = 0;
  const coordinator = createLrclibRequestCoordinator({ fetchImpl: (_, init) => {
    calls += 1;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const pending = Array.from({ length: 64 }, () => coordinator.request(url, { stage: 'search', signal: controller.signal }));
  const settled = Promise.allSettled(pending);
  await advance(0);
  await assert.rejects(coordinator.request(url, { stage: 'search' }), { stage: 'budget' });
  controller.abort();
  assert.ok((await settled).every(result => result.reason.kind === 'aborted'));
  assert.equal(calls, 1);
});

test('aggregated fallback errors preserve cooldown metadata and keep local budgets distinct', async () => {
  for (const fallback of [fetchLyricsDocumentWithFallback, fetchLyricsAuditEvidenceWithFallback]) {
    const provider = createNamedLyricSourceLoader({ channels: { version: 2, sources: [] },
      fetchImpl: () => new Response(null, { status: 429, headers: { 'retry-after': '9' } }) });
    const method = fallback === fetchLyricsDocumentWithFallback ? provider.fetchSourceDocument : provider.fetchSourceAuditEvidence;
    await assert.rejects(fallback('lrclib', song, method), { kind: 'rate_limited', retryAfterSeconds: 9 });
    const exhausted = createLyricRequestBudget();
    for (let index = 0; index < 32; index += 1) exhausted.consume('lrclib');
    const healthy = createLyricSourceLoader({ fetchImpl: () => Response.json([]) });
    const healthyMethod = fallback === fetchLyricsDocumentWithFallback ? healthy.fetchSourceDocument : healthy.fetchSourceAuditEvidence;
    await assert.rejects(fallback('lrclib', song, healthyMethod, { requestBudget: exhausted }), { kind: 'rate_limited', stage: 'budget' });
  }
});

test('a merged network failure counts once toward a provider circuit', async t => {
  const advance = clock(t);
  let calls = 0;
  const loader = createLyricSourceLoader({ circuitFailureThreshold: 2, fetchImpl: () => {
    calls += 1;
    throw new Error('network down');
  } });
  const initial = await Promise.allSettled([
    loader.listSourceCandidates('lrclib', song), loader.listSourceCandidates('lrclib', song),
  ]);
  assert.ok(initial.every(result => result.reason.kind === 'network'));
  assert.equal(calls, 1);
  const retry = assert.rejects(loader.listSourceCandidates('lrclib', song), { kind: 'network' });
  await advance(400);
  await retry;
  assert.equal(calls, 2);
  await assert.rejects(loader.listSourceCandidates('lrclib', song), { kind: 'circuit_open' });
});

test('operation contexts reach every audit fetch without being retained for later operations', async t => {
  const advance = clock(t);
  const firstTasks = [], secondTasks = [];
  const firstContext = { waitUntil(task) { firstTasks.push(task); } };
  const secondContext = { waitUntil(task) { secondTasks.push(task); } };
  const loader = createLyricSourceLoader({ fetchImpl: target => Response.json(
    new URL(target).pathname.endsWith('/get') ? candidate : [candidate],
  ) });
  await loader.listSourceCandidates('lrclib', song, { executionContext: firstContext });
  assert.equal(firstTasks.length, 1);
  const audit = loader.fetchSourceAuditEvidence('lrclib', song, { executionContext: secondContext });
  await advance(400);
  await advance(400);
  assert.equal((await audit).document.lines[0].text, 'Hello');
  assert.equal(firstTasks.length, 1, 'the reused loader did not retain the previous HTTP context');
  assert.equal(secondTasks.length, 2, 'both get and search registered their actual I/O task');
  await Promise.all([...firstTasks, ...secondTasks]);
});

test('the document singleflight forwards its owner context into the provider adapter', async () => {
  const tasks = [];
  const context = { waitUntil(task) { tasks.push(task); } };
  const fetcher = createSingleFlightDocumentFetcher(async (_provider, _song, options) => {
    assert.equal(options.executionContext, context);
    return { result: 'owner context preserved' };
  });
  assert.deepEqual(await fetcher('lrclib', song, { executionContext: context }), { result: 'owner context preserved' });
  await Promise.all(tasks);
});

test('only safe candidate listings use the short cache; inspection and manual import stay fresh', async t => {
  const advance = clock(t);
  let calls = 0;
  const loader = createLyricSourceLoader({ fetchImpl: () => { calls += 1; return Response.json([candidate]); } });
  const listed = await loader.listSourceCandidates('lrclib', song);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(listed).includes('Hello'), false);
  assert.equal(JSON.stringify(listed).includes('must-never-cache'), false);
  assert.deepEqual(await loader.listSourceCandidates('lrclib', { ...song, id: 'other-id' }), listed);
  assert.equal(calls, 1);
  const snapshot = loader.createCandidateInspectionSnapshot('lrclib', song);
  await advance(400);
  assert.deepEqual((await snapshot).providerLyricIds, ['1']);
  const imported = loader.fetchSourceDocument('lrclib', song, { providerLyricId: '1' });
  await advance(400);
  assert.equal((await imported).lines[0].text, 'Hello');
  assert.equal(calls, 3);
  const differentDuration = loader.listSourceCandidates('lrclib', { ...song, duration: 181 });
  await advance(400);
  await differentDuration;
  assert.equal(calls, 4, 'duration affects ranking and belongs in the listing key');
  await advance(15_000);
  await loader.listSourceCandidates('lrclib', song);
  assert.equal(calls, 5);
});

test('named errors keep retry metadata; cooldown never opens a masking circuit; projections are safe', async t => {
  const advance = clock(t);
  let calls = 0;
  const loader = createNamedLyricSourceLoader({ channels: { version: 2, sources: [] }, circuitFailureThreshold: 1,
    fetchImpl: () => { calls += 1; return new Response(null, { status: 429 }); } });
  const result = await listLyricsResolutionCandidates(song, { enabledSources: ['lrclib'], listCandidates: loader.listSourceCandidates });
  assert.deepEqual(result.warnings, [{ source: 'lrclib', code: 'rate_limited', retryAfterSeconds: 30 }]);
  const inspected = await inspectLyricCandidates(song, [{ source: 'lrclib', providerLyricId: '1' }], {
    createProviderSnapshot: loader.createCandidateInspectionSnapshot,
  });
  assert.deepEqual(inspected.items[0].error, { code: 'search_rate_limited', retryAfterSeconds: 30 });
  assert.equal(calls, 1);
  await advance(30_000);
  await assert.rejects(loader.listSourceCandidates('lrclib', song), { kind: 'rate_limited', retryAfterSeconds: 30 });
  assert.equal(calls, 2, 'the cooldown expires without a second circuit delay');
});

test('local budget exhaustion is not upstream throttling, is not cached and cannot start cooldown', async t => {
  const advance = clock(t);
  let calls = 0;
  const loader = createLyricSourceLoader({ fetchImpl: () => { calls += 1; return Response.json([]); } });
  const exhausted = createLyricRequestBudget();
  for (let index = 0; index < 32; index += 1) exhausted.consume('lrclib');
  const listed = await listLyricsResolutionCandidates(song, { enabledSources: ['lrclib'], listCandidates: loader.listSourceCandidates, requestBudget: exhausted });
  assert.deepEqual(listed.warnings, [{ source: 'lrclib', code: 'request_budget_exceeded' }]);
  const inspected = inspectLyricCandidates(song, [{ source: 'lrclib', providerLyricId: '1' }], {
    createProviderSnapshot: loader.createCandidateInspectionSnapshot, requestBudget: exhausted,
  });
  await advance(400);
  assert.deepEqual((await inspected).items[0].error, { code: 'search_request_budget_exceeded' });
  assert.equal(calls, 0);
  const fresh = loader.listSourceCandidates('lrclib', song);
  await advance(400);
  assert.deepEqual(await fresh, []);
  assert.equal(calls, 1);
});

test('coordinator state stays isolated per loader and queue admission is bounded', async t => {
  const advance = clock(t);
  let calls = 0;
  const first = createLrclibRequestCoordinator({ fetchImpl: () => { calls += 1; return new Response(null, { status: 429 }); } });
  const second = createLrclibRequestCoordinator({ fetchImpl: () => { calls += 1; return Response.json([]); } });
  await assert.rejects(first.request(url, { stage: 'search' }), { retryAfterSeconds: 30 });
  assert.deepEqual(await second.request(url, { stage: 'search' }), []);
  assert.equal(calls, 2);
  const controller = new AbortController();
  const pending = Array.from({ length: 16 }, (_, index) => second.request(url + index, { stage: 'search', signal: controller.signal }));
  const settled = Promise.allSettled(pending);
  await assert.rejects(second.request(url + 'overflow', { stage: 'search' }), { stage: 'budget', kind: 'rate_limited' });
  controller.abort();
  assert.ok((await settled).every(result => result.status === 'rejected' && result.reason.kind === 'aborted'));
  await advance(5000);
  assert.equal(calls, 2, 'cancelled queue items do not reach upstream');
});
