import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './localAssistant.fixture.js';
import { createAssistantCheckpoint } from '../services/assistantCheckpoint.js';
import { chatAI } from '../services/ai.js';
import { handleLocalAssistantRoute } from './localAssistant.js';

const body = (revision = 0, id = 'resume-1') => ({ revision, client_message_id: id,
  message: '继续整理', enable_thinking: true, context: {} });
const events = async response => (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
const thread = async route => (await (await route('/api/ai/thread', 'GET')).json()).thread;

const nativeStreams = {
  chat_completions: [{ choices: [{ delta: { reasoning_content: '原生推理', tool_calls: [{ index: 0, id: 'native1',
    function: { name: 'current_time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }],
  responses: [{ type: 'response.completed', response: { status: 'completed', output: [
    { type: 'reasoning', id: 'reason1', encrypted_content: 'opaque-cipher', summary: [] },
    { type: 'function_call', id: 'item1', call_id: 'native1', name: 'current_time', arguments: '{}', status: 'completed' }] } }],
  anthropic_messages: [{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '原生推理', signature: 'signed-opaque' } },
    { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1,
      content_block: { type: 'tool_use', id: 'native1', name: 'current_time', input: {} } },
    { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
  gemini_native: [{ candidates: [{ content: { parts: [{ functionCall: { id: 'native1', name: 'current_time', args: {} },
    thoughtSignature: 'signed-opaque' }] }, finishReason: 'STOP' }] }],
};
for (const [protocol, chunks] of Object.entries(nativeStreams)) {
  test(`${protocol} restores complete native reasoning and successful tool results across HTTP requests`, async t => {
    const { sqlite, route } = fixture();
    let calls = 0;
    let resumedPayload;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      calls++;
      if (calls === 3) resumedPayload = JSON.stringify(JSON.parse(init.body));
      const output = calls === 1 ? chunks : calls === 2 ? [{ error: { message: 'fixture' }, type: 'error' }]
        : protocol === 'chat_completions' ? [{ choices: [{ delta: { content: '续接完成' }, finish_reason: 'stop' }] }]
          : protocol === 'responses' ? [{ type: 'response.completed', response: { status: 'completed', output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '续接完成' }] }] } }]
            : protocol === 'anthropic_messages' ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '续接完成' } },
              { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]
              : [{ candidates: [{ content: { parts: [{ text: '续接完成' }] }, finishReason: 'STOP' }] }];
      return new Response(output.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''));
    });
    const chat = (messages, tools, config, env, options) => chatAI(messages, tools,
      { ...config, source: 'custom', protocol, model: 'fixture' }, { ...env,
        AI_PROFILE_API_KEY: 'fixture-key', AI_PROFILE_BASE_URL: 'https://models.example/v1' }, options);
    try {
      await events(await route('/api/ai/chat', 'POST', body(), 'account-A', { chat }));
      const saved = await thread(route);
      await events(await route('/api/ai/chat', 'POST', body(saved.revision, 'next'), 'account-A', { chat }));
      assert.match(resumedPayload, protocol === 'responses' ? /opaque-cipher/ : protocol === 'chat_completions' ? /原生推理/ : /signed-opaque/);
      assert.match(resumedPayload, /native1/);
      assert.match(resumedPayload, /function_call_output|tool_result|functionResponse|tool_call_id/);
      assert.equal((await thread(route)).messages.at(-1).content, '续接完成');
    } finally { sqlite.close(); }
  });
}

test('partial answer, progress and full native tool result survive a failure and a new request without ISO body prefixes', async () => {
  const { sqlite, route } = fixture();
  try {
    let round = 0;
    const nativeContext = { protocol: 'chat_completions', payload: { role: 'assistant', content: null,
      reasoning_content: 'native-reasoning', tool_calls: [{ id: 'time-1', type: 'function',
        function: { name: 'current_time', arguments: '{}' } }] } };
    await events(await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async (_messages, _tools, _config, _env, callbacks) => {
        assert.equal(callbacks.timeoutPolicy, 'idle');
        assert.equal(callbacks.timeoutMs, undefined);
        if (round++ === 0) return { type: 'function_calls', nativeContext,
          functionCalls: [{ id: 'time-1', name: 'current_time', args: {} }] };
        callbacks.onThoughtDelta('根据工具结果整理');
        callbacks.onContentDelta('已经确认了时间，');
        throw new Error('AI_STREAM_IDLE_TIMEOUT');
      },
    }));
    const saved = await thread(route);
    const failed = saved.messages.at(-1);
    assert.equal(failed.partialContent, '已经确认了时间，');
    assert.equal(failed.thought, '根据工具结果整理');
    assert.equal(failed.savedContext, undefined);
    assert.equal(JSON.stringify(saved).includes('native-reasoning'), false);
    let prompt;
    await events(await route('/api/ai/chat', 'POST', body(saved.revision, 'resume-2'), 'account-A', {
      chat: async messages => { prompt = messages; return { type: 'content', content: '继续完成了。' }; },
    }));
    assert.deepEqual(prompt.find(message => message.nativeContext)?.nativeContext, nativeContext);
    assert.match(prompt.find(message => message.role === 'tool').content, /时间|time|2026/);
    assert.match(prompt.find(message => message.content.includes('[系统失败记录')).content, /已经确认了时间，/);
    assert.ok(prompt.filter(message => message.role !== 'system').every(message => !/^\[\d{4}-\d{2}/.test(message.content)));
    assert.match(prompt[0].content, /历史时间元数据/);
  } finally { sqlite.close(); }
});

test('changing a legacy provider endpoint drops private native blocks but preserves actual tool results', async () => {
  const { sqlite, db, request, session } = fixture();
  const routeWithEndpoint = (endpoint, message, chat) => handleLocalAssistantRoute(
    request('/api/ai/chat', 'POST', message), new URL('https://flare.test/api/ai/chat'), db, {}, session('account-A'),
    { DEEPSEEK_API_KEY: 'test-secret', DEEPSEEK_BASE_URL: endpoint }, { chat });
  try {
    let round = 0;
    await events(await routeWithEndpoint('https://old-model.example/v1', body(), async () => {
      if (round++ === 0) return { type: 'function_calls',
        nativeContext: { protocol: 'chat_completions', payload: { role: 'assistant', content: null,
          reasoning_content: 'private-old-endpoint', tool_calls: [{ id: 'endpoint-time', type: 'function',
            function: { name: 'current_time', arguments: '{}' } }] } },
        functionCalls: [{ id: 'endpoint-time', name: 'current_time', args: {} }] };
      throw new Error('AI_STREAM_IDLE_TIMEOUT');
    }));
    const revision = sqlite.prepare('SELECT revision FROM music_chat_threads WHERE account_id = ?').get('account-A').revision;
    let resumed;
    await events(await routeWithEndpoint('https://new-model.example/v1', body(revision, 'endpoint-next'), async messages => {
      resumed = messages; return { type: 'content', content: '续接完成' };
    }));
    assert.equal(resumed.some(message => message.nativeContext), false);
    assert.equal(JSON.stringify(resumed).includes('private-old-endpoint'), false);
    assert.ok(resumed.some(message => message.role === 'tool' && message.tool_call_id === 'endpoint-time'));
  } finally { sqlite.close(); }
});

test('explicit stop saves partial output, aborts upstream and is account-scoped and idempotent', async () => {
  const { sqlite, route } = fixture();
  try {
    let signal;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async (_m, _t, _c, _e, callbacks) => {
        signal = callbacks.signal;
        callbacks.onContentDelta('保留这部分');
        entered();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('AI_STREAM_CANCELLED')), { once: true }));
      },
    });
    await started;
    const stopBody = { client_message_id: 'resume-1' };
    assert.equal((await route('/api/ai/stop', 'POST', stopBody, 'account-B')).status, 404);
    const stopped = await (await route('/api/ai/stop', 'POST', stopBody)).json();
    assert.equal(signal.aborted, true);
    assert.equal(stopped.thread.messages.at(-1).partialContent, '保留这部分');
    assert.equal(stopped.thread.messages.at(-1).errorCode, 'request_cancelled');
    const again = await (await route('/api/ai/stop', 'POST', stopBody)).json();
    assert.equal(again.thread.messages.length, 2);
    await response.body.cancel();
  } finally { sqlite.close(); }
});

test('stale recovery preserves persisted crash checkpoint while active heartbeat keeps a long task running', async t => {
  const { sqlite, db, route } = fixture();
  try {
    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000000 });
    sqlite.exec(`INSERT INTO music_chat_threads VALUES ('account-A',1,2,1,1);
      INSERT INTO music_chat_turns (id,account_id,client_message_id,base_revision,reserved_revision,assistant_id,status,created_at,updated_at)
      VALUES ('turn-crash','account-A','crash',0,1,'xiaoa','running',1,1000000);
      INSERT INTO music_chat_thread_messages (id,account_id,sequence,role,content,turn_id,created_at)
      VALUES ('msg-crash','account-A',1,'user','任务','turn-crash',1);`);
    const checkpoint = createAssistantCheckpoint(db, 'account-A', 'turn-crash', 1);
    checkpoint.update({ partialContent: '已保存的正文', thought: '已保存的思考' });
    await checkpoint.flush();
    t.mock.timers.tick(180000);
    await checkpoint.flush();
    assert.equal((await thread(route)).messages.length, 1);
    assert.equal(sqlite.prepare('SELECT status FROM music_chat_turns').get().status, 'running');
    await checkpoint.close(); // Simulate the process losing its heartbeat after this point.
    t.mock.timers.tick(120001);
    const recovered = await thread(route);
    assert.equal(recovered.messages.at(-1).partialContent, '已保存的正文');
    assert.equal(recovered.messages.at(-1).thought, '已保存的思考');
    assert.equal(recovered.revision, 2);
  } finally { t.mock.timers.reset(); sqlite.close(); }
});

test('continue does not repeat a completed mutation when argument keys are reordered', async () => {
  const { sqlite, route } = fixture();
  try {
    let round = 0;
    await events(await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async () => { if (round++ === 0) return { type: 'function_calls', functionCalls: [{ id: 'create1', name: 'manage_playlist',
        args: { action: 'create', name: '续接去重' } }] }; throw new Error('AI_STREAM_IDLE_TIMEOUT'); },
    }));
    const saved = await thread(route);
    let continueRound = 0;
    await events(await route('/api/ai/chat', 'POST', { ...body(saved.revision, 'continue-mid'), continue_turn_id: saved.messages.at(-1).turnId }, 'account-A', {
      chat: async () => { if (continueRound++ === 0) return { type: 'function_calls', functionCalls: [{ id: 'time-mid', name: 'current_time', args: {} }] };
        throw new Error('AI_STREAM_IDLE_TIMEOUT'); },
    }));
    const savedAgain = await thread(route);
    round = 0;
    await events(await route('/api/ai/chat', 'POST', { ...body(savedAgain.revision, 'continue-dedup'), continue_turn_id: savedAgain.messages.at(-1).turnId }, 'account-A', {
      chat: async messages => round++ === 0 ? { type: 'function_calls', functionCalls: [{ id: 'create2', name: 'manage_playlist',
        args: { name: '续接去重', action: 'create' } }] } : { type: 'content', content: messages.at(-1).content },
    }));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE name='续接去重'").get().count, 1);
    assert.match((await thread(route)).messages.at(-1).content, /未重复执行/);
  } finally { sqlite.close(); }
});

test('stop during an asynchronous tool read prevents the later memory DELETE transaction', async () => {
  const { sqlite, db, route } = fixture();
  const { saveAssistantMemory } = await import('../services/assistantMemory.js');
  try {
    await route('/api/ai/memory', 'PATCH', { enabled: true });
    const record = await saveAssistantMemory(db, 'account-A', { content: '保留到停止后', source: 'stated', actor: 'assistant' });
    const originalPrepare = db.prepare.bind(db);
    let release, reached;
    const pause = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    let reads = 0;
    db.prepare = sql => { const statement = originalPrepare(sql);
      if (sql.includes('SELECT enabled FROM assistant_memory_settings')) {
        const originalFirst = statement.first.bind(statement);
        statement.first = async () => { if (++reads === 2) { reached(); await pause; } return originalFirst(); };
      }
      return statement;
    };
    const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async () => ({ type: 'function_calls', functionCalls: [{ id: 'delete-paused', name: 'remember_user', args: { action: 'delete', id: record.memory.id } }] }),
    });
    await entered;
    await route('/api/ai/stop', 'POST', { client_message_id: 'resume-1' });
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(sqlite.prepare('SELECT id FROM assistant_memories WHERE id=?').get(record.memory.id));
    await response.body.cancel();
  } finally { sqlite.close(); }
});

test('a request already aborted during preparation never starts a model or tool mutation', async () => {
  const { sqlite, db, session } = fixture();
  try {
    const controller = new AbortController();
    const request = new Request('https://flare.test/api/ai/chat', { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
    controller.abort();
    let modelCalls = 0;
    const response = await handleLocalAssistantRoute(request, new URL(request.url), db, {}, session('account-A'),
      { DEEPSEEK_API_KEY: 'fixture-key' }, { chat: async () => { modelCalls++; return { type: 'function_calls', functionCalls: [
        { id: 'create-aborted', name: 'manage_playlist', args: { action: 'create', name: '不能创建' } }] }; } });
    await response.text();
    assert.equal(modelCalls, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE name='不能创建'").get().count, 0);
    assert.equal((await thread(async (...args) => {
      const req = new Request('https://flare.test/api/ai/thread');
      return handleLocalAssistantRoute(req, new URL(req.url), db, {}, session('account-A'), {});
    })).messages.at(-1).errorCode, 'request_cancelled');
  } finally { sqlite.close(); }
});

test('waiting for playlist confirmation remains resumable and is never labelled as an already completed deletion', async () => {
  const { sqlite, route } = fixture();
  try {
    let round = 0;
    await events(await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async () => round++ === 0 ? { type: 'function_calls', functionCalls: [{ id: 'create-confirm', name: 'manage_playlist',
        args: { action: 'create', name: '保留确认' } }] } : { type: 'content', content: '已创建。' },
    }));
    const id = sqlite.prepare("SELECT id FROM Member_Playlists WHERE name='保留确认'").get().id;
    const created = await thread(route);
    round = 0;
    await events(await route('/api/ai/chat', 'POST', body(created.revision, 'delete-confirm'), 'account-A', {
      chat: async () => { if (round++ === 0) return { type: 'function_calls', functionCalls: [{ id: 'waiting1', name: 'manage_playlist',
        args: { action: 'delete', playlist_id: id } }] }; throw new Error('AI_STREAM_IDLE_TIMEOUT'); },
    }));
    const failed = await thread(route);
    round = 0;
    const resumed = await events(await route('/api/ai/chat', 'POST', { ...body(failed.revision, 'resume-confirm'), continue_turn_id: failed.messages.at(-1).turnId }, 'account-A', {
      chat: async () => round++ === 0 ? { type: 'function_calls', functionCalls: [{ id: 'waiting2', name: 'manage_playlist',
        args: { action: 'delete', playlist_id: id } }] } : { type: 'content', content: '请确认。' },
    }));
    const result = resumed.find(event => event.type === 'tool_result');
    assert.equal(result.data.ok, false);
    assert.equal(result.data.error, 'CONFIRMATION_REQUIRED');
    assert.equal(result.data.confirmation.playlistId, id);
    assert.ok(sqlite.prepare('SELECT id FROM Member_Playlists WHERE id=?').get(id));
  } finally { sqlite.close(); }
});
