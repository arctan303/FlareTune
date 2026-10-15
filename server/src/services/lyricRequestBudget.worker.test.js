import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('workerd shares lyric search budgets across adapters and fresh operations on a reused loader', { timeout: 30000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), contents: `
    import { createNamedLyricSourceLoader } from './server/src/services/namedLyricSourceLoader.js';
    import { fetchLyricsDocumentWithFallback } from './server/src/services/lyricSourceLoader.js';
    import { listLyricsResolutionCandidates } from './server/src/services/lyricResolution.js';
    import { inspectLyricCandidates } from './server/src/services/lyricCandidateInspection.js';
    import { fetchUpgradeDocument } from './server/src/services/lyricAssetUpgrade.js';
    const song = { id: 'budget-song', title: 'Song (feat. Guest)', artist: 'Artist / Singer', duration: 200.6 };
    const sources = Array.from({ length: 8 }, (_, index) => ({
      id: 'lyric_' + String(index + 1).repeat(32), name: 'Source ' + index, note: '',
      protocol: 'custom_krc', enabled: true, translationLanguage: 'en',
      searchUrl: 'https://source' + index + '.example.com/search',
      downloadUrl: 'https://source' + index + '.example.com/download',
    }));
    const loader = createNamedLyricSourceLoader({ channels: { version: 2, sources } });
    export default { async fetch(request, env, ctx) {
      const mode = new URL(request.url).pathname;
      if (mode === '/candidates') return Response.json(await listLyricsResolutionCandidates(song,
        { enabledSources: loader.enabledSources, listCandidates: loader.listSourceCandidates }));
      if (mode === '/inspect') return Response.json(await inspectLyricCandidates(song,
        sources.map(source => ({ source: source.id, providerLyricId: 'missing' })),
        { createProviderSnapshot: loader.createCandidateInspectionSnapshot }));
      const task = mode === '/upgrade'
        ? fetchUpgradeDocument(song, loader.fetchSourceDocument, { enabledSources: loader.enabledSources })
        : fetchLyricsDocumentWithFallback('auto', song, loader.fetchSourceDocument, { enabledSources: loader.enabledSources });
      ctx.waitUntil(task);
      return Response.json({ source: (await task)?.source });
    } };` }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'lyrics-budget', modules: true,
    compatibilityDate: '2026-09-23', script: bundle.outputFiles[0].text,
    outboundService: async request => {
      const url = new URL(request.url); calls.push(url);
      assert.ok(calls.length <= 50, 'a Workers Free request must stay below 50 external subrequests');
      if (url.hostname !== 'lrclib.net') return Response.json({ candidates: [] });
      const candidate = { id: 1, trackName: 'Song (feat. Guest)', artistName: 'Artist / Singer',
        duration: 200.6, syncedLyrics: '[00:01.000]Reliable lyric' };
      return Response.json(url.pathname === '/api/get' ? candidate : [candidate]);
    },
  }] }));
  try {
    for (const path of ['/auto', '/candidates', '/inspect', '/upgrade', '/auto']) {
      calls.length = 0;
      const response = await mf.dispatchFetch('https://app.example.com' + path);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.ok(calls.length <= 32, path + ': ' + calls.length + ' external requests');
      if (path === '/candidates') {
        assert.equal(result.candidates[0]?.source, 'lrclib');
        assert.ok(result.warnings.some(item => item.code === 'rate_limited'));
      } else if (path === '/inspect') {
        assert.ok(result.items.some(item => item.error?.code === 'search_rate_limited'));
      } else {
        assert.equal(result.source, 'lrclib');
        assert.equal(calls.length, 32);
      }
    }
  } finally { await mf.dispose(); }
});
