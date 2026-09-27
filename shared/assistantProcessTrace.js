export function appendThoughtProcessEntry(entries = [], start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return entries;
  const last = entries.at(-1);
  if (last?.type === 'thought' && last.end === start) {
    return [...entries.slice(0, -1), { ...last, end }];
  }
  return [...entries, { type: 'thought', start, end }];
}

export function appendToolProcessEntry(entries = [], { id, name, progress }) {
  return [...entries, { type: 'tool', id, name, progress }];
}

export function finishToolProcessEntry(entries = [], { id, summary, ok }) {
  const exactIndex = id ? entries.findIndex((entry) => entry.type === 'tool' && entry.id === id) : -1;
  const index = exactIndex >= 0 ? exactIndex
    : entries.findIndex((entry) => entry.type === 'tool' && !Object.hasOwn(entry, 'summary'));
  if (index < 0) return entries;
  return entries.map((entry, position) => position === index
    ? { ...entry, summary, ok }
    : entry);
}

export function getAssistantProcessTimeline(message) {
  const thought = typeof message?.thought === 'string' ? message.thought : '';
  const orderedEntries = Array.isArray(message?.processEntries) && message.processEntries.length > 0
    ? message.processEntries : null;
  const summaries = Array.isArray(message?.toolSummaries) ? message.toolSummaries : [];
  const entries = orderedEntries
    ? [...orderedEntries]
    : [
        ...(thought ? [{ type: 'thought', start: 0, end: thought.length, orderUnknown: true }] : []),
      ];
  const recordedToolIds = new Set(entries.filter((entry) => entry?.type === 'tool' && entry.id)
    .map((entry) => entry.id));
  const recordedToolSummaries = new Set(entries.filter((entry) => entry?.type === 'tool' && entry.summary)
    .map((entry) => entry.summary));
  for (const item of summaries) {
    if ((item.id && recordedToolIds.has(item.id))
      || (!item.id && recordedToolSummaries.has(item.summary))) continue;
    entries.push({ type: 'tool', id: item.id, name: '工具调用', summary: item.summary,
      ok: item.ok, orderUnknown: true });
  }
  return entries.flatMap((entry) => {
    if (entry?.type === 'thought') {
      const start = Math.max(0, Math.min(thought.length, Number(entry.start) || 0));
      const end = Math.max(start, Math.min(thought.length, Number(entry.end) || 0));
      const text = thought.slice(start, end).trim();
      return text ? [{ type: 'thought', text, orderUnknown: entry.orderUnknown === true }] : [];
    }
    if (entry?.type === 'tool') {
      return [{ type: 'tool', id: entry.id, name: entry.name || '工具调用',
        progress: entry.progress || '', summary: entry.summary || '', ok: entry.ok !== false,
        orderUnknown: entry.orderUnknown === true }];
    }
    return [];
  });
}

export function getAssistantProcessStatus(message, now = Date.now()) {
  if (!message?.isGenerating) {
    return { stage: message?.isError ? 'failed' : 'complete',
      label: message?.isError ? '处理未完成' : '处理完成' };
  }
  if (!Number.isFinite(message.processingStartedAt) || message.processingStartedAt <= 0) {
    return { stage: 'thinking', label: '正在思考' };
  }
  return { stage: 'processing', label: '正在处理',
    seconds: Math.max(0, Math.floor((now - message.processingStartedAt) / 1000)) };
}
