import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './localAssistant.fixture.js';
import { chatAI } from '../services/ai.js';

const argumentsJson = JSON.stringify({ action: 'create', name: 'Must not exist' });
const incomplete = {
  chat_completions: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1',
    function: { name: 'manage_playlist', arguments: argumentsJson } }] } }] }],
  responses: [{ type: 'response.output_item.done', item: { type: 'function_call',
    call_id: 'call1', name: 'manage_playlist', arguments: argumentsJson } }],
  anthropic_messages: [{ type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'call1', name: 'manage_playlist', input: JSON.parse(argumentsJson) } },
  { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
  gemini_native: [{ candidates: [{ content: { parts: [{ functionCall: {
    id: 'call1', name: 'manage_playlist', args: JSON.parse(argumentsJson) } }] } }] }],
};

for (const [protocol, chunks] of Object.entries(incomplete)) {
  test(`${protocol} incomplete tool stream causes no playlist writes through the real assistant route`, async (t) => {
    const { sqlite, route } = fixture();
    t.mock.method(globalThis, 'fetch', async () => new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')));
    try {
      const response = await route('/api/ai/chat', 'POST', {
        revision: 0, client_message_id: `bad-${protocol}`, message: '创建歌单',
        enable_thinking: false, context: {},
      }, 'account-A', { chat: (messages, tools, config, env, options) => chatAI(messages, tools,
        { ...config, source: 'custom', protocol, model: 'fixture' }, {
          ...env, AI_PROFILE_API_KEY: 'fake-key', AI_PROFILE_BASE_URL: 'https://models.example/v1',
        }, options) });
      const events = (await response.text()).split('\n\n').filter(Boolean)
        .map((line) => JSON.parse(line.slice(6)));
      assert.ok(events.some((event) => event.type === 'error'));
      assert.ok(!events.some((event) => ['tool_call', 'tool_result'].includes(event.type)));
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM Member_Playlists WHERE name = 'Must not exist'").get().count, 0);
    } finally { sqlite.close(); }
  });
}
