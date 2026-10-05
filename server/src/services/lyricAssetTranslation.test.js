import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricArtifactStore } from './lyricArtifactStore.js';
import { createMemoryR2Bucket } from '../test/lyricAssetFixtures.js';
import {
  beginLyricAssetAiCompletion,
  runLyricAssetAiCompletion,
} from './lyricAssetTranslation.js';
import {
  createMemoryLyricStore,
  makeReadyArtifact,
  makeSong,
} from '../test/lyricAssetFixtures.js';

const STARTED_AT = '2026-09-10T00:00:00.000Z';
const FINISHED_AT = Date.parse('2026-09-10T00:01:00.000Z');

function pendingArtifact(overrides = {}) {
  return makeReadyArtifact({
    aiCompletion: { status: 'pending', updatedAt: STARTED_AT },
    ...overrides,
  });
}

function successDeps(overrides = {}) {
  return {
    now: () => FINISHED_AT,
    reserveDailyQuota: async () => true,
    getAIAssistantConfig: async () => ({
      provider: 'deepseek',
      model: 'test-model',
      systemPrompt: '',
    }),
    resolveAiFeature: async () => null,
    askAI: async () => ({ translations: [{ unitId: 0, text: '你好' }] }),
    ...overrides,
  };
}

function multiBatchPendingArtifact(lineCount) {
  const base = pendingArtifact();
  return pendingArtifact({
    original: {
      ...base.original,
      syncMode: 'line',
      lines: Array.from({ length: lineCount }, (_, index) => ({
        time: index,
        text: `Foreign lyric ${index}`,
      })),
    },
  });
}

function translatedBatch(messages) {
  const units = JSON.parse(messages.at(-1).content).units;
  return { translations: units.map(({ unitId }) => ({ unitId, text: `译文${unitId}` })) };
}

test('asset AI completion writes aligned translation and clears pending state', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  const result = await runLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps(),
  });
  assert.equal(result.state, 'updated');
  assert.equal(store.current().translation.source, 'ai');
  assert.deepEqual(store.current().translation.lines, ['你好']);
  assert.equal(store.current().aiCompletion, null);
});

test('automatic AI retains server ownership through completion while manual AI revokes it', async t => {
  for (const automatic of [true, false]) await t.test(String(automatic), async () => {
    const store = createLyricArtifactStore({ MEDIA_BUCKET: createMemoryR2Bucket() });
    await store.createIfAbsent('song-1', makeReadyArtifact(), { automation: { checkedAt: STARTED_AT } });
    const result = await beginLyricAssetAiCompletion({ env: {}, db: {}, song: makeSong(), store,
      automatic, force: true, deps: successDeps() });
    assert.equal(result.state, 'started');
    await result.task;
    const final = await store.get('song-1');
    assert.equal(final.artifact.translation.source, 'ai');
    assert.deepEqual(final.automation, automatic ? { checkedAt: STARTED_AT } : undefined);
  });
});

test('lyric completion uses its assigned profile while retaining lyric-specific rules', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  const seen = [];
  const result = await runLyricAssetAiCompletion({
    env: { DEEPSEEK_API_KEY: 'legacy' }, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64),
    deps: successDeps({
      resolveAiFeature: async (db, feature, env, legacy) => {
        assert.equal(feature, 'lyrics');
        return { config: { ...legacy, provider: 'openai', model: 'lyric-model' },
          env: { ...env, OPENAI_API_KEY: 'profile-key' } };
      },
      askAI: async (messages, config, aiEnv) => {
        seen.push({ config, aiEnv });
        return { translations: [{ unitId: 0, text: '你好' }] };
      },
    }),
  });
  assert.equal(result.state, 'updated');
  assert.equal(seen[0].config.model, 'lyric-model');
  assert.equal(seen[0].config.provider, 'openai');
  assert.equal(seen[0].aiEnv.OPENAI_API_KEY, 'profile-key');
});

test('Worker infers song language from lyric text and updates metadata only after the asset commits', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  const changes = [];
  const result = await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong({ language: 'ja' }), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64),
    deps: successDeps({
      askAI: async (messages) => {
        const input = JSON.parse(messages.at(-1).content);
        assert.match(input.languageSample, /Hello/u);
        assert.match(messages[0].content, /songLanguage/u);
        return { songLanguage: 'en', translations: [{ unitId: 0, text: '你好' }] };
      },
      updateSongLanguage: async (...args) => {
        assert.equal(store.current().aiCompletion, null);
        changes.push(args);
      },
    }),
  });
  assert.equal(result.state, 'updated');
  assert.deepEqual(changes, [['song-1', 'en', 'ja']]);
});

test('a failed song-language write is visible as retryable AI failure', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  const result = await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong({ language: 'ja' }), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64),
    deps: successDeps({
      askAI: async () => ({ songLanguage: 'en', translations: [{ unitId: 0, text: '你好' }] }),
      updateSongLanguage: async () => { throw new Error('private database detail'); },
    }),
  });
  assert.equal(result.state, 'updated');
  assert.deepEqual(store.current().translation.lines, ['你好']);
  assert.equal(store.current().aiCompletion.status, 'failed');
  assert.equal(store.current().aiCompletion.errorCode, 'language_update_failed');
  assert.doesNotMatch(JSON.stringify(store.current()), /private database detail/u);
});

test('unrecognized AI language cannot change song metadata', async () => {
  const changes = [];
  const store = createMemoryLyricStore(pendingArtifact());
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong({ language: 'ja' }), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64),
    deps: successDeps({
      askAI: async () => ({ songLanguage: 'unknown-code', translations: [{ unitId: 0, text: '你好' }] }),
      updateSongLanguage: async (...args) => changes.push(args),
    }),
  });
  assert.deepEqual(changes, []);
});

test('instance target language controls the Worker prompt and stored translation language', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong({ language: 'en' }), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64), force: true,
    deps: successDeps({
      loadLyricAiConfig: async () => ({
        provider: 'deepseek', model: 'test-model', temperature: 0.2,
        systemPrompt: '', targetLanguage: 'ja', cleanDirtyLyrics: false,
        translateLyrics: true, detectLanguage: false, referenceExistingTranslation: false,
      }),
      askAI: async (messages) => {
        assert.match(messages[0].content, /日语/u);
        return { translations: [{ unitId: 0, text: 'こんにちは' }] };
      },
    }),
  });
  assert.equal(store.current().translation.language, 'ja');
  assert.deepEqual(store.current().translation.lines, ['こんにちは']);
});

test('AI cleanup removes non-lyric lines and aligns translation in one write', async () => {
  const base = pendingArtifact();
  const store = createMemoryLyricStore(pendingArtifact({
    original: { ...base.original, lines: [
      { time: 0, text: 'Lyrics by: Someone' }, base.original.lines[0],
    ] },
  }));
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64), actorAccountId: 'local_member',
    deps: successDeps({
      askAI: async () => ({ songLanguage: 'en', discardLineIndices: [0],
        translations: [{ unitId: 1, text: '你好' }] }),
      updateSongLanguage: async () => {},
    }),
  });
  assert.deepEqual(store.current().original.lines.map((line) => line.text), ['Hello']);
  assert.deepEqual(store.current().translation.lines, ['你好']);
  assert.equal(store.current().aiCompletion, null);
  assert.equal(store.current().translation.originalTextHash, store.current().textHash);
  assert.notEqual(store.current().textHash, 'a'.repeat(64));
  assert.equal(store.calls.put, 1);
});

test('AI completion removes whole credit rows and preserves every word timestamp of sung lines', async () => {
  const sungFirst = { time: 13.761, endTime: 14.6, text: 'One on one',
    words: [{ text: 'One ', startTime: 13.761, endTime: 14.1 },
      { text: 'on one', startTime: 14.1, endTime: 14.6 }] };
  const sungSecond = { time: 15.837, endTime: 16.5, text: 'You are speaking to me',
    words: [{ text: 'You are ', startTime: 15.837, endTime: 16.1 },
      { text: 'speaking to me', startTime: 16.1, endTime: 16.5 }] };
  const base = pendingArtifact();
  const original = { ...base.original, lines: [
    { time: 0.116, text: 'One On One - The Knocks/Sofi Tukker' },
    { time: 0.995, text: 'Lyrics by: Martina Sorbara' },
    { time: 1.556, text: 'Composed by: Martina Sorbara' },
    sungFirst, sungSecond,
  ] };
  const store = createMemoryLyricStore(pendingArtifact({ original }));
  let seenConfig;
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong({ title: 'One On One', artist: 'The Knocks, Sofi Tukker' }),
    store, startedAt: STARTED_AT, textHash: 'a'.repeat(64), force: true,
    deps: successDeps({
      getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'deepseek-flash',
        enableThinking: true,
        targetLanguage: 'zh', cleanDirtyLyrics: true, translateLyrics: true,
        detectLanguage: true, referenceExistingTranslation: false }),
      askAI: async (messages, config) => {
        seenConfig = config;
        const payload = JSON.parse(messages.at(-1).content);
        assert.equal(payload.title, 'One On One');
        assert.equal(payload.artist, 'The Knocks, Sofi Tukker');
        assert.equal('referenceTranslations' in payload, false);
        return { songLanguage: 'en', discardLineIndices: [0, 1, 2], translations: [
          { unitId: 0, text: '一对一 - 歌手' },
          { unitId: 3, text: '一对一' },
          { unitId: 4, text: '你正对我说话' },
        ] };
      },
      updateSongLanguage: async () => {},
    }),
  });
  assert.equal(seenConfig.enableThinking, false);
  assert.deepEqual(store.current().original.lines, [sungFirst, sungSecond]);
  assert.equal(store.current().original.syncMode, 'word');
  assert.deepEqual(store.current().translation.lines, ['一对一', '你正对我说话']);
  assert.equal(store.current().translation.originalTextHash, store.current().textHash);
  assert.equal(store.calls.put, 1);
});

test('AI cleanup preserves a sung opening line matching title and artist when model declines deletion', async () => {
  const opening = { time: 0.5, text: 'Night Song - Singer' };
  const base = pendingArtifact();
  const store = createMemoryLyricStore(pendingArtifact({ original: { ...base.original,
    lines: [opening, base.original.lines[0]] } }));
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64), force: true,
    deps: successDeps({
      getAIAssistantConfig: async () => ({ provider: 'deepseek', model: 'test-model',
        targetLanguage: 'zh', cleanDirtyLyrics: true, translateLyrics: false,
        detectLanguage: true, referenceExistingTranslation: false }),
      askAI: async () => ({ notNeeded: true, songLanguage: 'en', discardLineIndices: [] }),
      updateSongLanguage: async () => {},
    }),
  });
  assert.deepEqual(store.current().original.lines, [opening, base.original.lines[0]]);
});

test('a sung title before a credit is retained unless the model selects that row', async () => {
  const sungTitle = { time: 0.1, endTime: 1, text: 'One on one',
    words: [{ text: 'One on one', startTime: 0.1, endTime: 1 }] };
  const sungNext = { time: 14, endTime: 15, text: 'Sing together',
    words: [{ text: 'Sing together', startTime: 14, endTime: 15 }] };
  const base = pendingArtifact();
  const store = createMemoryLyricStore(pendingArtifact({ original: { ...base.original,
    lines: [sungTitle, { time: 1, text: 'Lyrics by: Someone' }, sungNext] } }));
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong({ title: 'One on one', artist: 'Band' }), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64), force: true,
    deps: successDeps({ askAI: async () => ({ songLanguage: 'en', discardLineIndices: [1],
      translations: [{ unitId: 0, text: '一对一' }, { unitId: 2, text: '一起歌唱' }] }),
    updateSongLanguage: async () => {} }),
  });
  assert.deepEqual(store.current().original.lines, [sungTitle, sungNext]);
  assert.equal(store.current().original.syncMode, 'word');
  assert.deepEqual(store.current().translation.lines, ['一对一', '一起歌唱']);
});

test('disabled lyric AI settles a pending request without spending quota or calling a model', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  let quotaCalls = 0;
  let modelCalls = 0;
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64), force: true,
    deps: successDeps({
      loadLyricAiConfig: async () => ({ provider: 'deepseek', model: 'test-model',
        completionEnabled: false }),
      reserveDailyQuota: async () => { quotaCalls += 1; return true; },
      askAI: async () => { modelCalls += 1; return { notNeeded: true }; },
    }),
  });
  assert.equal(quotaCalls, 0);
  assert.equal(modelCalls, 0);
  assert.equal(store.current().aiCompletion, null);
});

test('manual completion replaces a provider translation instead of treating it as AI output', async () => {
  const base = pendingArtifact();
  const store = createMemoryLyricStore(pendingArtifact({
    translation: { source: 'kugou', language: 'zh', originalTextHash: base.textHash,
      lines: ['旧译文'] },
  }));
  let calls = 0;
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store, startedAt: STARTED_AT,
    textHash: 'a'.repeat(64), force: true,
    deps: successDeps({ askAI: async (messages) => {
      calls += 1;
      assert.equal('referenceTranslations' in JSON.parse(messages.at(-1).content), false);
      return { translations: [{ unitId: 0, text: '新的译文' }] };
    } }),
  });
  assert.equal(calls, 1);
  assert.equal(store.current().translation.source, 'ai');
  assert.deepEqual(store.current().translation.lines, ['新的译文']);
});

test('AI cleanup refuses to leave only the song title and artist', async () => {
  const base = pendingArtifact();
  const store = createMemoryLyricStore(pendingArtifact({
    original: { ...base.original, lines: [
      { time: 0, text: 'Night Song - Singer' }, base.original.lines[0],
    ] },
  }));
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64),
    deps: successDeps({ askAI: async () => ({ songLanguage: 'en',
      discardLineIndices: [1], translations: [
        { unitId: 0, text: '夜之歌 - 歌手' }, { unitId: 1, text: '你好' },
      ] }), updateSongLanguage: async () => {} }),
  });
  assert.deepEqual(store.current().original.lines.map((line) => line.text),
    ['Night Song - Singer', 'Hello']);
  assert.equal(store.current().aiCompletion, null);
});

test('manual AI request still identifies a song whose lyrics need no translation', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  const changes = [];
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong({ language: 'en' }), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64), force: true,
    deps: successDeps({
      askAI: async () => ({ songLanguage: 'zh', notNeeded: true }),
      updateSongLanguage: async (...args) => changes.push(args),
    }),
  });
  assert.equal(store.current().translation, null);
  assert.equal(store.current().aiCompletion.status, 'completed');
  assert.equal(store.current().aiCompletion.processingKey, 'zh|1|1|1|0|1|1');
  assert.deepEqual(changes, [['song-1', 'zh', 'en']]);
});

test('AI failure keeps the previous translation until a replacement succeeds', async () => {
  const previous = {
    source: 'ai',
    originalTextHash: 'a'.repeat(64),
    lines: ['旧译文'],
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
  const store = createMemoryLyricStore(pendingArtifact({ translation: previous }));
  await runLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({ askAI: async () => { throw new Error('AI_TIMEOUT'); } }),
  });
  assert.deepEqual(store.current().translation, previous);
  assert.equal(store.current().aiCompletion.status, 'failed');
  assert.equal(store.current().aiCompletion.errorCode, 'ai_timeout');
});

test('public AI failure state uses an allowlisted code instead of upstream error text', async () => {
  const store = createMemoryLyricStore(pendingArtifact({ translation: null }));
  const current = store.current();
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: current.aiCompletion.updatedAt,
    textHash: current.textHash,
    deps: {
      reserveDailyQuota: async () => true,
      getAIAssistantConfig: async () => ({ provider: 'openai', model: 'test', systemPrompt: '' }),
      askAI: async () => { throw new Error('AI_UPSTREAM_400: secret-token-from-provider'); },
    },
  });
  assert.equal(store.current().aiCompletion.errorCode, 'completion_failed');
  assert.doesNotMatch(JSON.stringify(store.current()), /secret-token-from-provider/u);
});

test('quota failure is recorded in R2 without removing usable lyrics', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  await runLyricAssetAiCompletion({
    env: { AI_TRANSLATION_DAILY_LIMIT: 1 },
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({ reserveDailyQuota: async () => false }),
  });
  assert.equal(store.current().original.lines[0].text, 'Hello');
  assert.equal(store.current().translation, null);
  assert.equal(store.current().aiCompletion.errorCode, 'quota_exhausted');
});

test('unreadable assigned model key fails before daily quota is reserved', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  let reservations = 0;
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT, textHash: 'a'.repeat(64),
    deps: successDeps({
      resolveAiFeature: async () => { throw new Error('AI_MISSING_KEY'); },
      reserveDailyQuota: async () => { reservations += 1; return true; },
    }),
  });
  assert.equal(reservations, 0);
  assert.equal(store.current().aiCompletion.status, 'failed');
  assert.equal(store.current().aiCompletion.errorCode, 'missing_key');
});

test('quota storage errors settle the asset as safely failed instead of leaving pending', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  await runLyricAssetAiCompletion({
    env: { AI_TRANSLATION_DAILY_LIMIT: 1 },
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({
      reserveDailyQuota: async () => { throw new Error('D1 quota failure: private detail'); },
    }),
  });
  assert.equal(store.current().original.lines[0].text, 'Hello');
  assert.equal(store.current().translation, null);
  assert.equal(store.current().aiCompletion.status, 'failed');
  assert.equal(store.current().aiCompletion.errorCode, 'completion_failed');
  assert.doesNotMatch(JSON.stringify(store.current()), /private detail/u);
});

test('asset completion passes a sub-30-second remaining budget to the shared AI timeout override', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  let timeoutMs = null;
  await runLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({
      askAI: async (_messages, _config, _env, options) => {
        timeoutMs = options?.timeoutMs;
        return { translations: [{ unitId: 0, text: '你好' }] };
      },
    }),
  });
  assert.equal(Number.isInteger(timeoutMs), true);
  assert.equal(timeoutMs >= 5_000, true);
  assert.equal(timeoutMs <= 24_000, true);
  assert.equal(timeoutMs < 30_000, true);
  assert.equal(store.current().aiCompletion, null);
});

test('the overall lifecycle deadline converts a stalled prerequisite to failed and blocks late completion', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = performance.now();
  await runLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({
      completionDeadlineMs: 20,
      reserveDailyQuota: async () => gate,
    }),
  });
  assert.equal(performance.now() - started < 500, true);
  assert.equal(store.current().aiCompletion.status, 'failed');
  assert.equal(store.current().aiCompletion.errorCode, 'ai_timeout');

  release(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.current().translation, null);
  assert.equal(store.current().aiCompletion.status, 'failed');
});

test('assistant configuration failures also settle pending completion safely', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  await runLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({
      getAIAssistantConfig: async () => { throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE'); },
    }),
  });
  assert.equal(store.current().aiCompletion.status, 'failed');
  assert.equal(store.current().aiCompletion.errorCode, 'configuration_unavailable');
});

test('cleared or replaced completion state supersedes a stale AI task', async () => {
  const store = createMemoryLyricStore(makeReadyArtifact({ aiCompletion: null }));
  let aiCalls = 0;
  const result = await runLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({ askAI: async () => { aiCalls += 1; } }),
  });
  assert.equal(result.state, 'superseded');
  assert.equal(aiCalls, 0);
  assert.equal(store.calls.put, 0);
});

test('manual recompletion retains old translation while marking a new pending task', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const previous = {
    source: 'kugou',
    originalTextHash: 'a'.repeat(64),
    lines: ['旧译文'],
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
  const store = createMemoryLyricStore(makeReadyArtifact({ translation: previous }));
  const started = await beginLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    force: true,
    deps: successDeps({ askAI: async () => { await gate; return { translations: [{ unitId: 0, text: '新译文' }] }; } }),
  });
  assert.equal(started.state, 'started');
  assert.deepEqual(store.current().translation, previous);
  assert.equal(store.current().aiCompletion.status, 'pending');
  release();
  await started.task;
  assert.deepEqual(store.current().translation.lines, ['新译文']);
});

test('fresh pending completion is idempotent even when force is requested', async () => {
  const store = createMemoryLyricStore(pendingArtifact());
  let aiCalls = 0;
  const started = await beginLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    force: true,
    deps: successDeps({
      now: () => Date.parse('2026-09-10T00:00:20.000Z'),
      askAI: async () => { aiCalls += 1; return { translations: [] }; },
    }),
  });
  assert.equal(started.state, 'pending');
  assert.equal(started.task, null);
  assert.equal(store.calls.put, 0);
  assert.equal(aiCalls, 0);
});

test('stale pending completion can restart with a fresh task timestamp', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = createMemoryLyricStore(pendingArtifact());
  const restartedAt = Date.parse('2026-09-10T00:00:31.000Z');
  const started = await beginLyricAssetAiCompletion({
    env: {},
    db: {},
    song: makeSong(),
    store,
    force: true,
    deps: successDeps({
      now: () => restartedAt,
      askAI: async () => { await gate; return { translations: [{ unitId: 0, text: '新译文' }] }; },
    }),
  });
  assert.equal(started.state, 'started');
  assert.equal(store.current().aiCompletion.updatedAt, '2026-09-10T00:00:31.000Z');
  release();
  await started.task;
  assert.deepEqual(store.current().translation.lines, ['新译文']);
});

test('a concurrent fresh-pending winner is returned as an idempotent result', async () => {
  const initial = makeReadyArtifact();
  const winner = pendingArtifact({
    aiCompletion: { status: 'pending', updatedAt: '2026-09-10T00:00:10.000Z' },
  });
  let reads = 0;
  const store = {
    async get() {
      reads += 1;
      return reads === 1
        ? { state: 'found', artifact: structuredClone(initial), etag: 'etag-1' }
        : { state: 'found', artifact: structuredClone(winner), etag: 'etag-2' };
    },
    async putIfMatch() { return { state: 'conflict', artifact: null, etag: null }; },
  };
  const started = await beginLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store, force: true,
    deps: successDeps({ now: () => Date.parse('2026-09-10T00:00:20.000Z') }),
  });
  assert.equal(started.state, 'pending');
  assert.equal(started.etag, 'etag-2');
  assert.equal(started.task, null);
});

test('a first-batch notNeeded result is retried after another batch proves translation is needed', async () => {
  const store = createMemoryLyricStore(multiBatchPendingArtifact(121));
  let calls = 0;
  const prompts = [];
  const result = await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({
      askAI: async (messages) => {
        calls += 1;
        prompts.push(messages[0].content);
        return calls === 1 ? { notNeeded: true } : translatedBatch(messages);
      },
    }),
  });

  assert.equal(result.state, 'updated');
  assert.equal(calls, 3);
  assert.match(prompts[2], /不得返回 notNeeded/u);
  assert.equal(store.current().translation.lines.length, 121);
  assert.equal(store.current().translation.lines.every(Boolean), true);
  assert.equal(store.current().translation.lines[0], '译文0');
});

test('a middle-batch notNeeded result cannot create a partial translation artifact', async () => {
  const store = createMemoryLyricStore(multiBatchPendingArtifact(241));
  let calls = 0;
  const result = await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({
      askAI: async (messages) => {
        calls += 1;
        return calls === 2 ? { notNeeded: true } : translatedBatch(messages);
      },
    }),
  });

  assert.equal(result.state, 'updated');
  assert.equal(calls, 4);
  assert.equal(store.current().translation.lines.length, 241);
  assert.equal(store.current().translation.lines.every(Boolean), true);
  assert.equal(store.current().translation.lines[120], '译文120');
});

test('all notNeeded batches clear pending without creating a translation', async () => {
  const store = createMemoryLyricStore(multiBatchPendingArtifact(121));
  let calls = 0;
  const result = await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({ askAI: async () => { calls += 1; return { notNeeded: true }; } }),
  });

  assert.equal(result.state, 'updated');
  assert.equal(calls, 2);
  assert.equal(store.current().translation, null);
  assert.equal(store.current().aiCompletion.status, 'completed');
});

test('an unresolved mixed batch fails safely instead of writing incomplete translation lines', async () => {
  const store = createMemoryLyricStore(multiBatchPendingArtifact(121));
  let calls = 0;
  await runLyricAssetAiCompletion({
    env: {}, db: {}, song: makeSong(), store,
    startedAt: STARTED_AT,
    textHash: 'a'.repeat(64),
    deps: successDeps({
      askAI: async (messages) => {
        calls += 1;
        return calls === 2 ? translatedBatch(messages) : { notNeeded: true };
      },
    }),
  });

  assert.equal(calls, 3);
  assert.equal(store.current().translation, null);
  assert.equal(store.current().aiCompletion.status, 'failed');
  assert.equal(store.current().aiCompletion.errorCode, 'invalid_output');
});
