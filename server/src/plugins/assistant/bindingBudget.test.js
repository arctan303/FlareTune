import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as directFixture } from '../../routes/localAssistant.fixture.js';
import { fixture as httpFixture } from '../../subsonic/test-support.js';
import { assistantBuildHeaders } from './test-support.js';
import { chatWithAssistantTools } from './handler.js';

function countBindings(db, ceiling = 50) {
  let calls = 0;
  const spend = () => { calls += 1; if (calls > ceiling) throw new Error('D1 Free binding limit exceeded'); };
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    for (const method of ['first', 'all', 'run']) {
      const original = statement[method];
      statement[method] = (...args) => { spend(); return original.apply(statement, args); };
    }
    return statement;
  };
  db.batch = statements => { spend(); return batch(statements); };
  const count = () => calls; count.reset = () => { calls = 0; }; return count;
}
const input = id => ({ message: 'hello', client_message_id: id, revision: 0, enable_thinking: false });
const parse = async response => (await response.text()).split('\n\n').filter(Boolean).map(part => JSON.parse(part.slice(6)));

test('100 provider deltas finish within the Free invocation binding budget', async t => {
  const f = directFixture(); t.after(() => f.sqlite.close()); const calls = countBindings(f.db);
  const result = await parse(await f.route('/api/ai/chat', 'POST', input('budget-deltas'), 'account-A', {
    chat: async (_m, _t, _c, _e, options) => {
      for (let i = 0; i < 100; i++) options.onContentDelta('x');
      return { type: 'content', content: 'A complete answer' };
    },
  }));
  assert.ok(result.some(event => event.type === 'done'));
  assert.equal(result.filter(event => event.type === 'content_delta').length, 100);
  assert.ok(calls() <= 35, `direct handler used ${calls()} binding calls`);
});

test('a full authenticated HTTP stream stays within 50 D1 binding calls', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  for (const id of ['ai-gateway', 'assistant']) f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES (?,?,1,1,?)`).run(`plugin.installation.${id}`, JSON.stringify({ installed: true, epoch: crypto.randomUUID() }), f.owner);
  f.env.DEEPSEEK_API_KEY = 'test-private-key';
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(
    Array.from({ length: 100 }, () => `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`).join('')
      + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const calls = countBindings(f.db);
  const response = await f.api('account/plugins/assistant/chat', 'POST', input('http-budget'), f.signed, assistantBuildHeaders());
  const result = await response.text();
  assert.equal(response.status, 200, result);
  assert.match(result, /"type":"done"/);
  assert.ok(calls() <= 50, `HTTP used ${calls()} binding calls`);
  t.diagnostic(`full HTTP used ${calls()} binding calls`);
});

test('a real HTTP network stream saves a resumable failure before 50 and can continue in a new invocation', async t => {
  const f = await httpFixture(); t.after(() => f.close());
  for (const id of ['ai-gateway', 'assistant']) f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES (?,?,1,1,?)`).run(`plugin.installation.${id}`, JSON.stringify({ installed: true, epoch: crypto.randomUUID() }), f.owner);
  f.env.DEEPSEEK_API_KEY = 'test-private-key';
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let first = true;
  globalThis.fetch = async (_url, options) => {
    if (!first) return new Response('data: {"choices":[{"delta":{"content":"continued"}}]}\n\ndata: [DONE]\n\n');
    first = false;
    const encoder = new TextEncoder(); let timer;
    return new Response(new ReadableStream({
      start(controller) {
        timer = setInterval(() => controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial "}}]}\n\n')), 100);
        options.signal.addEventListener('abort', () => { clearInterval(timer); try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} }, { once: true });
      }, cancel() { clearInterval(timer); },
    }));
  };
  const calls = countBindings(f.db);
  const events = await parse(await f.api('account/plugins/assistant/chat', 'POST', input('http-exhaustion'), f.signed, assistantBuildHeaders()));
  const firstCalls = calls();
  assert.ok(firstCalls <= 50);
  assert.ok(events.some(event => event.type === 'error'));
  assert.equal(events.some(event => event.type === 'done'), false);
  const turn = f.sqlite.prepare('SELECT id,status FROM music_chat_turns').get();
  assert.equal(turn.status, 'failed');
  const saved = f.sqlite.prepare("SELECT extra_json FROM music_chat_thread_messages WHERE role='assistant'").get();
  assert.ok(JSON.parse(saved.extra_json).partialContent.length > 0);
  const revision = f.sqlite.prepare('SELECT revision FROM music_chat_threads').get().revision;
  calls.reset();
  const next = await parse(await f.api('account/plugins/assistant/chat', 'POST', { ...input('http-continue'), revision,
    continue_turn_id: turn.id }, f.signed, assistantBuildHeaders()));
  assert.ok(next.some(event => event.type === 'done'));
  assert.ok(calls() <= 50);
  t.diagnostic(`HTTP exhaustion ${firstCalls} bindings; continuation ${calls()} bindings`);
});

test('resource exhaustion persists a resumable failure before the native Free limit', async t => {
  const f = directFixture(); t.after(() => f.sqlite.close()); const calls = countBindings(f.db);
  const result = await parse(await f.route('/api/ai/chat', 'POST', input('budget-exhaustion'), 'account-A', {
    chat: async (_m, _t, _c, _e, options) => {
      for (let i = 0; i < 100; i++) {
        if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        options.onContentDelta('x'); await new Promise(resolve => setTimeout(resolve, 30));
      }
      return { type: 'content', content: 'Must not complete' };
    },
  }));
  assert.equal(result.some(event => event.type === 'done'), false);
  assert.ok(calls() <= 46, `request used ${calls()} binding calls`);
  const turn = f.sqlite.prepare('SELECT status FROM music_chat_turns').get();
  assert.equal(turn.status, 'failed');
  const stored = f.sqlite.prepare("SELECT extra_json FROM music_chat_thread_messages WHERE role='assistant'").get();
  assert.ok(JSON.parse(stored.extra_json).partialContent.length > 0);
  assert.ok(result.some(event => event.type === 'error'));
  calls.reset();
  const thread = await (await f.route('/api/ai/thread', 'GET')).json();
  assert.equal(thread.thread.pendingTurn, null);
});

test('a tool round and final response keep their transaction guards within the binding budget', async t => {
  const f = directFixture(); t.after(() => f.sqlite.close()); const calls = countBindings(f.db);
  let round = 0;
  const result = await parse(await f.route('/api/ai/chat', 'POST', input('budget-tool'), 'account-A', {
    chat: async () => ++round === 1
      ? { type: 'function_calls', functionCalls: [{ id: 'now', name: 'current_time', args: {} }] }
      : { type: 'content', content: 'A complete answer' },
  }));
  t.diagnostic(`tool direct handler used ${calls()} binding calls`);
  assert.ok(result.some(event => event.type === 'tool_result'));
  assert.ok(result.some(event => event.type === 'done'));
  assert.ok(calls() <= 42);
});

test('five pure tool rounds still make one final tool-free request', async () => {
  const tools = [], output = [];
  await chatWithAssistantTools({ chat: async (_messages, available) => {
    tools.push(available);
    return { type: 'function_calls', functionCalls: [{ id: `time-${tools.length}`, name: 'current_time', args: {} }] };
  }, messages: [{ role: 'user', content: 'time' }], config: { gatewayIdentity: 'test' }, env: {},
  db: {}, toolDb: {}, accountId: 'test', session: {}, memoryAllowed: false, live: {}, clientMessageId: 'test',
  emit: event => output.push(event), isCancelled: () => false, signal: new AbortController().signal,
  saveContext: async () => {}, authorize: async () => {} });
  assert.deepEqual(tools.map(available => available.length > 0), [true, true, true, true, true, false]);
  assert.equal(output.filter(event => event.type === 'tool_call').length, 5);
});

test('budget exhaustion after a successful mutation preserves its operation and continuation does not repeat it', async t => {
  const f = directFixture(); t.after(() => f.sqlite.close()); const calls = countBindings(f.db); let round = 0;
  const call = id => ({ type: 'function_calls', functionCalls: [{ id, name: 'manage_playlist', args: { action: 'create', name: 'Budget preserved playlist' } }] });
  const result = await parse(await f.route('/api/ai/chat', 'POST', input('mutation-exhaustion'), 'account-A', {
    chat: async (_m, _t, _c, _e, options) => {
      if (++round === 1) return call('create');
      for (let i = 0; i < 100; i++) {
        if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        options.onContentDelta('partial '); await new Promise(resolve => setTimeout(resolve, 30));
      }
      return { type: 'content', content: 'Must not finish' };
    },
  }));
  assert.ok(result.some(event => event.type === 'tool_result' && event.data?.ok));
  assert.ok(result.some(event => event.type === 'error'));
  assert.ok(calls() <= 45);
  const turn = f.sqlite.prepare('SELECT id,status FROM music_chat_turns').get(); assert.equal(turn.status, 'failed');
  const revision = f.sqlite.prepare('SELECT revision FROM music_chat_threads').get().revision;
  const stored = JSON.parse(f.sqlite.prepare("SELECT extra_json FROM music_chat_thread_messages WHERE role='assistant'").get().extra_json);
  assert.equal(stored.savedContext.completedOperations.length, 1);
  calls.reset(); round = 0;
  const next = await parse(await f.route('/api/ai/chat', 'POST', { ...input('mutation-continue'), revision, continue_turn_id: turn.id }, 'account-A', {
    chat: async () => ++round === 1 ? call('replayed') : { type: 'content', content: 'Already completed' },
  }));
  assert.ok(next.some(event => event.type === 'done'));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE name='Budget preserved playlist'").get().n, 1);
});
