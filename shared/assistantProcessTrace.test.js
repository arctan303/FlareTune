import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendThoughtProcessEntry, appendToolProcessEntry, finishToolProcessEntry,
  getAssistantProcessStatus, getAssistantProcessTimeline, getAssistantProcessOverview,
} from './assistantProcessTrace.js';

test('process timeline keeps thought segments around tool calls in event order', () => {
  const thought = '先检查歌单。再整理回答。';
  let entries = appendThoughtProcessEntry([], 0, 6);
  entries = appendToolProcessEntry(entries, { id: 'call-1', name: '读取歌单', progress: '正在读取' });
  entries = finishToolProcessEntry(entries, { id: 'call-1', summary: '找到一份歌单', ok: true });
  entries = appendThoughtProcessEntry(entries, 6, thought.length);

  assert.deepEqual(getAssistantProcessTimeline({ thought, processEntries: entries }).map((entry) => (
    entry.type === 'thought' ? entry.text : entry.summary
  )), ['先检查歌单。', '找到一份歌单', '再整理回答。']);
});

test('old assistant messages still expose available thought and tool summaries', () => {
  const timeline = getAssistantProcessTimeline({ thought: '核对曲库。',
    toolSummaries: [{ id: 'old-1', name: 'music_query', summary: '找到两首歌', ok: true }] });
  assert.deepEqual(timeline.map((entry) => entry.type), ['thought', 'tool']);
  assert.equal(timeline[1].name, '检索乐境曲库');
  assert.equal(timeline[1].summary, '找到两首歌');
});

test('collapsed overview uses real active tools, finished results and reply events', () => {
  const active = { isGenerating: true, thought: '正在检查', processEntries: [
    { type: 'thought', start: 0, end: 5 },
    { type: 'tool', id: 'one', name: '我的歌单', summary: '已读取', ok: true },
    { type: 'tool', id: 'two', name: '记忆', progress: '正在记录' },
  ] };
  assert.deepEqual(getAssistantProcessOverview(active), {
    toolCount: 2, toolName: '记忆', detail: '',
  });
  active.processEntries[2].summary = '未保存';
  active.processEntries[2].ok = false;
  assert.equal(getAssistantProcessOverview(active).detail, '等待模型响应…');
  assert.equal(getAssistantProcessOverview(active).toolName, '');
  active.content = '正在回答';
  assert.equal(getAssistantProcessOverview(active).detail, '整理回答');
  active.isGenerating = false;
  assert.equal(getAssistantProcessOverview(active).toolCount, 2);
  assert.equal(getAssistantProcessOverview(active).toolName, '');
  assert.equal(getAssistantProcessOverview(active).detail, '');
  assert.equal(getAssistantProcessOverview({ ...active, isError: true }).detail, '');
  assert.equal(getAssistantProcessOverview({ isGenerating: true, thought: '核对',
    processEntries: [{ type: 'thought', start: 0, end: 2 }] }).detail, '思考中');
  assert.equal(getAssistantProcessOverview({ isGenerating: true }).toolCount, 0);
});

test('history overview counts unique actual calls and resolves registered tool labels', () => {
  const message = { toolSummaries: [
    { id: 'one', name: 'current_time', summary: '已查询' },
    { id: 'one', name: 'current_time', summary: '已查询' },
    { id: 'two', name: 'remember_user', summary: '已记住' },
  ], processEntries: [{ type: 'tool', id: 'two', name: '记忆', summary: '已记住' }] };
  const overview = getAssistantProcessOverview(message);
  assert.equal(overview.toolCount, 2);
  assert.equal(getAssistantProcessTimeline(message)[1].name, '查询当前时间');
});

test('incomplete process entries recover missing tool summaries without duplicating known calls', () => {
  const thought = '先搜索。再放宽条件。';
  const missing = getAssistantProcessTimeline({ thought,
    processEntries: [{ type: 'thought', start: 0, end: thought.length }],
    toolSummaries: [{ id: 'call-1', summary: '搜索「日语」找到 0 首歌曲', ok: true }] });
  assert.deepEqual(missing.map((entry) => entry.type), ['thought', 'tool']);
  assert.equal(missing[1].summary, '搜索「日语」找到 0 首歌曲');
  assert.equal(missing[1].orderUnknown, true);

  const complete = getAssistantProcessTimeline({ thought,
    processEntries: [
      { type: 'thought', start: 0, end: 4 },
      { type: 'tool', id: 'call-1', summary: '搜索「日语」找到 0 首歌曲' },
      { type: 'thought', start: 4, end: thought.length },
    ],
    toolSummaries: [{ id: 'call-1', summary: '搜索「日语」找到 0 首歌曲', ok: true }] });
  assert.deepEqual(complete.map((entry) => entry.type), ['thought', 'tool', 'thought']);
  assert.equal(complete.some((entry) => entry.orderUnknown), false);
});

test('tool result settles an older stream call that omitted its id', () => {
  const entries = finishToolProcessEntry(
    appendToolProcessEntry([], { name: '检索乐境曲库', progress: '搜索中' }),
    { id: 'call-1', summary: '找到 4 首歌曲', ok: true },
  );
  assert.equal(entries[0].summary, '找到 4 首歌曲');
});

test('process status follows first response, elapsed time, completion and failure', () => {
  assert.deepEqual(getAssistantProcessStatus({ isGenerating: true }, 5000),
    { stage: 'thinking', label: '正在思考' });
  assert.deepEqual(getAssistantProcessStatus({ isGenerating: true, processingStartedAt: 2000 }, 5600),
    { stage: 'processing', label: '正在处理', seconds: 3 });
  assert.deepEqual(getAssistantProcessStatus({ isGenerating: false }, 5600),
    { stage: 'complete', label: '处理完成' });
  assert.deepEqual(getAssistantProcessStatus({ isGenerating: false, isError: true }, 5600),
    { stage: 'failed', label: '处理未完成' });
});
