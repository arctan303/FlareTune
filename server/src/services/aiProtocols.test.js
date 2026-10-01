import test from 'node:test';
import assert from 'node:assert/strict';
import { askAI, chatAI } from './ai.js';
import { buildResponsesInput } from './aiResponses.js';
import { buildAnthropicMessages } from './aiAnthropic.js';
import { buildGeminiContents, geminiGenerationConfig } from './aiGemini.js';
import { createJsonEventStreamParser } from './aiJsonEventStream.js';

const tool = { type: 'function', function: { name: 'current_time', description: 'Get time', parameters: { type: 'object', properties: {} } } };
const messages = [{ role: 'system', content: 'Return JSON when requested.' }, { role: 'user', content: '你好' }];
const config = (protocol, extra = {}) => ({ provider: 'openai', source: 'custom', protocol, model: 'my-model', ...extra });
const env = { AI_PROFILE_API_KEY: 'fixture-private-key', AI_PROFILE_BASE_URL: 'https://proxy.example/v1' };
const sse = (events) => events.map((event) => typeof event === 'string' ? `data: ${event}\n\n`
  : `event: ${event.type || 'chunk'}\ndata:${JSON.stringify(event)}\n\n`).join('');
function stream(events, fragment = 7) {
  const bytes = new TextEncoder().encode(sse(events));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment));
    controller.close();
  } }));
}
const messageItem = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好世界' }] };
const textStreams = {
  chat_completions: [{ choices: [{ delta: { content: '你好世界' } }] }, '[DONE]'],
  responses: [{ type: 'response.output_text.delta', delta: '你好世界' }, { type: 'response.completed', response: { status: 'completed', output: [messageItem] } }],
  anthropic_messages: [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好世界' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
  gemini_native: [{ candidates: [{ content: { parts: [{ text: '你好世界' }] }, finishReason: 'STOP' }] }],
};
for (const [protocol, events] of Object.entries(textStreams)) {
  test(`${protocol} streams UTF-8 fragments and uses its explicit endpoint/authentication`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const endpoint = { chat_completions: '/chat/completions', responses: '/responses', anthropic_messages: '/messages',
        gemini_native: '/models/my-model:streamGenerateContent?alt=sse' }[protocol];
      assert.equal(url, `${env.AI_PROFILE_BASE_URL}${endpoint}`);
      assert.equal(init.redirect, 'manual');
      assert.ok(Object.values(init.headers).includes(env.AI_PROFILE_API_KEY)
        || init.headers.Authorization === `Bearer ${env.AI_PROFILE_API_KEY}`);
      assert.ok(!url.includes(env.AI_PROFILE_API_KEY));
      return stream(events);
    });
    const deltas = [];
    const result = await chatAI(messages, [], config(protocol), env, { onContentDelta: (text) => deltas.push(text) });
    assert.equal(result.content, '你好世界');
    assert.equal(deltas.join(''), result.content);
    assert.equal(result.type, 'content');
  });
  test(`${protocol} rejects EOF, truncation and upstream error without returning tools`, async (t) => {
    const cases = {
      chat_completions: [[{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'current_time', arguments: '{}' } }] } }] }],
        [{ choices: [{ finish_reason: 'length' }] }], [{ error: { message: 'failure' } }]],
      responses: [[{ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'current_time', arguments: '{}' } }],
        [{ type: 'response.incomplete', response: { status: 'incomplete' } }], [{ type: 'error' }]],
      anthropic_messages: [[{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'current_time', input: {} } }],
        [{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }], [{ type: 'error' }]],
      gemini_native: [[{ candidates: [{ content: { parts: [{ functionCall: { id: 'call_1', name: 'current_time', args: {} } }] } }] }],
        [{ candidates: [{ finishReason: 'MAX_TOKENS' }] }], [{ error: { message: 'failure' } }]],
    }[protocol];
    let current;
    t.mock.method(globalThis, 'fetch', async () => stream(current));
    for (const eventsForCase of cases) {
      current = eventsForCase;
      await assert.rejects(chatAI(messages, [tool], config(protocol), env), /AI_/);
    }
  });
}

test('Responses preserves ordered reasoning/function items and uses call_id for parallel results', async (t) => {
  const native = [{ type: 'reasoning', id: 'rs1', encrypted_content: 'opaque', summary: [] },
    ...['call_1', 'call_2'].map((id) => ({ type: 'function_call', id: `item_${id}`, call_id: id,
      status: 'completed', name: 'current_time', arguments: '{}' }))];
  const thoughts = [];
  let round = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.tools[0].name, 'current_time');
    assert.equal(body.tools[0].strict, false);
    assert.equal(body.tools[0].function, undefined);
    if (round++ === 0) return stream([{ type: 'response.reasoning_text.delta', delta: '检查时间' },
      { type: 'response.completed', response: { status: 'completed', output: native } }]);
    assert.deepEqual(body.input.slice(2, 5), native);
    assert.deepEqual(body.input.slice(5).map(({ type, call_id }) => ({ type, call_id })),
      ['call_1', 'call_2'].map((id) => ({ type: 'function_call_output', call_id: id })));
    return stream(textStreams.responses);
  });
  const first = await chatAI(messages, [tool], config('responses'), env, { onThoughtDelta: (text) => thoughts.push(text) });
  assert.equal(first.functionCalls.length, 2);
  assert.deepEqual(thoughts, ['检查时间']);
  const second = await chatAI([...messages, { role: 'assistant', content: '', nativeContext: first.nativeContext },
    ...first.functionCalls.map((call) => ({ role: 'tool', tool_call_id: call.id, name: call.name, content: '{"ok":true}' }))],
  [tool], config('responses'), env);
  assert.equal(second.content, '你好世界');
});

test('Anthropic preserves thinking signature and assembles fragmented parallel tool inputs/results', async (t) => {
  const events = [{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '检查' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig1' } }, { type: 'content_block_stop', index: 0 }];
  for (const index of [1, 2]) events.push({ type: 'content_block_start', index,
    content_block: { type: 'tool_use', id: `call_${index}`, name: 'current_time', input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{' } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '}' } }, { type: 'content_block_stop', index });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' });
  let round = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].input_schema.type, 'object');
    assert.equal(body.tools[0].function, undefined);
    if (round++ === 0) return stream(events);
    assert.equal(body.messages[1].content[0].signature, 'sig1');
    assert.deepEqual(body.messages[1].content[0], { type: 'thinking', thinking: '检查', signature: 'sig1' });
    assert.equal(body.messages[2].content.length, 2);
    assert.deepEqual(body.messages[2].content.map((block) => block.tool_use_id), ['call_1', 'call_2']);
    return stream(textStreams.anthropic_messages);
  });
  const first = await chatAI(messages, [tool], config('anthropic_messages', { enableThinking: true }), env);
  assert.deepEqual(first.functionCalls.map((call) => call.args), [{}, {}]);
  const second = await chatAI([...messages, { role: 'assistant', content: '', nativeContext: first.nativeContext },
    ...first.functionCalls.map((call) => ({ role: 'tool', tool_call_id: call.id, name: call.name, content: 'ok' }))],
  [tool], config('anthropic_messages', { enableThinking: true }), env);
  assert.equal(second.content, '你好世界');
});

test('all four protocols support nonstream lyric JSON requests and generation limits', async (t) => {
  const text = '{"notNeeded":true}';
  const responses = { chat_completions: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
    responses: { status: 'completed', output: [{ ...messageItem, content: [{ type: 'output_text', text }] }] },
    anthropic_messages: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
    gemini_native: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text, thought: false }] } }] } };
  let protocol;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(!body.stream);
    assert.equal(body.max_completion_tokens || body.max_output_tokens || body.max_tokens || body.generationConfig?.maxOutputTokens, 8192);
    if (protocol === 'responses') assert.deepEqual(body.text.format, { type: 'json_object' });
    return Response.json(responses[protocol]);
  });
  for (protocol of Object.keys(responses)) assert.equal(await askAI(messages,
    config(protocol, { enableThinking: false, generationOptions: { maxOutputTokens: 8192 } }), env), text);
});

test('multimodal arrays remain real image blocks rather than JSON text', () => {
  const content = [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }];
  assert.equal(buildResponsesInput([{ role: 'user', content }])[0].content[1].type, 'input_image');
  assert.deepEqual(buildAnthropicMessages([{ role: 'user', content }])[0].content[1].source,
    { type: 'base64', media_type: 'image/png', data: 'AA==' });
  assert.deepEqual(buildGeminiContents([{ role: 'user', content }])[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AA==' } });
});

test('Gemini preserves full native parts across tools and does not display thought as reply', () => {
  const native = { protocol: 'gemini_native', payload: { role: 'model', parts: [
    { text: 'thinking', thought: true, thoughtSignature: 'text-sig' },
    { functionCall: { id: 'call_1', name: 'current_time', args: {} }, thoughtSignature: 'call-sig' }] } };
  assert.deepEqual(buildGeminiContents([{ role: 'assistant', content: '', nativeContext: native }])[0], native.payload);
  assert.deepEqual(geminiGenerationConfig({ model: 'gemini-3.1-pro', enableThinking: false }).thinkingConfig, { thinkingLevel: 'low' });
  assert.deepEqual(geminiGenerationConfig({ model: 'gemini-2.5-pro', enableThinking: false }).thinkingConfig, { thinkingBudget: 128 });
});

test('SSE parser supports multi-line data, CRLF, comments and final data without newline', async () => {
  const values = [];
  const parser = createJsonEventStreamParser((raw, type) => { values.push({ json: JSON.parse(raw), type }); });
  await parser.push(new TextEncoder().encode(':ping\r\nevent: test\r\ndata: {"x":\r\ndata: 1}\r\n\r\ndata:{"tail":2}'));
  await parser.flushJsonTail();
  assert.deepEqual(values, [{ json: { x: 1 }, type: 'test' }, { json: { tail: 2 }, type: '' }]);
});

test('unknown protocol and private endpoints fail before any outgoing request', async (t) => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; });
  for (const protocol of ['toString', 'interactions', 'unknown']) await assert.rejects(chatAI(messages, [], config(protocol), env));
  for (const baseUrl of ['https://10.0.0.1/v1', 'https://127.1/v1', 'https://[::1]/v1', 'https://user:pass@proxy.example/v1']) {
    await assert.rejects(chatAI(messages, [], config('responses'), { ...env, AI_PROFILE_BASE_URL: baseUrl }));
  }
  assert.equal(fetched, false);
});

test('OpenAI Responses opts into reasoning summaries and encrypted continuation only for OpenAI', async (t) => {
  const summary = '准备检索曲库';
  let expectedSource;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (expectedSource === 'openai') {
      assert.deepEqual(body.reasoning, { effort: 'medium', summary: 'auto' });
      assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    } else {
      assert.deepEqual(body.reasoning, { effort: 'medium' });
      assert.equal(body.include, undefined);
    }
    return stream([{ type: 'response.reasoning_summary_text.delta', delta: summary }, ...textStreams.responses]);
  });
  for (expectedSource of ['openai', 'deepseek']) {
    const thoughts = [];
    await chatAI(messages, [], config('responses', { source: expectedSource, model: 'gpt-5', enableThinking: true }),
      env, { onThoughtDelta: (text) => thoughts.push(text) });
    assert.deepEqual(thoughts, [summary]);
  }
});

test('invalid protocol reasoning enums are rejected before sending credentials', async (t) => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; });
  for (const protocol of ['gemini_native', 'anthropic_messages']) await assert.rejects(chatAI(messages, [],
    config(protocol, { generationOptions: { reasoningEffort: 'xhigh' }, enableThinking: true }), env), /AI_OPTIONS_INVALID/);
  assert.equal(fetched, false);
});
