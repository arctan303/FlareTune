import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  askAI,
  buildGeminiContents,
  chatAI,
  getAIAssistantConfig,
  getPublicAiErrorCode,
  parseGeminiCandidateParts,
  readStreamChunkWithIdleTimeout,
} from './ai.js';

test('assigned DeepSeek profile preserves its explicit model ID in outbound chat', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const models = [];
  globalThis.fetch = async (url, init) => {
    models.push(JSON.parse(init.body).model);
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  await chatAI([{ role: 'user', content: 'hello' }], [],
    { provider: 'deepseek', model: 'deepseek-chat', exactModel: true },
    { DEEPSEEK_API_KEY: 'test-key' });
  await chatAI([{ role: 'user', content: 'hello' }], [],
    { provider: 'deepseek', model: 'deepseek-chat' },
    { DEEPSEEK_API_KEY: 'test-key' });
  assert.deepEqual(models, ['deepseek-chat', 'deepseek-flash']);
});

test('Gemini lyric request schema carries language and cleanup fields', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let payload;
  globalThis.fetch = async (url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ candidates: [{ content: { parts: [{ text:
      '{"notNeeded":true,"songLanguage":"en","discardLineIndices":[0]}' }] } }] });
  };
  const result = await askAI([{ role: 'system', content: 'Return JSON songLanguage and discardLineIndices' },
    { role: 'user', content: 'lyrics text' }],
  { provider: 'gemini', model: 'gemini-test' }, { GEMINI_API_KEY: 'test-key' });
  assert.match(result, /songLanguage/);
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.equal(payload.generationConfig.responseSchema.properties.songLanguage.type, 'STRING');
  assert.equal(payload.generationConfig.responseSchema.properties.discardLineIndices.items.type, 'INTEGER');
  await askAI([{ role: 'system', content: 'Return JSON translations for each unitId' },
    { role: 'user', content: '{"units":[{"unitId":0,"text":"hello"}]}' }],
  { provider: 'gemini', model: 'gemini-test' }, { GEMINI_API_KEY: 'test-key' });
  assert.equal('songLanguage' in payload.generationConfig.responseSchema.properties, false);
  assert.equal('discardLineIndices' in payload.generationConfig.responseSchema.properties, false);
});

test('nonstream DeepSeek requests pass an explicit thinking preference', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: '{"notNeeded":true}' } }] });
  };
  const messages = [{ role: 'system', content: 'Return JSON' }, { role: 'user', content: 'song' }];
  const env = { DEEPSEEK_API_KEY: 'test-key' };
  await askAI(messages, { provider: 'deepseek', model: 'deepseek-flash', enableThinking: false }, env);
  await askAI(messages, { provider: 'deepseek', model: 'deepseek-flash' }, env);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[1].thinking, undefined);
});

test('assistant config requires the current AI_Assistants row', async () => {
  const queries = [];
  let row = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    system_prompt: 'configured prompt',
    temperature: 0.4,
  };
  const db = {
    prepare(sql) {
      queries.push(sql);
      return {
        bind() { return this; },
        async first() { return row; },
      };
    },
  };

  assert.deepEqual(await getAIAssistantConfig(db, 'lyric_translator'), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    systemPrompt: 'configured prompt',
    temperature: 0.4,
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /FROM AI_Assistants/);
  assert.doesNotMatch(queries[0], /settings/i);

  row = null;
  await assert.rejects(() => getAIAssistantConfig(db, 'missing'), /AI_ASSISTANT_CONFIG_UNAVAILABLE/);
});

test('DeepSeek chat requires its own current API key instead of reusing OpenAI credentials', async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run without DEEPSEEK_API_KEY');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    chatAI(
      [{ role: 'user', content: 'hello' }],
      [],
      { provider: 'deepseek', model: 'deepseek-chat' },
      { OPENAI_API_KEY: 'not-a-deepseek-key' },
    ),
    /AI_MISSING_KEY/,
  );
  assert.equal(fetchCalls, 0);
});

test('provider adapters accept only the registered function tool DTO', () => {
  const gemini = readFileSync(new URL('./aiGemini.js', import.meta.url), 'utf8');
  const openAI = readFileSync(new URL('./aiOpenAICompatible.js', import.meta.url), 'utf8');
  for (const source of [gemini, openAI]) {
    assert.doesNotMatch(source, /tool\.function \|\| tool|fn\.input_schema/);
  }
  assert.doesNotMatch(gemini, /toolCall\.function \|\| toolCall/);
});

test('OpenAI-compatible malformed tool arguments remain invalid after streaming parse', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"message":{"tool_calls":[{"id":"call_bad","type":"function","function":{"name":"music_query","arguments":"{not-json"}}]}}]}\n\n',
      ));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200 });

  const result = await chatAI(
    [{ role: 'user', content: '找一首歌' }],
    [{ type: 'function', function: { name: 'music_query', description: '', parameters: { type: 'object' } } }],
    { provider: 'deepseek', model: 'deepseek-chat' },
    { DEEPSEEK_API_KEY: 'local-test-only' },
  );
  assert.equal(result.type, 'function_calls');
  assert.equal(result.functionCalls[0].name, 'music_query');
  assert.equal(result.functionCalls[0].args, '{not-json');
});

test('Gemini continuation groups parallel function responses into one user turn', () => {
  const contents = buildGeminiContents([
    { role: 'system', content: 'system rules' },
    { role: 'user', content: '整理歌单' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'one',
          thought_signature: 'signature-one',
          function: { name: 'manage_playlist', arguments: '{"action":"list"}' },
        },
        { id: 'two', function: { name: 'music_query', arguments: '{"action":"random","count":3}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'one', name: 'manage_playlist', content: '{"ok":true,"playlists":[]}' },
    { role: 'tool', tool_call_id: 'two', name: 'music_query', content: '{"songs":[{"id":"s1"}]}' },
    { role: 'assistant', content: '已完成。' },
  ]);

  assert.equal(contents.length, 4);
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts.length, 2);
  assert.equal(contents[1].parts[0].functionCall.id, 'one');
  assert.equal(contents[1].parts[0].thoughtSignature, 'signature-one');
  assert.equal(contents[2].role, 'user');
  assert.equal(contents[2].parts.length, 2);
  assert.equal(contents[2].parts[0].functionResponse.id, 'one');
  assert.deepEqual(
    contents[2].parts.map((part) => part.functionResponse.name),
    ['manage_playlist', 'music_query'],
  );
  assert.equal(contents[3].role, 'model');
});

test('Gemini continuation keeps non-JSON tool text as an explicit result object', () => {
  const contents = buildGeminiContents([
    { role: 'tool', tool_call_id: 'one', name: 'manage_playlist', content: 'temporary failure' },
  ]);
  assert.deepEqual(contents[0].parts[0].functionResponse.response, { result: 'temporary failure' });
});

test('Gemini function calls preserve the API id and thought signature for the next request', () => {
  const parsed = parseGeminiCandidateParts([
    {
      functionCall: { id: 'gemini-call-1', name: 'manage_playlist', args: { action: 'list' } },
      thoughtSignature: 'encrypted-signature',
    },
    { functionCall: { id: 'gemini-call-2', name: 'music_query', args: { action: 'random', count: 3 } } },
  ]);
  assert.equal(parsed.type, 'function_calls');
  assert.deepEqual(parsed.functionCalls, [
    {
      id: 'gemini-call-1',
      name: 'manage_playlist',
      args: { action: 'list' },
      thoughtSignature: 'encrypted-signature',
    },
    {
      id: 'gemini-call-2',
      name: 'music_query',
      args: { action: 'random', count: 3 },
      thoughtSignature: undefined,
    },
  ]);
});

test('Gemini no-id function calls stay stable in one response and differ across model responses', () => {
  const parts = [{ functionCall: { name: 'manage_playlist', args: { action: 'create', name: '夜航' } } }];
  const first = parseGeminiCandidateParts(parts, 'response-one');
  const second = parseGeminiCandidateParts(parts, 'response-two');

  assert.equal(first.functionCalls[0].id, 'call_gemini_response-one_0_manage_playlist');
  assert.equal(first.functionCalls[0].id, parseGeminiCandidateParts(parts, 'response-one').functionCalls[0].id);
  assert.notEqual(first.functionCalls[0].id, second.functionCalls[0].id);
});

test('Gemini chat stops on finishReason even when the upstream body stays open', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const events = [];
  const deltas = [];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]},"finishReason":"STOP"}]}\n\n',
      ));
    },
  }), { status: 200 });

  const result = await chatAI(
    [{ role: 'user', content: '你好' }],
    [],
    { provider: 'gemini', model: 'gemini-test' },
    { GEMINI_API_KEY: 'test-key' },
    {
      streamIdleTimeoutMs: 20,
      onContentDelta: (text) => deltas.push(text),
      onStreamEvent: (event) => events.push(event),
    },
  );

  assert.equal(result.content, '你好');
  assert.deepEqual(deltas, ['你好']);
  assert.deepEqual(events, [
    { type: 'first_chunk' },
    { type: 'finish_reason', finishReason: 'STOP' },
  ]);
});

test('Gemini stream idle timeout is stable and maps to a public error code', async () => {
  const reader = new ReadableStream({ start() {} }).getReader();
  await assert.rejects(
    readStreamChunkWithIdleTimeout(reader, 5),
    /AI_STREAM_IDLE_TIMEOUT/,
  );
  await reader.cancel();
  assert.equal(getPublicAiErrorCode(new Error('AI_STREAM_IDLE_TIMEOUT')), 'upstream_idle_timeout');
  assert.equal(getPublicAiErrorCode(new Error('AI_TIMEOUT')), 'upstream_timeout');
  assert.equal(getPublicAiErrorCode(new Error('unexpected')), 'upstream_failure');
});

test('Gemini chat cancels a stalled upstream stream after the idle threshold', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled = false;
  const events = [];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start() {},
    cancel() { cancelled = true; },
  }), { status: 200 });

  await assert.rejects(
    chatAI(
      [{ role: 'user', content: '你好' }],
      [],
      { provider: 'gemini', model: 'gemini-test' },
      { GEMINI_API_KEY: 'test-key' },
      { streamIdleTimeoutMs: 5, onStreamEvent: (event) => events.push(event) },
    ),
    /AI_STREAM_IDLE_TIMEOUT/,
  );
  assert.equal(cancelled, true);
  assert.deepEqual(events, [{ type: 'idle_timeout' }]);
});

test('Gemini streams thought deltas separately and sends thinkingBudget: 0 when thinking is disabled', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let capturedRequestBody = null;
  const thoughts = [];
  const contents = [];

  globalThis.fetch = async (url, init) => {
    capturedRequestBody = JSON.parse(init.body);
    return new Response(new ReadableStream({
      start(controller) {
        // 第一块：思考过程
        controller.enqueue(new TextEncoder().encode(
          'data: {"candidates":[{"content":{"parts":[{"text":"让我想想...","thought":true}]}}]}\n\n',
        ));
        // 第二块：正文输出
        controller.enqueue(new TextEncoder().encode(
          'data: {"candidates":[{"content":{"parts":[{"text":"推荐这首《晴天》。"}]},"finishReason":"STOP"}]}\n\n',
        ));
        controller.close();
      },
    }), { status: 200 });
  };

  const result = await chatAI(
    [{ role: 'user', content: '推荐首歌' }],
    [],
    { provider: 'gemini', model: 'gemini-test', enableThinking: true },
    { GEMINI_API_KEY: 'test-key' },
    {
      onThoughtDelta: (delta) => thoughts.push(delta),
      onContentDelta: (delta) => contents.push(delta),
    },
  );

  assert.equal(result.content, '推荐这首《晴天》。');
  assert.deepEqual(thoughts, ['让我想想...']);
  assert.deepEqual(contents, ['推荐这首《晴天》。']);
  assert.equal(capturedRequestBody.generationConfig.thinkingConfig, undefined);

  // 测试禁用思考时注入 thinkingBudget: 0
  await chatAI(
    [{ role: 'user', content: '快点回答' }],
    [],
    { provider: 'gemini', model: 'gemini-test', enableThinking: false },
    { GEMINI_API_KEY: 'test-key' },
  );
  assert.deepEqual(capturedRequestBody.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('OpenAI-compatible provider streams reasoning deltas via onThoughtDelta', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const thoughts = [];
  const contents = [];

  let capturedRequestBody = null;
  globalThis.fetch = async (url, init) => {
    capturedRequestBody = JSON.parse(init.body);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"reasoning_content":"深度推理中..."}}]}\n\n',
        ));
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"这是正式回复。"}}]}\n\n',
        ));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200 });
  };

  const result = await chatAI(
    [{ role: 'user', content: '你好' }],
    [],
    { provider: 'deepseek', model: 'deepseek-reasoner', enableThinking: true },
    { DEEPSEEK_API_KEY: 'test-key' },
    {
      onThoughtDelta: (delta) => thoughts.push(delta),
      onContentDelta: (delta) => contents.push(delta),
    },
  );

  assert.equal(result.content, '这是正式回复。');
  assert.deepEqual(thoughts, ['深度推理中...']);
  assert.deepEqual(contents, ['这是正式回复。']);
  assert.deepEqual(capturedRequestBody.thinking, { type: 'enabled' });
  assert.equal(capturedRequestBody.model, 'deepseek-flash');

  // 验证 enableThinking: false 注入 thinking: { type: 'disabled' }
  await chatAI(
    [{ role: 'user', content: '极速回复' }],
    [],
    { provider: 'deepseek', model: 'deepseek-reasoner', enableThinking: false },
    { DEEPSEEK_API_KEY: 'test-key' },
  );
  assert.deepEqual(capturedRequestBody.thinking, { type: 'disabled' });
});

test('DeepSeek tool continuation carries the provider reasoning into the next request', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const payloads = [];
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    const events = payloads.length === 1
      ? [
        { choices: [{ delta: { reasoning_content: '先读取歌单。' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-list',
          function: { name: 'my_playlists', arguments: '{}' } }] } }] },
      ]
      : [{ choices: [{ delta: { content: '找到了。' } }] }];
    return new Response(new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200 });
  };
  const config = { provider: 'deepseek', model: 'deepseek-chat', enableThinking: true };
  const env = { DEEPSEEK_API_KEY: 'test-key' };
  const first = await chatAI([{ role: 'user', content: '列出歌单' }], [
    { type: 'function', function: { name: 'my_playlists', description: '', parameters: { type: 'object' } } },
  ], config, env);
  assert.equal(first.type, 'function_calls');
  assert.equal(first.reasoningContent, '先读取歌单。');
  const second = await chatAI([{ role: 'user', content: '列出歌单' }, first.rawMessage,
    { role: 'tool', tool_call_id: 'call-list', content: '歌单列表' }], [], config, env);
  assert.equal(second.content, '找到了。');
  assert.equal(payloads[1].messages[1].reasoning_content, '先读取歌单。');
  assert.equal(payloads[1].messages[1].content, '');
});
