import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './localAssistant.fixture.js';
import { normalizeCloudThreadMessages } from '../../../client/src/services/aiThreadSync.js';
import { getAssistantProcessTimeline, getAssistantProcessOverview } from '../../../shared/assistantProcessTrace.js';

test('completed tool calls survive a fresh history read and frontend normalization', async () => {
  const { sqlite, route } = fixture();
  try {
    let round = 0;
    const response = await route('/api/ai/chat', 'POST', { revision: 0,
      client_message_id: 'process-history', message: '查询时间', enable_thinking: true, context: {} }, 'account-A', {
      chat: async (_messages, _tools, _config, _env, callbacks) => {
        if (round++ === 0) {
          callbacks.onThoughtDelta('先查询。');
          return { type: 'function_calls', functionCalls: [{ id: 'time-one', name: 'current_time', args: {} }] };
        }
        callbacks.onThoughtDelta('再回答。');
        return { type: 'content', content: '时间已经查询。' };
      },
    });
    await response.text();
    for (let read = 0; read < 2; read += 1) {
      const { thread } = await (await route('/api/ai/thread', 'GET')).json();
      const saved = normalizeCloudThreadMessages(thread.messages).at(-1);
      assert.deepEqual(getAssistantProcessTimeline(saved).map((entry) => entry.type), ['thought', 'tool', 'thought']);
      assert.equal(getAssistantProcessOverview(saved).toolCount, 1);
      assert.equal(saved.toolSummaries[0].id, 'time-one');
    }
    const other = await (await route('/api/ai/thread', 'GET', undefined, 'account-B')).json();
    assert.equal(other.thread.messages.length, 0);
  } finally { sqlite.close(); }
});
