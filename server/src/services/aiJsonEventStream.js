export function createJsonEventStreamParser(processJson) {
  const decoder = new TextDecoder();
  let buffer = '';

  const processLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6).trim();
      if (data && data !== '[DONE]') await processJson(data);
      return;
    }
    if (trimmed.startsWith('{')) await processJson(trimmed);
  };

  return {
    async push(value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) await processLine(line);
    },
    async flushJsonTail() {
      const tail = buffer.trim();
      buffer = '';
      if (tail.startsWith('{')) await processJson(tail);
    },
  };
}
