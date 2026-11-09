import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';
import { pluginRegistry } from '../plugins/registry.js';
import { handleLocalAssistantRoute } from './localAssistant.js';
import { assistantBuildHeaders } from '../plugins/assistant/test-support.js';

test('assistant passes the real session to roam and emits instructions only while the plugin is available', async t => {
  for (const actor of ['owner', 'member']) for (const state of ['missing', 'installed', 'revoked']) {
    await t.test(`${actor}: ${state}`, async t => {
      const f = await fixture();
      t.after(() => f.close());
      const auth = actor === 'owner' ? f.signed : await f.signIn('member');
      await pluginRegistry.setInstalled(f.env, f.signed.session, 'ai-gateway', { installed: true, revision: 0 });
      await pluginRegistry.setInstalled(f.env, f.signed.session, 'assistant', { installed: true, revision: 0 });
      if (state !== 'missing') await pluginRegistry.setInstalled(f.env, f.signed.session, 'roam', { installed: true, revision: 0 });
      const request = new Request('https://test.example/api/ai/chat', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...assistantBuildHeaders() }, body: JSON.stringify({ revision: 0,
          client_message_id: 'roam-test', message: '开启漫游', enable_thinking: false, context: {} }) });
      let calls = 0;
      const modelMessages = [];
      const response = await handleLocalAssistantRoute(request, new URL(request.url), f.db, {}, auth.session,
        { ...f.env, DEEPSEEK_API_KEY: 'test-local-only' }, { chat: async messages => {
          modelMessages.push(structuredClone(messages));
          if (++calls > 1) return { type: 'content', content: '处理结果见工具记录。' };
          if (state === 'revoked') f.sqlite.exec('DELETE FROM account_sessions');
          return { type: 'function_calls', functionCalls: [{ id: 'roam-call', name: 'roam_control', args: { action: 'enable', language: 'ja' } }] };
        } });
      assert.equal(response.status, 200);
      const events = (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
      if (state === 'revoked') {
        assert.equal(events.some(event => ['player_action', 'tool_result', 'done'].includes(event.type)), false);
        assert.equal(calls, 1, 'a revoked assistant never continues a tool round');
        return;
      }
      assert.equal(events.some(event => event.type === 'error'), false);
      const result = events.find(event => event.type === 'tool_result');
      assert.equal(result?.data.ok, state === 'installed');
      const actions = events.filter(event => event.type === 'player_action');
      if (state === 'installed') {
        assert.deepEqual(actions.map(event => event.action), [{ type: 'roam', action: 'enable', language: 'ja' }]);
        assert.equal(result.data.instruction_status, 'generated');
        assert.equal(result.data.browser_execution, 'unknown');
        assert.match(modelMessages.at(-1).at(-1).content, /浏览器执行结果未知/u);
      } else {
        assert.deepEqual(actions, []);
        assert.equal(result?.data.error.code, 'plugin_unavailable');
        assert.match(modelMessages.at(-1).at(-1).content, /未生成播放器指令/u);
      }
    });
  }
});
