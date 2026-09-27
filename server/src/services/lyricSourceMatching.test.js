import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createLyricSourceLoader } from './lyricSourceLoader.js';
import { buildKugouSearchKeywords, computeDurationScore, rankLyricCandidates } from './lyricSourceMatching.js';

const SONG = { title: '夜航', artist: '歌手甲、歌手乙', album: '夜航集', duration: 200 };
const OPTIONS = {
  titleKeys: ['song'], artistKeys: ['singer'], albumKeys: ['album'], durationKeys: ['duration'],
};
const KRC_KEY = Uint8Array.from([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]);
const encodeKrc = (text) => {
  const compressed = deflateSync(Buffer.from(text, 'utf8'));
  const encrypted = Uint8Array.from(compressed, (byte, index) => byte ^ KRC_KEY[index % KRC_KEY.length]);
  return Buffer.concat([Buffer.from('krc1'), Buffer.from(encrypted)]).toString('base64');
};
const jsonResponse = (data) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json' },
});

test('ranking enforces title and primary artist while keeping version and duration soft', () => {
  const ranked = rankLyricCandidates([
    { id: 'wrong-version', song: '夜航 (DJ版)', singer: '歌手甲、歌手乙', duration: 200_000 },
    { id: 'wrong-title', song: '夜航者', singer: '歌手甲、歌手乙', duration: 200_000 },
    { id: 'wrong-artist', song: '夜航', singer: '同名歌手', duration: 200_000 },
    { id: 'wrong-duration', song: '夜航', singer: '歌手甲、歌手乙', duration: 203_000 },
    { id: 'non-primary-half', song: '夜航', singer: '歌手乙', duration: 200_000 },
    { id: 'partial-artist', song: '夜航', singer: '歌手甲', duration: 201_000 },
    { id: 'exact', song: '夜 航', singer: '歌手甲 / 歌手乙', album: '夜航集', duration: 200_500 },
  ], SONG, OPTIONS);

  assert.equal(ranked[0].candidate.id, 'exact');
  assert.equal(ranked.some(({ candidate }) => candidate.id === 'wrong-title'), false);
  assert.equal(ranked.some(({ candidate }) => candidate.id === 'wrong-artist'), false);
  assert.equal(ranked.some(({ candidate }) => candidate.id === 'non-primary-half'), false);
  assert.equal(ranked.some(({ candidate }) => candidate.id === 'wrong-version'), true);
  assert.equal(ranked.some(({ candidate }) => candidate.id === 'wrong-duration'), true);
  assert.equal(ranked.find(({ candidate }) => candidate.id === 'wrong-version').versionMismatch, true);
  assert.equal(ranked.find(({ candidate }) => candidate.id === 'wrong-duration').durationDelta, 3);
  assert.equal(ranked[0].durationDelta, 0.5);
  assert.equal(ranked.find(({ candidate }) => candidate.id === 'partial-artist').artistRatio, 0.5);
});

test('ranking rejects songs without a primary artist instead of accepting arbitrary same-title candidates', () => {
  const candidates = [{ id: 'unrelated', song: '夜航', singer: '任意歌手', duration: 200_000 }];
  assert.deepEqual(rankLyricCandidates(candidates, { title: '夜航', artist: '', duration: 200 }, OPTIONS), []);
  assert.deepEqual(rankLyricCandidates(candidates, { title: '夜航', duration: 200 }, OPTIONS), []);
});

test('missing duration on either side remains matchable and reports an unknown delta', () => {
  const [missingSongDuration] = rankLyricCandidates([
    { id: 'provider-duration', song: '夜航', singer: '歌手甲', duration: 200_000 },
  ], { title: '夜航', artist: '歌手甲' }, OPTIONS);
  const [missingCandidateDuration] = rankLyricCandidates([
    { id: 'no-provider-duration', song: '夜航', singer: '歌手甲' },
  ], { title: '夜航', artist: '歌手甲', duration: 200 }, OPTIONS);

  assert.equal(missingSongDuration.durationDelta, null);
  assert.equal(missingCandidateDuration.durationDelta, null);
});

test('provider searches omit unknown duration and expose null-safe candidate metadata', async () => {
  const kugouUrls = [];
  const kugou = createLyricSourceLoader({
    fetchImpl: async (url) => {
      kugouUrls.push(url);
      return jsonResponse({ candidates: [
        { id: 'kg-1', accesskey: 'secret', song: '夜航', singer: '歌手甲' },
        { id: 'wrong', accesskey: 'secret', song: '夜航', singer: '其他歌手' },
      ] });
    },
  });
  const candidates = await kugou.listSourceCandidates('kugou', { title: '夜航', artist: '歌手甲' });
  assert.equal(new URL(kugouUrls[0]).searchParams.has('duration'), false);
  assert.deepEqual(candidates.map(({ providerLyricId }) => providerLyricId), ['kg-1']);
  assert.equal(candidates[0].matchedDuration, null);
  assert.equal(candidates[0].durationDelta, null);

  let lrclibUrl = '';
  const lrclib = createLyricSourceLoader({
    fetchImpl: async (url) => {
      lrclibUrl = url;
      return jsonResponse({
        id: 'lr-1', trackName: '夜航', artistName: '歌手甲', syncedLyrics: '[00:01.00]歌词',
      });
    },
  });
  const document = await lrclib.getLrclibDocument({ title: '夜航', artist: '歌手甲' });
  assert.equal(new URL(lrclibUrl).searchParams.has('duration'), false);
  assert.equal(document.providerMeta.durationDelta ?? null, null);
});

test('provider lookup stops before network access when the song primary artist is missing', async () => {
  let calls = 0;
  const loader = createLyricSourceLoader({ fetchImpl: async () => { calls += 1; return jsonResponse({ candidates: [] }); } });
  await assert.rejects(
    () => loader.listSourceCandidates('kugou', { title: '夜航', artist: '' }),
    { name: 'LyricSourceError', kind: 'invalid' },
  );
  assert.equal(calls, 0);
});

test('large duration differences remain ranked warnings', () => {
  const [selection] = rankLyricCandidates([{
    id: 'short-provider-duration', song: 'Под луной', singer: 'Miyagi', duration: 43_000,
  }], { title: 'Под луной', artist: 'Miyagi', duration: 255 }, OPTIONS);
  assert.equal(selection.candidate.id, 'short-provider-duration');
  assert.equal(selection.durationDelta, 212);
});

test('buildKugouSearchKeywords extracts featured artists from title and forms combined artist keywords', () => {
  const keywords = buildKugouSearchKeywords({
    title: 'Deep End (feat. Eastside and Mayer Hawthorne) (Matoma Remix)',
    artist: 'Coucheron',
  });
  assert.equal(keywords.includes('Coucheron、Eastside、Mayer Hawthorne-Deep End'), true);
  assert.equal(keywords.includes('Coucheron-Deep End'), true);
});

test('version mismatch combined with large duration difference heavily penalizes score', () => {
  const [normal] = rankLyricCandidates([{
    id: 'normal', song: '很任性', singer: '千百顺', duration: 213_000,
  }], { title: '很任性', artist: '千百顺', duration: 213 }, OPTIONS);
  const [djVersion] = rankLyricCandidates([{
    id: 'dj', song: '很任性 (DJ版)', singer: '千百顺', duration: 196_000,
  }], { title: '很任性', artist: '千百顺', duration: 213 }, OPTIONS);

  assert.equal(normal.versionMismatch, false);
  assert.equal(djVersion.versionMismatch, true);
  assert.ok(normal.score > djVersion.score + 40);
});

test('computeDurationScore provides smooth decaying scores up to 60s', () => {
  assert.equal(computeDurationScore(null), 0);
  assert.equal(computeDurationScore(undefined), 0);
  assert.equal(computeDurationScore(Number.NaN), 0);

  // <= 3s: 25 - delta * 0.8
  assert.equal(computeDurationScore(0), 25);
  assert.equal(computeDurationScore(1), 24.2);
  assert.equal(computeDurationScore(3), 22.6);

  // 3s ~ 15s: 22.6 - (delta - 3) * 0.7
  assert.equal(Number(computeDurationScore(5).toFixed(2)), 21.2);
  assert.equal(Number(computeDurationScore(10).toFixed(2)), 17.7);
  assert.equal(Number(computeDurationScore(15).toFixed(2)), 14.2);

  // 15s ~ 35s: 14.2 - (delta - 15) * 0.4
  assert.equal(Number(computeDurationScore(20).toFixed(2)), 12.2);
  assert.equal(Number(computeDurationScore(25).toFixed(2)), 10.2);
  assert.equal(Number(computeDurationScore(35).toFixed(2)), 6.2);

  // 35s ~ 60s
  assert.ok(computeDurationScore(45) > 0);
  assert.equal(computeDurationScore(60), 0);
  assert.equal(computeDurationScore(70), 0);
});

test('candidates with moderate duration difference (5s ~ 30s) preserve positive duration score and rank well', () => {
  const ranked = rankLyricCandidates([
    { id: 'diff-30s', song: '夜航', singer: '歌手甲、歌手乙', duration: 170_000 },
    { id: 'diff-10s', song: '夜航', singer: '歌手甲、歌手乙', duration: 190_000 },
    { id: 'diff-0s', song: '夜航', singer: '歌手甲、歌手乙', duration: 200_000 },
  ], SONG, OPTIONS);

  assert.equal(ranked[0].candidate.id, 'diff-0s');
  assert.equal(ranked[1].candidate.id, 'diff-10s');
  assert.equal(ranked[2].candidate.id, 'diff-30s');

  // Verify all candidates have positive scores well above the base 140 (100 base + 40 artist)
  assert.ok(ranked[1].score > 150);
  assert.ok(ranked[2].score > 140);
});

test('Kugou automatic document selection prefers word-level candidate over line-only candidate among top selections', async () => {
  const wordKrc = encodeKrc('[1000,1000]<0,1000,0>word lyrics');
  const loader = createLyricSourceLoader({
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/search') {
        return jsonResponse({
          candidates: [
            { id: 'first-line-only', accesskey: 'key-1', song: '夜航', singer: '歌手甲、歌手乙', duration: 200_000 },
            { id: 'second-word', accesskey: 'key-2', song: '夜航', singer: '歌手甲、歌手乙', duration: 203_000 },
          ],
        });
      }
      if (parsedUrl.pathname === '/download') {
        const id = parsedUrl.searchParams.get('id');
        const fmt = parsedUrl.searchParams.get('fmt');
        if (id === 'first-line-only') {
          if (fmt === 'krc') {
            return jsonResponse({ content: Buffer.from('not-krc').toString('base64') });
          }
          return jsonResponse({ content: Buffer.from('[00:01.00]line lyrics', 'utf8').toString('base64') });
        }
        if (id === 'second-word' && fmt === 'krc') {
          return jsonResponse({ content: wordKrc });
        }
      }
      return jsonResponse({}, 404);
    },
  });

  const document = await loader.getKugouDocument(SONG);
  assert.equal(document.syncMode, 'word');
  assert.equal(document.providerMeta.providerLyricId, 'second-word');
});




