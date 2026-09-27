import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricSourceLoader, parseKrcLyrics } from './lyricSourceLoader.js';

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('Kugou rounds floating duration to whole-second milliseconds to match upstream index', async () => {
  let searchUrl = '';
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      searchUrl = url;
      return jsonResponse({ candidates: [{
        id: 'kg-1', accesskey: 'secret', song: 'Fire Girl', singer: 'Singer A', duration: 256_000,
      }] });
    },
  });
  const candidates = await loader.listSourceCandidates('kugou', {
    title: 'Fire Girl', artist: 'Singer A', duration: 256.321,
  });
  assert.equal(new URL(searchUrl).searchParams.get('duration'), '256000');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].matchedTitle, 'Fire Girl');
});

test('parseKrcLyrics detects embedded title and first line remix/dj mismatch', () => {
  const krcWithRemix = '[ti:Wild Heart (Remix)]\n[ar:Singer A/DJ Fish]\n[1000,1000]<0,1000,0>Singer A - Wild Heart (DJ Version)';
  const doc = parseKrcLyrics(krcWithRemix, {
    providerMeta: { providerLyricId: 'kg-dj', matchedTitle: 'Wild Heart', matchedArtist: 'Singer A' },
  });
  assert.equal(doc.providerMeta.versionMismatch, true);
});

test('Netease search gracefully falls back to cloudsearch on upstream non-200 code', async () => {
  const requestedUrls = [];
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url.includes('/api/search/get/web')) {
        return jsonResponse({ code: 405, message: 'blocked' });
      }
      return jsonResponse({
        code: 200,
        result: {
          songs: [{
            id: 12345,
            name: 'Wild Heart',
            ar: [{ name: 'Singer A' }],
            al: { name: 'Album A' },
            dt: 213000,
          }],
        },
      });
    },
  });
  const candidates = await loader.listSourceCandidates('netease', {
    title: 'Wild Heart', artist: 'Singer A', duration: 213,
  });
  assert.equal(requestedUrls.some((u) => u.includes('/api/search/get/web')), true);
  assert.equal(requestedUrls.some((u) => u.includes('/api/cloudsearch/pc')), true);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerLyricId, '12345');
  assert.equal(candidates[0].matchedTitle, 'Wild Heart');
  assert.equal(candidates[0].matchedArtist, 'Singer A');
});

test('buildKugouDurationMsCandidates generates floor and rounded whole-second ms', async () => {
  const { buildKugouDurationMsCandidates } = await import('./lyricSourceMatching.js');
  assert.deepEqual(buildKugouDurationMsCandidates(256.768), ['256000', '257000']);
  assert.deepEqual(buildKugouDurationMsCandidates(256.0), ['256000']);
  assert.deepEqual(buildKugouDurationMsCandidates(257.7), ['257000', '258000']);
  assert.deepEqual(buildKugouDurationMsCandidates(null), [null]);
});

test('Kugou search tests adjacent duration when initial duration returns 0 candidates', async () => {
  const requestedUrls = [];
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.searchParams.get('duration') === '256000') {
        return jsonResponse({ candidates: [{
          id: 'kg-match', accesskey: 'secret', song: 'Fire Girl', singer: 'Singer A', duration: 256_000,
        }] });
      }
      return jsonResponse({ candidates: [] });
    },
  });
  // 256.768 will first check 256000
  const candidates = await loader.listSourceCandidates('kugou', {
    title: 'Fire Girl', artist: 'Singer A', duration: 256.768,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerLyricId, 'kg-match');
  assert.equal(requestedUrls.length, 1);
  assert.equal(new URL(requestedUrls[0]).searchParams.get('duration'), '256000');
});

test('Kugou search falls back to second duration candidate if first duration candidate returns 0', async () => {
  const requestedUrls = [];
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.searchParams.get('duration') === '257000') {
        return jsonResponse({ candidates: [{
          id: 'kg-match-2', accesskey: 'secret', song: 'Fire Girl', singer: 'Singer A', duration: 257_000,
        }] });
      }
      return jsonResponse({ candidates: [] });
    },
  });
  // 256.768 will check 256000 first (returns 0), then 257000 (returns candidate)
  const candidates = await loader.listSourceCandidates('kugou', {
    title: 'Fire Girl', artist: 'Singer A', duration: 256.768,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerLyricId, 'kg-match-2');
  assert.equal(requestedUrls.length, 2);
  assert.equal(new URL(requestedUrls[0]).searchParams.get('duration'), '256000');
  assert.equal(new URL(requestedUrls[1]).searchParams.get('duration'), '257000');
});
