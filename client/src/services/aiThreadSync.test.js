import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiThreadRequestError,
  fetchCloudThread,
  normalizeCloudThreadMessages,
  planCloudThreadSync,
} from './aiThreadSync.js';

const fingerprint = (thread) => JSON.stringify({
  revision: Number(thread?.revision || 0),
  messages: normalizeCloudThreadMessages(thread?.messages),
});

const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

test('loads and normalizes the current cloud thread through one request boundary', async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await fetchCloudThread({
    apiBase: 'https://music-api.example',
    signal: controller.signal,
    fetchImpl: async (...args) => {
      calls.push(args);
      return response({ thread: {
        revision: '7',
        messages: [{ role: 'assistant', content: 42, tools: ['retired'] }],
      } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://music-api.example/api/ai/thread');
  assert.deepEqual(calls[0][1], {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  });
  assert.deepEqual(result.thread, {
    revision: 7,
    messages: [{
      id: 'cloud-0',
      role: 'assistant',
      content: '',
      createdAt: undefined,
      thought: undefined,
    }],
  });
  assert.equal(result.fingerprint, fingerprint(result.thread));
});

test('preserves thread request status and response data for unified 401 handling', async () => {
  await assert.rejects(
    fetchCloudThread({
      apiBase: 'https://music-api.example',
      fetchImpl: async () => response({ message: 'expired' }, 401),
    }),
    (error) => error instanceof AiThreadRequestError
      && error.status === 401
      && error.data.message === 'expired',
  );
});

test('normalizes the current cloud message fields without retaining local-only state', () => {
  assert.deepEqual(normalizeCloudThreadMessages([{
    id: 'assistant-1',
    role: 'assistant',
    content: '完成',
    songs: [{ id: 'song-1' }],
    displaySongs: [{ id: 'song-1' }],
    thought: '检查曲库',
    tools: [{ id: 'retired' }],
    isGenerating: true,
  }]), [{
    id: 'assistant-1',
    role: 'assistant',
    content: '完成',
    createdAt: undefined,
    thought: '检查曲库',
  }]);
});

test('replaces matching message ids when the cloud fingerprint carries new content and thought', () => {
  const previousThread = {
    revision: 4,
    messages: [{ id: 'assistant-1', role: 'assistant', content: '旧内容', thought: '旧思考' }],
  };
  const nextThread = {
    revision: 5,
    messages: [{ id: 'assistant-1', role: 'assistant', content: '新内容', thought: '新思考' }],
  };

  const plan = planCloudThreadSync({
    thread: nextThread,
    currentMessages: previousThread.messages,
    previousFingerprint: fingerprint(previousThread),
  });

  assert.equal(plan.kind, 'replace');
  assert.notEqual(plan.fingerprint, fingerprint(previousThread));
  assert.deepEqual(plan.messages, [{
    id: 'assistant-1',
    role: 'assistant',
    content: '新内容',
    createdAt: undefined,
    thought: '新思考',
  }]);
});

test('uses append only when every existing remote message still matches its local counterpart', () => {
  const current = [{ id: 'user-1', role: 'user', content: '播放一首歌' }];
  const thread = {
    revision: 2,
    messages: [
      current[0],
      { id: 'assistant-1', role: 'assistant', content: '已生成播放指令' },
    ],
  };

  const plan = planCloudThreadSync({ thread, currentMessages: current });

  assert.equal(plan.kind, 'append');
  assert.equal(plan.messages[0], current[0]);
  assert.equal(plan.messages[1].content, '已生成播放指令');
});

test('reports unchanged and empty cloud thread states explicitly', () => {
  const thread = { revision: 1, messages: [{ id: 'm1', role: 'user', content: 'hi' }] };
  const current = normalizeCloudThreadMessages(thread.messages);
  assert.equal(planCloudThreadSync({
    thread,
    currentMessages: current,
    previousFingerprint: fingerprint(thread),
  }).kind, 'unchanged');
  assert.equal(planCloudThreadSync({
    thread: { revision: 2, messages: [] },
    currentMessages: current,
  }).kind, 'empty');
});
