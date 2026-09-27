import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleLocalAssistantRoute } from './localAssistant.js';
import { assistantMemoryTool } from '../tools/assistantMemory.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0001_baseline.sql', '0002_expand_playlist_count.sql', '0008_assistant_memory.sql']) {
    sqlite.exec(readFileSync(new URL(`../../db/migrations-flaretune/${file}`, import.meta.url), 'utf8'));
  }
  for (const id of ['account-A', 'account-B']) {
    sqlite.prepare(`INSERT INTO accounts
      (account_id, username, display_name, role, status, created_at, updated_at)
      VALUES (?, ?, '', 'member', 'active', 1, 1)`).run(id, id.toLowerCase());
  }
  const db = {
    prepare(sql) {
      const values = [];
      return {
        bind(...items) { values.push(...items); return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
        runSync() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.runSync());
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const route = (accountId, path, method = 'GET', body, chat) => {
    const request = new Request(`https://flare.test${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' } }),
    });
    return handleLocalAssistantRoute(request, new URL(request.url), db, {},
      { mode: 'normal', account: { accountId, username: accountId.toLowerCase(),
        displayName: '', role: 'member' } }, { DEEPSEEK_API_KEY: 'test-key' },
      chat ? { chat } : {});
  };
  return { sqlite, route };
}

const body = (revision, id) => ({ revision, client_message_id: id,
  message: '聊聊音乐', enable_thinking: false, context: {} });
const events = async (response) => (await response.text()).trim().split('\n\n')
  .map((line) => JSON.parse(line.slice('data: '.length)));

test('memory stays private, off by default, and is not read or written while off', async () => {
  const { sqlite, route } = fixture();
  try {
    assert.deepEqual(await (await route('account-A', '/api/ai/memory')).json(),
      { enabled: false, memories: [] });
    const added = await (await route('account-A', '/api/ai/memory', 'POST',
      { content: '喜欢爵士乐' })).json();
    const id = added.memory.id;
    assert.equal((await (await route('account-B', '/api/ai/memory')).json()).memories.length, 0);
    assert.equal((await route('account-B', `/api/ai/memory/${id}`, 'PUT',
      { content: '我喜欢摇滚' })).status, 404);
    assert.equal((await route('account-B', `/api/ai/memory/${id}`, 'DELETE', {})).status, 404);
    let seen;
    const reply = await events(await route('account-A', '/api/ai/chat', 'POST', body(0, 'off-1'),
      async (messages, tools) => { seen = { messages, tools }; return { type: 'content', content: '你好' }; }));
    assert.equal(reply.at(-1).type, 'done');
    assert.equal(seen.tools.some((tool) => tool.function.name === 'remember_user'), false);
    assert.equal(seen.messages[0].content.includes('喜欢爵士乐'), false);
    const modified = await route('account-A', `/api/ai/memory/${id}`, 'PUT', { content: '更喜欢蓝调' });
    assert.equal(modified.status, 200);
    assert.equal((await (await route('account-A', '/api/ai/memory')).json()).memories[0].content, '更喜欢蓝调');
  } finally { sqlite.close(); }
});

test('enabled assistant memory persists across thread clear and stops after disabling', async () => {
  const { sqlite, route } = fixture();
  try {
    assert.equal((await route('account-A', '/api/ai/memory', 'PATCH', { enabled: true })).status, 200);
    let calls = 0;
    const first = await events(await route('account-A', '/api/ai/chat', 'POST', body(0, 'on-1'),
      async (messages, tools) => {
        assert.equal(tools.some((tool) => tool.function.name === 'remember_user'), true);
        calls += 1;
        return calls === 1 ? { type: 'function_calls', functionCalls: [{
          id: 'memory-1', name: 'remember_user', args: {
            content: '似乎偏爱爵士乐', source: 'inferred',
          },
        }] } : { type: 'content', content: '我会留意你的喜好。' };
      }));
    assert.equal(first.find((event) => event.type === 'tool_result')?.data?.memory?.source, 'inferred');
    const saved = (await (await route('account-A', '/api/ai/memory')).json()).memories;
    assert.equal(saved.length, 1);
    assert.ok(first.find((event) => event.type === 'thread_state'), JSON.stringify(first));
    const revision = first.find((event) => event.type === 'thread_state').revision;
    const cleared = await route('account-A', '/api/ai/thread', 'DELETE', { revision });
    assert.equal(cleared.status, 200);
    let prompt;
    const afterClear = await events(await route('account-A', '/api/ai/chat', 'POST',
      body((await cleared.json()).revision, 'on-2'), async (messages) => {
        prompt = messages[0].content; return { type: 'content', content: '好。' };
      }));
    assert.equal(afterClear.at(-1).type, 'done');
    assert.match(prompt, /似乎偏爱爵士乐/);
    await route('account-A', '/api/ai/memory', 'PATCH', { enabled: false });
    let offPrompt;
    const nextRevision = afterClear.find((event) => event.type === 'thread_state').revision;
    await events(await route('account-A', '/api/ai/chat', 'POST', body(nextRevision, 'off-2'),
      async (messages, tools) => {
        offPrompt = messages[0].content;
        assert.equal(tools.some((tool) => tool.function.name === 'remember_user'), false);
        return { type: 'content', content: '好。' };
      }));
    assert.equal(offPrompt.includes('似乎偏爱爵士乐'), false);
    assert.equal((await (await route('account-A', '/api/ai/memory')).json()).memories.length, 1);
  } finally { sqlite.close(); }
});

test('credentials are rejected from manual and assistant memory writes', async () => {
  const { sqlite, route } = fixture();
  try {
    await route('account-A', '/api/ai/memory', 'PATCH', { enabled: true });
    for (const content of [
      '密码为 supersecretpass123',
      'API key: abcdefghijklmno',
      '密钥是：abcdef123456',
      'sk-proj-abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno',
    ]) {
      const manual = await route('account-A', '/api/ai/memory', 'POST', { content });
      assert.equal(manual.status, 400, content);
      assert.equal((await manual.json()).error, 'credential_not_allowed');
      const tool = await assistantMemoryTool.execute({ content, source: 'stated' }, {
        db: { prepare: (...args) => { throw new Error(`unexpected storage query: ${args}`); } },
        accountId: 'account-A',
      });
      assert.equal(tool.eventData?.ok, false);
    }
    assert.equal((await (await route('account-A', '/api/ai/memory')).json()).memories.length, 0);
  } finally { sqlite.close(); }
});
