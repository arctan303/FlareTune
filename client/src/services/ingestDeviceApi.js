import { getApiBaseUrl } from './apiBase.js';
import { requestAccountJson } from './accountApiRequest.js';

export class IngestDeviceError extends Error {
  constructor(message, details = {}) { super(message); Object.assign(this, details); }
}
const request = (path, init = {}) => requestAccountJson({
  base: getApiBaseUrl(), path: `/api/admin/ingest/devices${path}`, init,
  ErrorType: IngestDeviceError, errorLabel: '入库设备操作失败',
});
export const listIngestDevices = (signal) => request('', { signal });
export const getDeviceManifest = (id, signal) => request(`/${id}/manifest`, { signal });
export const createDeviceJob = (id, value, signal) => request(`/${id}/jobs`, {
  method: 'POST', body: JSON.stringify(value), signal,
});
export const getDeviceJob = (id, jobId, signal) => request(`/${id}/jobs/${jobId}`, { signal });
export const retryDeviceJob = (id, jobId, signal) => request(`/${id}/jobs/${jobId}/retry`, {
  method: 'POST', signal,
});

export async function waitForDeviceJob(deviceId, jobId, { timeoutMs = 180_000, onProgress, signal } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    signal?.throwIfAborted();
    const { job } = await getDeviceJob(deviceId, jobId, signal);
    signal?.throwIfAborted();
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new IngestDeviceError(job.message || '本地设备处理失败。');
    onProgress?.(job.progress);
    await new Promise((done) => setTimeout(done, 1500));
  }
  throw new IngestDeviceError('等待本地设备超时。可刷新设备状态后重试。');
}
export async function runDeviceJob(deviceId, value, { jobId, onJob, onProgress, signal } = {}) {
  signal?.throwIfAborted();
  if (jobId) {
    const { job: existing } = await getDeviceJob(deviceId, jobId, signal);
    signal?.throwIfAborted();
    if (existing.kind !== value.kind || existing.fileId !== (value.fileId || null)) {
      throw new IngestDeviceError('原任务与这首歌不匹配，请刷新清单。');
    }
    if (existing.status === 'done') return existing;
    if (existing.status === 'error') await retryDeviceJob(deviceId, jobId, signal);
    return waitForDeviceJob(deviceId, jobId, { onProgress, signal });
  }
  const { job } = await createDeviceJob(deviceId, value, signal);
  signal?.throwIfAborted();
  onJob?.(job);
  return waitForDeviceJob(deviceId, job.id, { onProgress, signal });
}
