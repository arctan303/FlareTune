import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './localAssistant.fixture.js';

const body = (revision = 0, id = 'failed-1') => ({ revision, client_message_id: id,
  message: '测试记忆', enable_thinking: true, context: {} });
const events = async (response) => (await response.text()).trim().split('\n\n')
  .map((line) => JSON.parse(line.slice(6)));
const readThread = async (route, account = 'account-A') =>
  (await (await route('/api/ai/thread', 'GET', undefined, account)).json()).thread;

const memoryCall = (id, index = 0) => ({ id, name: 'remember_user',
  args: { content: `用户的测试偏好 ${index}`, source: 'stated' } });

for (const [label, calls, code, reason] of [
  ['oversized batch', Array.from({ length: 5 }, (_, i) => memoryCall(`memory-${i}`, i)),
    'tool_call_limit', /单次最多允许 4 个/],
  ['invalid ID', [memoryCall('invalid:identifier')], 'invalid_tool_call_id', /标识格式无效/],
  ['duplicate IDs', [memoryCall('same', 1), memoryCall('same', 2)],
    'duplicate_tool_call_id', /标识重复/],
]) {
  test(`${label} records the specific validation reason before any memory write`, async () => {
    const { sqlite, route } = fixture();
    try {
      await route('/api/ai/memory', 'PATCH', { enabled: true });
      const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
        chat: async () => ({ type: 'function_calls', functionCalls: calls }),
      });
      const failureEvent = (await events(response)).at(-1);
      assert.equal(failureEvent.error, code);
      assert.match(failureEvent.message, reason);
      const thread = await readThread(route);
      assert.equal(thread.messages.at(-1).errorCode, code);
      assert.match(thread.messages.at(-1).content, reason);
      assert.equal((await (await route('/api/ai/memory', 'GET')).json()).memories.length, 0);
      let prompt;
      await events(await route('/api/ai/chat', 'POST', body(thread.revision, 'next'), 'account-A', {
        chat: async (messages) => { prompt = messages; return { type: 'content', content: '未执行写入。' }; },
      }));
      assert.match(prompt.find((item) => item.content.includes('[系统失败记录')).content, reason);
    } finally { sqlite.close(); }
  });
}

test('four distinct memory calls execute and the model is told the existing batch limit', async () => {
  const { sqlite, route } = fixture();
  try {
    await route('/api/ai/memory', 'PATCH', { enabled: true });
    let round = 0;
    const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async (messages) => {
        assert.match(messages[0].content, /单次最多调用 4 个工具/);
        return round++ === 0 ? { type: 'function_calls',
          functionCalls: Array.from({ length: 4 }, (_, i) => memoryCall(`memory-${i}`, i)) }
          : { type: 'content', content: '四条已保存。' };
      },
    });
    assert.equal((await events(response)).at(-1).type, 'done');
    assert.equal((await (await route('/api/ai/memory', 'GET')).json()).memories.length, 4);
  } finally { sqlite.close(); }
});

test('a repeated ID in a later round stops without executing the mutation twice', async () => {
  const { sqlite, route } = fixture();
  try {
    await route('/api/ai/memory', 'PATCH', { enabled: true });
    let round = 0;
    const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async () => ({ type: 'function_calls', functionCalls: [memoryCall('same', round++)] }),
    });
    assert.equal((await events(response)).at(-1).error, 'duplicate_tool_call_id');
    assert.equal((await (await route('/api/ai/memory', 'GET')).json()).memories.length, 1);
    const failed = (await readThread(route)).messages.at(-1);
    assert.equal(failed.toolSummaries.length, 1);
    assert.equal(failed.toolSummaries[0].ok, true);
  } finally { sqlite.close(); }
});

test('failed continuation preserves actual thought and successful memory writes for UI and the next model turn', async () => {
  const { sqlite, route } = fixture();
  try {
    await route('/api/ai/memory', 'PATCH', { enabled: true });
    let calls = 0;
    const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async (_messages, _tools, _config, _env, callbacks) => {
        calls += 1;
        if (calls === 1) {
          callbacks.onThoughtDelta('准备记录用户提供的音乐偏好。');
          return { type: 'function_calls', functionCalls: [{ id: 'memory-1', name: 'remember_user',
            args: { content: '用户喜欢爵士乐', source: 'stated' } }] };
        }
        callbacks.onThoughtDelta('记忆已写入，继续整理回复。');
        throw new Error('AI_STREAM_IDLE_TIMEOUT secret-upstream-detail');
      },
    });
    assert.equal((await events(response)).at(-1).error, 'upstream_idle_timeout');
    const thread = await readThread(route);
    const failed = thread.messages.at(-1);
    assert.equal(failed.isError, true);
    assert.equal(failed.errorCode, 'upstream_idle_timeout');
    assert.match(failed.thought, /准备记录.*继续整理回复/);
    assert.deepEqual(failed.processEntries.map((entry) => entry.type), ['thought', 'tool', 'thought']);
    assert.equal(failed.processEntries[1].ok, true);
    assert.equal(failed.toolSummaries[0].name, 'remember_user');
    assert.ok(!JSON.stringify(thread).includes('secret-upstream-detail'));
    assert.equal((await (await route('/api/ai/memory', 'GET')).json()).memories.length, 1);
    assert.equal((await readThread(route, 'account-B')).messages.length, 0);
    let prompt;
    const recovered = await route('/api/ai/chat', 'POST', body(thread.revision, 'next-1'), 'account-A', {
      chat: async (messages) => { prompt = messages; return { type: 'content', content: '上一轮记忆已写入，但回复超时。' }; },
    });
    assert.equal((await events(recovered)).at(-1).type, 'done');
    const failureContext = prompt.find((message) => message.content.includes('[系统失败记录'));
    assert.match(failureContext.content, /upstream_idle_timeout/);
    assert.match(failureContext.content, /memory-1/);
    assert.match(failureContext.content, /已成功的操作不要自动重复/);
    assert.equal((await (await route('/api/ai/memory', 'GET')).json()).memories.length, 1);
  } finally { sqlite.close(); }
});

test('cancellation saves one failure and a late model result cannot resurrect cleared history', async () => {
  const { sqlite, route } = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async (_messages, _tools, _config, _env, callbacks) => {
        callbacks.onThoughtDelta('正在处理。');
        await gate;
        return { type: 'content', content: '过期回答' };
      },
    });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    const thread = await readThread(route);
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages.at(-1).errorCode, 'request_cancelled');
    assert.equal(thread.messages.at(-1).thought, '正在处理。');
    const cleared = await route('/api/ai/thread', 'DELETE', { revision: thread.revision });
    assert.equal(cleared.status, 200);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await readThread(route)).messages.length, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM music_chat_turns').get().count, 0);
  } finally { release(); sqlite.close(); }
});

test('cancellation after commit does not replace the saved answer or duplicate a record', async () => {
  const { sqlite, route } = fixture();
  try {
    const response = await route('/api/ai/chat', 'POST', body(), 'account-A', {
      chat: async () => ({ type: 'content', content: '已完成' }),
    });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    const thread = await readThread(route);
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.messages.at(-1).content, '已完成');
    assert.equal(thread.messages.at(-1).isError, undefined);
    assert.equal(thread.revision, 2);
    assert.equal(sqlite.prepare('SELECT status FROM music_chat_turns').get().status, 'completed');
  } finally { sqlite.close(); }
});
