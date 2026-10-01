import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiThreadRequestError,
  fetchCloudThread,
  normalizeCloudThreadMessages,
  mergeAssistantProcessMessages,
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

test('a partial history refresh retains tool events already received for the same saved reply', () => {
  const saved = { id: 'reply', role: 'assistant', content: '已查询', thought: '核对。',
    processEntries: [{ type: 'thought', start: 0, end: 3 },
      { type: 'tool', id: 'query', name: '我的歌单', summary: '找到两份歌单', ok: true }],
    toolSummaries: [{ id: 'query', summary: '找到两份歌单', ok: true }] };
  const remote = { ...saved, processEntries: [{ type: 'thought', start: 0, end: 3 }] };
  delete remote.toolSummaries;
  const plan = planCloudThreadSync({ thread: { revision: 4, messages: [remote] }, currentMessages: [saved] });
  assert.deepEqual(plan.messages[0].processEntries, saved.processEntries);
  assert.deepEqual(plan.messages[0].toolSummaries, saved.toolSummaries);
  assert.equal(planCloudThreadSync({ thread: { revision: 5, messages: [] },
    currentMessages: plan.messages }).messages.length, 0);
});

test('changed replies and newly loaded history do not borrow another message process', () => {
  const old = { id: 'reply', role: 'assistant', content: '旧回答', thought: '旧思考',
    processEntries: [{ type: 'tool', id: 'old', summary: '旧结果' }] };
  for (const next of [{ ...old, id: 'other' }, { ...old, content: '已修订' }, { ...old, thought: '新思考' }]) {
    delete next.processEntries;
    const plan = planCloudThreadSync({ thread: { revision: 6, messages: [next] }, currentMessages: [old] });
    assert.equal(plan.messages[0].processEntries, undefined);
  }
});

test('fresh history loading preserves full tool data; remote results correct received progress', () => {
  const recorded = { id: 'reply', role: 'assistant', content: '回答', thought: '先查再答',
    processEntries: [{ type: 'tool', id: 'one', name: '我的歌单', summary: '已读取', ok: true }],
    toolSummaries: [{ id: 'one', name: 'my_playlists', summary: '已读取', ok: true }] };
  assert.deepEqual(normalizeCloudThreadMessages([recorded])[0].processEntries, recorded.processEntries);
  const known = { ...recorded, processEntries: [...recorded.processEntries,
    { type: 'tool', id: 'two', name: '记忆', progress: '正在保存' }] };
  const revised = { ...recorded, processEntries: [{ ...recorded.processEntries[0], summary: '最新查询结果' }] };
  const merged = mergeAssistantProcessMessages([revised], [known])[0];
  assert.equal(merged.processEntries[0].summary, '最新查询结果');
  assert.equal(merged.processEntries[1].id, 'two');
  assert.deepEqual(mergeAssistantProcessMessages([], [known]), []);
  assert.equal(mergeAssistantProcessMessages([revised], [])[0], revised);
});
