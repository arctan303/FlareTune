import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLimitedJson } from './lyricSourceHttp.js';
import { createLyricSourceLoader, LyricSourceError } from './lyricSourceLoader.js';
import { inspectLyricCandidates } from './lyricCandidateInspection.js';

const url = 'https://lrclib.net/api/search';
const options = { provider: 'lrclib', stage: 'search' };
const unavailable = (retryAfter = '0') => new Response(null, { status: 503, headers: { 'retry-after': retryAfter } });

test('fresh candidate inspection recovers a single LRCLIB 503 and still rejects forged ids', async () => {
  let calls = 0, used = 0;
  const loader = createLyricSourceLoader({ fetchImpl: async (_, init) => {
    assert.equal(init.redirect, 'manual');
    calls += 1;
    return calls === 2 ? unavailable() : Response.json([{ id: 1, trackName: 'Song', artistName: 'Artist',
      duration: 180, syncedLyrics: '[00:01.00]Fixture' }]);
  } });
  const song = { title: 'Song', artist: 'Artist', duration: 180 };
  const candidates = await loader.listSourceCandidates('lrclib', song);
  const result = await inspectLyricCandidates(song, [
    { source: candidates[0].source, providerLyricId: candidates[0].providerLyricId },
    { source: 'lrclib', providerLyricId: 'forged' },
  ], { createProviderSnapshot: loader.createCandidateInspectionSnapshot, requestBudget: { consume() { used += 1; } } });
  assert.equal(calls, 3, 'initial search, fresh search, one retry');
  assert.equal(used, 2);
  assert.equal(result.items[0].state, 'ready');
  assert.equal(result.items[0].lyrics.lines[0].text, 'Fixture');
  assert.equal(result.items[1].error.code, 'candidate_not_found');
});

test('continuous 503 retries once; custom sources, other statuses, and long Retry-After do not retry', async () => {
  for (const [provider, stage, status, retryAfter, expected] of [
    ['lrclib', 'search', 503, '0', 2], ['custom_krc', 'search', 503, '0', 1],
    ['lrclib', 'get', 503, '0', 1], ['lrclib', 'search', 429, '0', 1],
    ['lrclib', 'search', 302, '0', 1], ['lrclib', 'search', 503, '10', 1],
  ]) {
    let calls = 0;
    await assert.rejects(fetchLimitedJson(async () => {
      calls += 1; return new Response(null, { status, headers: { 'retry-after': retryAfter } });
    }, url, { provider, stage }), error => error instanceof LyricSourceError);
    assert.equal(calls, expected, `${provider}/${stage}/${status}/${retryAfter}`);
  }
});

test('Retry-After wait shares the original timeout and respects request cancellation', async () => {
  for (const cancel of [false, true]) {
    let calls = 0;
    const controller = new AbortController();
    const timer = cancel ? setTimeout(() => controller.abort(), 10) : null;
    try {
      await assert.rejects(fetchLimitedJson(async () => { calls += 1; return unavailable('1'); }, url,
        { ...options, signal: controller.signal, timeoutMs: 30 }), { kind: cancel ? 'aborted' : 'timeout' });
      assert.equal(calls, 1, 'no retry after interruption');
    } finally { clearTimeout(timer); }
  }
});

test('retry consumes the shared budget before sending another request', async () => {
  let calls = 0, used = 0;
  await assert.rejects(fetchLimitedJson(async () => { calls += 1; return unavailable(); }, url,
    { ...options, requestBudget: { consume() {
      if (++used > 1) throw new LyricSourceError('rate_limited', 'lrclib', 'budget', 'Fixture exhausted');
    } } }), { kind: 'rate_limited', stage: 'budget' });
  assert.equal(calls, 1);
  assert.equal(used, 2);
});

test('the retry fetch uses the same remaining deadline rather than a fresh timeout', async () => {
  const signals = [];
  await assert.rejects(fetchLimitedJson(async (_, init) => {
    signals.push(init.signal);
    if (signals.length === 1) return unavailable();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }, url, { ...options, timeoutMs: 30 }), { kind: 'timeout' });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1].aborted, true);
});
