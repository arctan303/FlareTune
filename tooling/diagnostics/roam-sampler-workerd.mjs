// Local Miniflare/workerd D1 measurements; no Cloudflare account or remote service.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
import { createRoamSampler } from './tooling/diagnostics/roam-sampler-prototype.mjs';
import { handleLocalMusicDiscoveryRoute } from './server/src/routes/localMusicDiscovery.js';
import { buildSongLanguageFilter } from './server/src/utils/songLanguage.js';
import { runtimeSongColumns } from './server/src/utils/songProjection.js';
const sampler = createRoamSampler();
export default { async fetch(request, env) {
  const input = await request.json();
  let queries = 0, rowsRead = 0, returnedRows = 0, databaseMs = 0;
  const measure = result => { queries++; rowsRead += result.meta?.rows_read || 0;
    returnedRows += result.results?.length || 0; databaseMs += result.meta?.duration || 0; };
  const wrapStatement = statement => ({ bind: (...args) => wrapStatement(statement.bind(...args)),
    async all() { const result = await statement.all(); measure(result); return result; } });
  const instrumented = { prepare: sql => wrapStatement(env.DB.prepare(sql)) };
  const windowSize = input.recentRatio == null ? 200 : Math.floor(input.size * input.recentRatio);
  const recent = input.noHistory ? [] : Array.from({length: Math.min(windowSize, Math.floor(input.size / 2))}, (_, i) => 's' + i);
  let buffer = [], attempts = 0;
  const start = performance.now();
  for (let i = 0; i < input.batches; i++) {
    let songs;
    if (input.mode === 'current') {
      const req = new Request('http://local/api/songs/roam', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seenSongIds: recent, limit: 10, language: input.language }) });
      const response = await handleLocalMusicDiscoveryRoute(req, new URL(req.url), instrumented, {}, 'fixture');
      songs = (await response.json()).data.songs;
    } else if (input.mode === 'oversample') {
      buffer = buffer.filter(song => !recent.includes(song.id));
      for (let tries = 0; buffer.length < 10 && tries < 10; tries++) {
        attempts++;
        let found;
        if (input.language) {
          // Hypothetical language-aware extension of the current random SQL.
          const filter = buildSongLanguageFilter(input.language);
          found = (await instrumented.prepare('SELECT ' + runtimeSongColumns('s') +
            " FROM Songs s WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> '' AND " +
            filter.sql + ' ORDER BY RANDOM() LIMIT ?').bind(...filter.bindings, 20).all()).results;
        } else {
          const req = new Request('http://local/api/songs/random?limit=20');
          const response = await handleLocalMusicDiscoveryRoute(req, new URL(req.url), instrumented, {}, 'fixture');
          found = (await response.json()).data.songs;
        }
        for (const song of found) if (!recent.includes(song.id) && !buffer.some(old => old.id === song.id)) buffer.push(song);
      }
      songs = buffer.splice(0, 10);
    } else {
      if (input.mode === 'always-cold' || (input.mode === 'cold-once' && i === 0)
        || (input.mode === 'cold-every-5' && i % 5 === 0)) sampler.clear(env.DB);
      songs = (await sampler.sample(env.DB, { recent, language: input.language, recentRatio: input.recentRatio ?? null,
        limit: 10, now: input.now || 1000, measure })).songs;
    }
    if (songs.length !== 10 || new Set(songs.map(s => s.id)).size !== 10 || songs.some(s => recent.includes(s.id))) throw new Error('batch contract failed');
    recent.push(...songs.map(s => s.id));
    recent.splice(0, Math.max(0, recent.length - windowSize));
  }
  return Response.json({ mode: input.mode, batches: input.batches, queries, rowsRead, returnedRows,
    databaseMs, requestWallMs: performance.now() - start, attempts });
} };` }, bundle: true, write: false, format: 'esm', platform: 'browser' });

const report = { note: 'Synthetic local workerd/D1 only. rowsRead is local D1 metadata, not measured Cloudflare billing. No auth, media, lyrics or play-stat requests included.', cases: [] };
const filteredOnly = process.argv.includes('--filtered-only');
const small = process.argv.includes('--small');
for (const size of (small ? [20, 100] : [1000, 10000, 50000])) {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'sampler-benchmark', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-23', d1Databases: ['DB'],
    outboundService: () => { throw new Error('OUTBOUND_BLOCKED'); },
  }] }));
  try {
    const { DB: db } = await mf.getBindings('sampler-benchmark');
    const baseline = readFileSync('server/db/migrations-flaretune/0001_baseline.sql', 'utf8');
    await db.prepare(baseline.match(/CREATE TABLE Songs \([\s\S]*?\n\);/)[0]).run();
    for (let from = 0; from < size; from += 250) {
      const values = Array.from({ length: Math.min(250, size - from) }, (_, offset) => {
        const id = from + offset;
        return "('s" + id + "','Song " + id + "','Artist','Album',180,'/audio/" + id + "','/cover/" + id + "','" + ['en', 'ja', 'zh', 'yue', 'ru'][id % 5] + "')";
      });
      await db.prepare('INSERT INTO Songs(id,title,artist,album,duration,audio_url,cover_url,language) VALUES ' + values.join(',')).run();
    }
    const call = async input => {
      const response = await mf.dispatchFetch('http://local/measure', { method: 'POST', body: JSON.stringify({ size, ...(small ? { recentRatio: 0.2 } : {}), ...input }) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const cases = [];
    if (filteredOnly) {
      // Test both a common language and one with only ten matching tracks.
      await db.prepare("UPDATE Songs SET language='ko' WHERE id IN ('s0','s1','s2','s3','s4','s5','s6','s7','s8','s9')").run();
      for (const language of ['en', 'ko']) {
        const measurements = [];
        for (const mode of ['current', 'oversample', 'always-cold', 'warm']) {
          measurements.push(await call({ mode, language, noHistory: true, batches: 1 }));
        }
        report.cases.push({ size, language, measurements });
      }
      console.log(JSON.stringify(report.cases.slice(-2)));
      continue;
    }
    for (const mode of ['current', 'oversample', 'cold-once', 'always-cold', 'cold-every-5']) {
      cases.push(await call({ mode, batches: 20 }));
    }
    // Force a new snapshot, then use separate HTTP requests to verify actual
    // cross-request binding/cache reuse rather than merely a loop in one request.
    const cold = await call({ mode: 'always-cold', batches: 1 });
    assert.equal(cold.queries, 2);
    const warm = await call({ mode: 'warm', batches: 1 });
    assert.equal(warm.queries, 1);
    const batchWarm = await call({ mode: 'warm', batches: 20 });
    assert.equal(batchWarm.queries, 20);
    const expired = await call({ mode: 'warm', batches: 1, now: 3_601_000 });
    assert.equal(expired.queries, 2);
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => call({ mode: 'warm', batches: 1, now: 7_201_000 })));
    assert.equal(concurrent.reduce((sum, item) => sum + item.queries, 0), 21);
    const row = { size, cold, warm, expired, concurrentQueries: 21, cases: [...cases, batchWarm] };
    report.cases.push(row);
    console.log(JSON.stringify(row));
  } finally { await mf.dispose(); }
}
mkdirSync('.tmp', { recursive: true });
writeFileSync(small ? '.tmp/roam-sampler-small-results.json' : filteredOnly ? '.tmp/roam-sampler-filtered-results.json' : '.tmp/roam-sampler-workerd-results.json', JSON.stringify(report, null, 2));
