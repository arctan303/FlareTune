import { TEST_LYRIC_SOURCES } from '../test/lyricSourceConfigFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricSourceLoader, parseKrcLyrics } from './lyricSourceLoader.js';

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('CustomKrc rounds floating duration to whole-second milliseconds to match upstream index', async () => {
  let searchUrl = '';
  const loader = createLyricSourceLoader({ sources: TEST_LYRIC_SOURCES,
    fetchImpl: async (url) => {
      searchUrl = url;
      return jsonResponse({ candidates: [{
        id: 'kg-1', accesskey: 'secret', song: 'Fire Girl', singer: 'Singer A', duration: 256_000,
      }] });
    },
  });
  const candidates = await loader.listSourceCandidates('custom_krc', {
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

test('CustomLrc searches only the administrator configured endpoint', async () => {
  const requestedUrls = [];
  const loader = createLyricSourceLoader({ sources: TEST_LYRIC_SOURCES,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
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
  const candidates = await loader.listSourceCandidates('custom_lrc', {
    title: 'Wild Heart', artist: 'Singer A', duration: 213,
  });
  assert.equal(requestedUrls.length, 1);
  assert.equal(new URL(requestedUrls[0]).origin + new URL(requestedUrls[0]).pathname, TEST_LYRIC_SOURCES.custom_lrc.searchUrl);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerLyricId, '12345');
  assert.equal(candidates[0].matchedTitle, 'Wild Heart');
  assert.equal(candidates[0].matchedArtist, 'Singer A');
});

test('buildCustomKrcDurationMsCandidates generates floor and rounded whole-second ms', async () => {
  const { buildCustomKrcDurationMsCandidates } = await import('./lyricSourceMatching.js');
  assert.deepEqual(buildCustomKrcDurationMsCandidates(256.768), ['256000', '257000']);
  assert.deepEqual(buildCustomKrcDurationMsCandidates(256.0), ['256000']);
  assert.deepEqual(buildCustomKrcDurationMsCandidates(257.7), ['257000', '258000']);
  assert.deepEqual(buildCustomKrcDurationMsCandidates(null), [null]);
});

test('CustomKrc search tests adjacent duration when initial duration returns 0 candidates', async () => {
  const requestedUrls = [];
  const loader = createLyricSourceLoader({ sources: TEST_LYRIC_SOURCES,
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
  const candidates = await loader.listSourceCandidates('custom_krc', {
    title: 'Fire Girl', artist: 'Singer A', duration: 256.768,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerLyricId, 'kg-match');
  assert.equal(requestedUrls.length, 1);
  assert.equal(new URL(requestedUrls[0]).searchParams.get('duration'), '256000');
});

test('CustomKrc search falls back to second duration candidate if first duration candidate returns 0', async () => {
  const requestedUrls = [];
  const loader = createLyricSourceLoader({ sources: TEST_LYRIC_SOURCES,
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
  const candidates = await loader.listSourceCandidates('custom_krc', {
    title: 'Fire Girl', artist: 'Singer A', duration: 256.768,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerLyricId, 'kg-match-2');
  assert.equal(requestedUrls.length, 2);
  assert.equal(new URL(requestedUrls[0]).searchParams.get('duration'), '256000');
  assert.equal(new URL(requestedUrls[1]).searchParams.get('duration'), '257000');
});
