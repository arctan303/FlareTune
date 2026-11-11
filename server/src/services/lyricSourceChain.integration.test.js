import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryPluginModules } from '../plugins/delivery.generated.js';
import { pluginRegistry } from '../plugins/registry.js';
import { createMemoryLyricStore } from '../test/lyricAssetFixtures.js';
import { createLyricDocument } from '../utils/lyricDocument.js';
import { buildReadyLyricArtifact, projectLyricArtifact } from './lyricAssetWorkflow.js';
import { createLyricSources, fileLyricSource, readLyricsFromChain } from './lyricSourceChain.js';

const session = { account: { accountId: 'paired-owner', role: 'admin' }, tokenHash: 'paired-session', mode: 'normal' };
const song = { id: 'yt:abcdefghijk', title: 'Fixture Song', artist: 'Fixture Singer', duration: 30, language: 'en' };
const translatedLines = ['第一行译文', '第二行译文'];
const originals = ['We sing beneath the evening sky', 'The stars will light our way back home'];

// This is the normalized YT provider boundary, not a mock workbench source.
// The assembled package, host SDK projection, chain selection and shared-file
// persistence all run together; no Google credentials or upstream AI are used.
for (const scenario of [
  { name: 'line preference and saved simplified-Chinese target', word: false, savedPolicy: true },
  { name: 'new installation defaults from the administrator Chinese UI', word: true, savedPolicy: false },
]) {
  test(`YT paired zh-CN file survives real workbench adoption: ${scenario.name}`, async t => {
    const workbench = deliveryPluginModules['lyrics-workbench'];
    assert.equal(typeof workbench?.createLyricSource, 'function', 'prepared workbench package exports its real factory');
    const store = createMemoryLyricStore();
    const calls = { ai: 0, aiLease: 0, network: 0, candidates: 0, youtube: 0 };
    const diagnostics = [];
    const installed = new Set(['lyrics-workbench', 'youtube-music']);
    const policy = {
      onlineEnabled: true, lyricPreference: 'line', provider: 'openai', model: 'fixture-model', temperature: 0.2,
      styleRules: '', targetLanguage: 'zh', cleanDirtyLyrics: false, translateLyrics: true,
      detectLanguage: true, referenceExistingTranslation: false, completionEnabled: true, automaticCompletionEnabled: true,
    };
    const db = { prepare(sql) {
      return { bind() { return this; }, async first() {
        if (sql.includes('AS policy_json')) return {
          policy_json: scenario.savedPolicy ? JSON.stringify(policy) : null,
          installation_json: JSON.stringify({ installed: true, epoch: 'installed-fixture', uiLanguage: 'zh' }),
        };
        if (sql.includes('FROM instance_settings')) return null;
        throw new Error(`Unexpected integration query: ${sql}`);
      } };
    } };
    const env = { DB: db, SETUP_SECRET: 'integration-setup-secret-at-least-32-characters' };
    const nativeDocument = createLyricDocument({ source: 'youtube', format: 'lrc',
      lines: originals.map((text, index) => ({ text, time: index * 4 + 1,
        ...(scenario.word ? { words: [{ text, startTime: index * 4 + 1, endTime: index * 4 + 4 }] } : {}) })),
      providerMeta: { providerLyricId: 'youtube:paired-fixture', matchedTitle: song.title,
        matchedArtist: song.artist, matchedDuration: song.duration },
    });
    const modules = {
      'lyrics-workbench': workbench,
      'youtube-music': { createLyricSource: () => ({ id: 'youtube-music', claim: item => item.id.startsWith('yt:'),
        resolve: async () => { calls.youtube++; return { quality: 'good', document: nativeDocument,
          translation: { supported: true, state: 'ready', language: 'zh-CN', targetLanguage: 'zh-CN',
            source: 'youtube', kind: 'machine', lines: translatedLines },
        }; },
      }) },
    };
    t.mock.method(globalThis, 'fetch', async () => { calls.network++; throw new Error('Unexpected external request'); });
    const dependencies = {
      modules, store, registry: pluginRegistry, locale: 'en',
      requireSession: async () => ({ accountId: session.account.accountId }),
      createContext: async ({ pluginId }) => {
        assert.ok(installed.has(pluginId));
        return { identity: session.account, plugin: { id: pluginId, epoch: 'installed-fixture' },
          assertCurrent: async () => { assert.ok(installed.has(pluginId)); } };
      },
      loadSources: async () => ({ version: 2, sources: [] }),
      resolveSong: async () => song,
      fetchCandidate: async () => { calls.candidates++; return null; },
      createAiLease: async () => { calls.aiLease++; return {}; },
      beginCompletion: async () => { calls.ai++; throw new Error('Existing paired translation must not start AI'); },
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    };
    const play = () => readLyricsFromChain({ env, db, session, song, deps: dependencies });

    const first = await play();
    assert.equal(first.state, 'found');
    assert.equal(first.lyrics.sourceId, 'youtube-music');
    const fromYoutube = store.current();
    assert.equal(fromYoutube.provenance.managedBy, 'youtube-music');
    assert.equal(fromYoutube.provenance.evaluation, 'unassessed');
    assert.equal(fromYoutube.provenance.originalSource, 'youtube');
    assert.equal(fromYoutube.translation.language, 'zh-CN');
    assert.equal(fromYoutube.translation.originalTextHash, fromYoutube.textHash);
    assert.deepEqual(fromYoutube.translation.lines, translatedLines);
    const projected = projectLyricArtifact(fromYoutube, { song, targetLanguage: 'zh' });
    assert.equal(projected.translationAvailable, true);
    assert.equal(projected.translationState, 'ready');
    assert.deepEqual(projected.lines.map(line => line.tlyric), translatedLines);

    const second = await play();
    assert.equal(second.state, 'found');
    assert.equal(second.lyrics.sourceId, 'lyrics-workbench', JSON.stringify(diagnostics));
    assert.equal(second.lyrics.quality, 'good');
    assert.equal(second.lyrics.translation.targetLanguage, 'zh', 'later listener English UI does not replace the site target');
    assert.equal(second.lyrics.translation.language, 'zh-CN');
    assert.equal(second.lyrics.translation.state, 'ready');
    assert.equal(second.lyrics.translation.supported, true);
    assert.deepEqual(second.lyrics.translation.lines, translatedLines);
    const assessed = store.current();
    assert.equal(assessed.provenance.managedBy, 'lyrics-workbench');
    assert.equal(assessed.provenance.evaluation, 'assessed');
    assert.equal(assessed.provenance.originalSource, 'youtube');
    assert.equal(assessed.provenance.providerLyricId, 'youtube:paired-fixture');
    assert.match(assessed.provenance.assessmentKey, /^[a-f0-9]{64}$/u);
    assert.deepEqual(assessed.translation, fromYoutube.translation, 'evaluation preserves the entire paired provider layer');
    assert.equal(assessed.textHash, fromYoutube.textHash);
    assert.equal(assessed.aiCompletion, null);
    assert.deepEqual(assessed.original, fromYoutube.original);
    assert.deepEqual(calls, { ai: 0, aiLease: 0, network: 0, candidates: 2, youtube: 1 });
    assert.deepEqual(diagnostics, []);
  });
}

function lazyChainFixture(initial) {
  const states = Object.fromEntries(Object.entries(initial).map(([id, state]) => [id, {
    installed: true, authorized: true, enabled: true, epoch: 'epoch-1', build: 'build-1', ...state,
  }]));
  const counters = Object.fromEntries(Object.keys(states).map(id => [id, { context: 0, factory: 0, resolve: 0 }]));
  const diagnostics = [];
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const db = { orderReads: 0, prepare() { return { bind() { return this; }, async first() {
    db.orderReads++;
    return { value_json: JSON.stringify(Object.keys(states)), revision: 1 };
  } }; } };
  const env = { DB: db, SETUP_SECRET: 'lazy-integration-secret-with-at-least-32-characters' };
  const store = createMemoryLyricStore();
  const modules = Object.fromEntries(Object.keys(states).map(id => [id, {
    createLyricSource: () => {
      counters[id].factory++;
      return { id, enabled: states[id].enabled,
        ...(states[id].runtimeEnabled === undefined ? {} : { isEnabled: async () => states[id].runtimeEnabled }),
        claim: () => true,
        resolve: async () => { counters[id].resolve++; return states[id].result ?? null; },
      };
    },
  }]));
  const deps = { store, modules, registry: { getBuildDigest: id => states[id].build },
    requireSession: async () => ({ accountId: session.account.accountId }),
    createContext: async ({ pluginId: id }) => {
      counters[id].context++;
      const state = states[id];
      if (!state.installed) fail('PLUGIN_NOT_INSTALLED');
      if (!state.authorized) fail('forbidden');
      const epoch = state.epoch;
      return { identity: session.account, plugin: { id, epoch }, assertCurrent: async () => {
        if (!state.installed || state.epoch !== epoch) fail('PLUGIN_NOT_INSTALLED');
        if (!state.authorized) fail('forbidden');
      } };
    },
    onDiagnostic: row => diagnostics.push(row),
  };
  return { env, db, deps, states, counters, diagnostics,
    play: options => readLyricsFromChain({ env, db, session, song, deps, ...options }),
    reset() {
      for (const counter of Object.values(counters)) counter.context = counter.factory = counter.resolve = 0;
      db.orderReads = 0;
    },
  };
}
const lazyResult = () => ({ quality: 'good', document: createLyricDocument({ source: 'lrclib', format: 'lrc',
  lines: originals.map((text, index) => ({ text, time: index * 4 + 1 })) }),
  translation: { supported: false, state: 'unavailable' } });

test('lazy chain never initializes a later plugin after the first good result', async () => {
  const f = lazyChainFixture({ first: { result: lazyResult() }, unreached: { result: lazyResult() } });
  const declared = await createLyricSources({ env: f.env, db: f.db, session, deps: f.deps });
  assert.deepEqual(declared.map(source => source.id), ['first', 'unreached', 'file']);
  assert.deepEqual(f.counters, {
    first: { context: 0, factory: 0, resolve: 0 }, unreached: { context: 0, factory: 0, resolve: 0 },
  }, 'declaring sources does not authorize or execute plugin code');
  const found = await f.play();
  assert.equal(found.lyrics.sourceId, 'first');
  assert.deepEqual(f.counters.first, { context: 1, factory: 1, resolve: 1 });
  assert.deepEqual(f.counters.unreached, { context: 0, factory: 0, resolve: 0 });
  assert.deepEqual(f.diagnostics, []);
});

test('source enumeration removes missing and disabled plugins without running unauthorized factories', async () => {
  const f = lazyChainFixture({ active: {}, missing: { installed: false }, forbidden: { authorized: false },
    disabled: { enabled: false }, 'runtime-disabled': { runtimeEnabled: false } });
  const sources = await createLyricSources({ env: f.env, db: f.db, session, deps: f.deps, enumerate: true });
  assert.deepEqual(sources.map(source => source.id), ['active', 'file']);
  for (const id of ['missing', 'forbidden']) {
    assert.deepEqual(f.counters[id], { context: 1, factory: 0, resolve: 0 }, `${id} cannot execute its factory`);
  }
  for (const id of ['active', 'disabled', 'runtime-disabled']) {
    assert.deepEqual(f.counters[id], { context: 1, factory: 1, resolve: 0 });
  }
  assert.deepEqual(f.diagnostics, []);
});

test('a fixed result lazily initializes only its original source and rejects changed epochs or builds', async () => {
  const f = lazyChainFixture({ first: {}, selected: { result: lazyResult() } });
  const initial = await f.play();
  assert.equal(initial.lyrics.sourceId, 'selected');
  const resultRef = initial.lyrics.resultRef;
  assert.equal(typeof resultRef, 'string');
  f.states.first.result = lazyResult(); // A fresh search would now choose this source.
  f.reset();
  const polled = await f.play({ resultRef });
  assert.equal(polled.lyrics.sourceId, 'selected');
  assert.deepEqual(f.counters.first, { context: 0, factory: 0, resolve: 0 });
  assert.deepEqual(f.counters.selected, { context: 1, factory: 1, resolve: 1 });
  assert.equal(f.db.orderReads, 0, 'fixed result polling does not re-evaluate the source order');

  for (const field of ['epoch', 'build']) {
    f.reset();
    f.states.selected[field] = `${field}-changed`;
    await assert.rejects(f.play({ resultRef }), error => error.code === 'LYRIC_RESULT_RETIRED');
    assert.deepEqual(f.counters.first, { context: 0, factory: 0, resolve: 0 });
    assert.deepEqual(f.counters.selected, { context: 1, factory: 1, resolve: 0 }, `${field} is checked before source resolution`);
    f.states.selected[field] = `${field}-1`;
  }
  f.reset();
  f.states.selected.installed = false;
  await assert.rejects(f.play({ resultRef }), error => error.code === 'LYRIC_RESULT_RETIRED');
  assert.deepEqual(f.counters.selected, { context: 1, factory: 0, resolve: 0 });
  assert.deepEqual(f.counters.first, { context: 0, factory: 0, resolve: 0 });
  assert.deepEqual(f.diagnostics, []);
});

for (const scenario of [
  { name: 'copied layer with AI disabled', partial: false, completion: false, automatic: true, state: 'unavailable' },
  { name: 'copied layer with manual AI', partial: false, completion: true, automatic: false, state: 'idle' },
  { name: 'copied layer with automatic AI', partial: false, completion: true, automatic: true, state: 'pending' },
  { name: 'partially unchanged real translation', partial: true, completion: true, automatic: true, state: 'ready' },
]) {
  test(`real workbench obeys host projection in the default chain: ${scenario.name}`, async t => {
    const document = createLyricDocument({ source: 'youtube', format: 'lrc',
      lines: originals.map((text, index) => ({ text, time: index * 4 + 1 })) });
    const initial = (await buildReadyLyricArtifact(song, document)).artifact;
    initial.translation = { source: 'youtube', kind: 'machine', language: 'zh-CN', originalTextHash: initial.textHash,
      lines: scenario.partial ? [originals[0], translatedLines[1]] : [...originals], updatedAt: initial.updatedAt };
    const savedLayer = structuredClone(initial.translation);
    const store = createMemoryLyricStore(initial);
    const policy = { onlineEnabled: false, lyricPreference: 'line', provider: 'openai', model: 'fixture-model', temperature: 0.2,
      styleRules: '', targetLanguage: 'zh', cleanDirtyLyrics: false, translateLyrics: true, detectLanguage: true,
      referenceExistingTranslation: false, completionEnabled: scenario.completion, automaticCompletionEnabled: scenario.automatic };
    const db = { prepare(sql) { return { bind() { return this; }, async first() {
      return sql.includes('AS policy_json') ? { policy_json: JSON.stringify(policy) } : null;
    } }; } };
    const env = { DB: db, SETUP_SECRET: 'legacy-copy-integration-secret-at-least-32-characters' };
    const calls = { ai: 0, youtube: 0 };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(release);
    const tasks = [];
    const executionContext = { waitUntil: task => tasks.push(task) };
    const deps = { store, registry: pluginRegistry,
      modules: { 'lyrics-workbench': deliveryPluginModules['lyrics-workbench'],
        'youtube-music': { createLyricSource: () => { calls.youtube++; throw new Error('Good workbench result ends the chain'); } } },
      requireSession: async () => ({ accountId: session.account.accountId }),
      createContext: async ({ pluginId }) => ({ identity: session.account, plugin: { id: pluginId, epoch: 'legacy-copy-epoch' },
        assertCurrent: async () => {} }),
      loadSources: async () => ({ version: 2, sources: [] }),
      resolveSong: async () => song,
      createAiLease: async () => ({ assertCurrent: async () => {}, guardedDb: value => value }),
      aiDeps: { reserveDailyQuota: async () => true,
        createGatewayClient: async () => ({ config: policy, assertCurrent: async () => {}, guardedDb: value => value,
          ask: async messages => { calls.ai++; await gate; return { songLanguage: 'en', discardLineIndices: [],
            translations: JSON.parse(messages.at(-1).content).units.map(unit => ({ unitId: unit.unitId,
              text: translatedLines[originals.indexOf(unit.text)] })) }; },
        }),
      },
    };
    // The real factory/completion path uses explicit test service capabilities.
    // The host's authenticated service registration is covered by lease tests;
    // it intentionally rejects synthetic leases, so instantiate this source
    // directly while retaining the real default-order selection and projection.
    const workbench = await deliveryPluginModules['lyrics-workbench'].createLyricSource({ env, db, session, executionContext,
      context: await deps.createContext({ pluginId: 'lyrics-workbench' }), dependencies: deps });
    deps.sources = [{ ...workbench, epoch: 'legacy-copy-epoch', build: pluginRegistry.getBuildDigest('lyrics-workbench'),
      assertCurrent: async () => {} }, { id: 'youtube-music', claim: () => true,
      resolve: async () => { calls.youtube++; throw new Error('Good workbench result ends the chain'); } }, fileLyricSource(store)];
    const hostProjection = projectLyricArtifact(initial, { song, targetLanguage: 'zh' });
    assert.equal(hostProjection.translationAvailable, scenario.partial);
    const found = await readLyricsFromChain({ env, db, session, song, deps });
    assert.equal(found.lyrics.sourceId, 'lyrics-workbench');
    assert.equal(found.lyrics.translation.state, scenario.state);
    assert.equal(found.lyrics.translation.supported, scenario.partial || scenario.completion);
    assert.deepEqual(found.lyrics.translation.lines, scenario.partial ? savedLayer.lines : undefined);
    assert.deepEqual(store.current().translation, savedLayer, 'projection and completion startup do not delete the old saved layer');
    assert.deepEqual(store.current().original, initial.original);
    assert.equal(calls.youtube, 0);
    assert.equal(calls.ai, scenario.state === 'pending' ? 1 : 0);
    if (scenario.state === 'idle') {
      const started = await readLyricsFromChain({ env, db, session, song, deps,
        resultRef: found.lyrics.resultRef, translate: true });
      assert.equal(started.lyrics.translation.state, 'pending');
      assert.equal(calls.ai, 1);
      assert.deepEqual(store.current().translation, savedLayer);
    }
    release();
    await Promise.all(tasks);
    if (scenario.completion && !scenario.partial) {
      assert.equal(store.current().aiCompletion, null);
      assert.deepEqual(store.current().translation.lines, translatedLines);
    }
  });
}
