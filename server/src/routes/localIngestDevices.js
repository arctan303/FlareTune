// A small R2 mailbox lets a local Node process initiate every connection.
// Both the browser and the process use existing administrator sessions.
import { mediaPrefix } from '../services/adminMusicMedia.js';

const PREFIX = '/api/admin/ingest/devices';
const ID = /^[a-f0-9]{32}$/;
const MEDIA_URL = /^\/media\/(audio|cover)\/[a-f0-9]{16}\.(mp3|flac|wav|ogg|m4a|aac|wma|jpg|jpeg|png|webp)$/;
const ONLINE_MS = 60_000;
const json = (data, status = 200) => new Response(JSON.stringify({ ok: status < 400, data }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
});
const fail = (message, status = 400) => new Response(JSON.stringify({ ok: false, message }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
});
const read = async (bucket, objectKey) => {
  const object = await bucket.get(objectKey);
  return object ? object.json() : null;
};
const put = (bucket, objectKey, value) => bucket.put(objectKey, JSON.stringify(value), {
  httpMetadata: { contentType: 'application/json' },
});
async function bodyOf(request, limit = 64 * 1024) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new Error('请求内容过大。');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('请求内容为空。');
  const chunks = [];
  let count = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > limit) { await reader.cancel(); throw new Error('请求内容过大。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('请求格式无效。');
  return result;
}
async function listAll(bucket, prefix, limit = 100) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: Math.min(limit, 1000) });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor && objects.length < limit);
  return objects.slice(0, limit);
}
const online = (record) => record && Date.now() - record.lastSeenAt < ONLINE_MS;

export async function handleLocalIngestDevicesRoute(request, url, _db, _options, session, env) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (session?.mode !== 'normal' || session?.account?.role !== 'admin') return fail('只有管理员可以管理入库设备。', 403);
  const bucket = env?.MEDIA_BUCKET;
  if (!bucket) return fail('媒体存储未配置。', 503);
  const mediaRoot = mediaPrefix(env);
  if (!mediaRoot) return fail('媒体存储前缀无效。', 503);
  const devicePrefix = `${mediaRoot}/ingest-devices/v1/`;
  const key = (id, part) => `${devicePrefix}${id}/${part}`;
  const deviceKey = (id) => `${devicePrefix}registry/${id}.json`;
  const device = (id) => read(bucket, deviceKey(id));
  try {
    if (url.pathname === PREFIX && request.method === 'GET') {
      const objects = await listAll(bucket, `${devicePrefix}registry/`, 200);
      const summaries = [];
      for (const object of objects) {
        const record = await read(bucket, object.key);
        if (record) summaries.push({ ...record, online: online(record) });
      }
      return json({ devices: summaries });
    }
    const parts = url.pathname.slice(PREFIX.length + 1).split('/');
    const [id, action, jobId] = parts;
    if (!ID.test(id || '')) return fail('设备 ID 无效。');
    if (parts.length === 2 && action === 'heartbeat' && request.method === 'POST') {
      const value = await bodyOf(request);
      const name = String(value.name || '').trim().slice(0, 80);
      const roots = Array.isArray(value.roots) ? value.roots.map((root) => String(root).slice(0, 100)).slice(0, 16) : [];
      if (!name || !roots.length) return fail('设备名称和音乐目录不能为空。');
      const old = await device(id);
      const record = { id, name, roots, lastSeenAt: Date.now(), scannedAt: old?.scannedAt || null };
      await put(bucket, deviceKey(id), record);
      return json({ ...record, online: true });
    }
    const record = await device(id);
    if (!record) return fail('设备尚未连接。', 404);
    if (parts.length === 2 && action === 'manifest') {
      if (request.method === 'GET') {
        const manifest = await read(bucket, key(id, 'manifest.json'));
        return json({ ...manifest, online: online(record), name: record.name });
      }
      if (request.method === 'PUT') {
        const value = await bodyOf(request, 2 * 1024 * 1024);
        if (!Array.isArray(value.files) || value.files.length > 5000
          || value.files.some((file) => !ID.test(file?.id || '') || typeof file.path !== 'string'
            || file.path.length > 1024 || typeof file.name !== 'string' || file.name.length > 512
            || !Number.isSafeInteger(file.size) || file.size < 1
            || file.cover && (!Number.isSafeInteger(file.cover.size) || file.cover.size < 1))) {
          return fail('扫描清单无效。');
        }
        const previous = value.preserveScanTime === true ? await read(bucket, key(id, 'manifest.json')) : null;
        const manifest = { files: value.files, scannedAt: previous?.scannedAt || Date.now() };
        await put(bucket, key(id, 'manifest.json'), manifest);
        await put(bucket, deviceKey(id), { ...record, scannedAt: manifest.scannedAt });
        return json({ count: value.files.length, scannedAt: manifest.scannedAt });
      }
    }
    if (parts.length === 2 && action === 'poll' && request.method === 'GET') {
      const objects = await listAll(bucket, key(id, 'pending/'), 100);
      const jobs = [];
      for (const object of objects) {
        const pending = await read(bucket, object.key);
        if (pending) jobs.push(pending);
      }
      return json({ jobs });
    }
    if (parts.length === 2 && action === 'jobs' && request.method === 'POST') {
      if (!online(record)) return fail('设备已离线，请等待重新连接。', 409);
      const value = await bodyOf(request);
      if (!['audio', 'cover', 'refresh'].includes(value.kind)) return fail('任务类型无效。');
      let candidate = null;
      let expectedSize = null;
      let expectedExtension = null;
      if (value.kind !== 'refresh') {
        const manifest = await read(bucket, key(id, 'manifest.json'));
        candidate = manifest?.files?.find((file) => file.id === value.fileId);
        if (!candidate) return fail('文件已不在最新扫描清单，请刷新。', 409);
        if (value.kind === 'cover' && !candidate.cover) return fail('此歌曲没有封面。', 409);
        expectedSize = value.kind === 'audio' ? candidate.size : candidate.cover.size;
        expectedExtension = (value.kind === 'audio' ? candidate.name : candidate.cover.name)
          .split('.').at(-1)?.toLowerCase();
        const validExtension = value.kind === 'audio'
          ? /^(mp3|flac|wav|ogg|m4a|aac|wma)$/.test(expectedExtension || '')
          : /^(jpg|jpeg|png|webp)$/.test(expectedExtension || '');
        if (!validExtension) return fail('文件格式无效，请重新扫描。', 409);
        if (expectedSize > 100_000_000) return fail('文件超过 Worker 上传上限。', 413);
      }
      const jobIdNew = crypto.randomUUID().replaceAll('-', '');
      const job = { id: jobIdNew, kind: value.kind, fileId: value.fileId || null,
        createdAt: Date.now(), mediaId: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
        expectedSize, expectedExtension };
      await put(bucket, key(id, `pending/${job.id}.json`), job);
      return json({ job }, 201);
    }
    if (parts.length === 3 && action === 'jobs' && ID.test(jobId || '')) {
      const pendingKey = key(id, `pending/${jobId}.json`);
      const resultKey = key(id, `result/${jobId}.json`);
      const progressKey = key(id, `progress/${jobId}.json`);
      if (request.method === 'GET') {
        const result = await read(bucket, resultKey);
        if (result) return json({ job: result });
        const pending = await read(bucket, pendingKey);
        return pending ? json({ job: { ...pending, status: 'pending',
          progress: await read(bucket, progressKey) } }) : fail('任务不存在。', 404);
      }
      if (request.method === 'PUT') {
        const pending = await read(bucket, pendingKey);
        if (!pending) return fail('任务不存在或已完成。', 404);
        const value = await bodyOf(request);
        if (!['done', 'error'].includes(value.status)) {
          return fail('任务结果无效。');
        }
        if (value.status === 'done' && pending.kind !== 'refresh') {
          const exactUrl = `/media/${pending.kind}/${pending.mediaId}.${pending.expectedExtension}`;
          if (!MEDIA_URL.test(value.url || '') || value.url !== exactUrl) return fail('任务媒体地址无效。');
          const object = await bucket.head(`${mediaRoot}/${exactUrl.slice('/media/'.length)}`);
          if (!object || object.size !== pending.expectedSize) return fail('上传对象未确认，请重试。', 409);
        }
        const result = { ...pending, status: value.status, url: value.url || null,
          message: String(value.message || '').slice(0, 300), completedAt: Date.now() };
        await put(bucket, resultKey, result);
        await bucket.delete(pendingKey);
        await bucket.delete(progressKey);
        return json({ job: result });
      }
    }
    if (parts.length === 4 && action === 'jobs' && ID.test(jobId || '')
      && parts[3] === 'progress' && request.method === 'PUT') {
      const pending = await read(bucket, key(id, `pending/${jobId}.json`));
      if (!pending || pending.kind === 'refresh') return fail('任务不存在或无需传输。', 404);
      const value = await bodyOf(request);
      if (!Number.isSafeInteger(value.loaded) || value.loaded < 0
        || value.loaded > pending.expectedSize || value.total !== pending.expectedSize) {
        return fail('传输进度无效。');
      }
      await put(bucket, key(id, `progress/${jobId}.json`), {
        kind: pending.kind, loaded: value.loaded, total: pending.expectedSize,
      });
      return json({ accepted: true });
    }
    if (parts.length === 4 && action === 'jobs' && ID.test(jobId || '')
      && parts[3] === 'retry' && request.method === 'POST') {
      if (!online(record)) return fail('设备已离线，请等待重新连接。', 409);
      const pendingKey = key(id, `pending/${jobId}.json`);
      const resultKey = key(id, `result/${jobId}.json`);
      if (await read(bucket, pendingKey)) return fail('任务仍在处理中。', 409);
      const result = await read(bucket, resultKey);
      if (!result || result.status !== 'error') return fail('只有失败任务可以重试。', 409);
      const job = { id: result.id, kind: result.kind, fileId: result.fileId,
        createdAt: result.createdAt, mediaId: result.mediaId,
        expectedSize: result.expectedSize, expectedExtension: result.expectedExtension };
      await put(bucket, pendingKey, job);
      await bucket.delete(resultKey);
      await bucket.delete(key(id, `progress/${jobId}.json`));
      return json({ job }, 201);
    }
    return fail('入库设备接口不存在。', 404);
  } catch (error) {
    return fail(error instanceof SyntaxError ? '请求 JSON 无效。' : error.message || '设备操作失败。', 400);
  }
}
