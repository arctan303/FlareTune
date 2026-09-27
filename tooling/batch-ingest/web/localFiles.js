export async function uploadLocal(file, kind, id, mode, csrf, onProgress) {
  const response = await fetch(`/api/local-file/${file.localId}/upload/${kind}/${id}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'X-Requested-With': 'FlareTuneIngest', 'X-Ingest-CSRF': csrf,
      'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    const error = new Error(value.error || `上传失败（${response.status}）`);
    error.upstreamStatus = value.upstreamStatus;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', result;
  for (;;) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.loaded !== undefined) onProgress(event.loaded, event.total);
      if (event.result) result = event.result;
      if (event.error) {
        const error = new Error(event.error);
        error.upstreamStatus = event.upstreamStatus;
        throw error;
      }
    }
    if (done) break;
  }
  if (!result) throw new Error('上传连接中断，请重试。');
  return result;
}
