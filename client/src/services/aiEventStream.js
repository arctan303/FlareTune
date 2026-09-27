export function decodeSseJsonLine(line, { onInvalidJson } = {}) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('data: ')) return undefined;
  try {
    return JSON.parse(trimmed.slice(6));
  } catch (error) {
    onInvalidJson?.(error, trimmed);
    return undefined;
  }
}

export async function consumeSseJsonStream(readable, {
  onEvent,
  onInvalidJson,
  signal,
} = {}) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aborted = signal?.aborted === true;
  const handleAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    if (aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    while (true) {
      const { done, value } = await reader.read();
      if (aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = decodeSseJsonLine(line, { onInvalidJson });
        if (event !== undefined) await onEvent?.(event);
      }
    }

    // 与当前 Worker 契约一致：事件必须以换行结尾；残缺尾行不能作为完整事件执行。
    decoder.decode();
  } finally {
    signal?.removeEventListener('abort', handleAbort);
  }
}
