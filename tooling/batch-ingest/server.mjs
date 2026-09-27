import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { RemoteCatalog } from './remote.mjs';
import { mediaType, validMediaSignature, WORKER_MAX_BYTES } from './core.mjs';
import { r2Settings, verifyR2Target, uploadR2 } from './r2.mjs';
import { ProfileStore } from './profiles.mjs';

const root = resolve(fileURLToPath(new URL('../../output/batch-ingest/', import.meta.url)));
const json = (res, status, value, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(value));
};
const cookie = (request, key) => String(request.headers.cookie || '').split(';').map((x) => x.trim())
  .find((part) => part.startsWith(key + '='))?.slice(key.length + 1);
async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function checkedStream(request, extension, length) {
  const iterator = request[Symbol.asyncIterator]();
  const first = [];
  let read = 0;
  while (read < 16) {
    const { value, done } = await iterator.next();
    if (done) throw new Error('媒体内容过短。');
    first.push(value);
    read += value.length;
    if (read > length) throw new Error('媒体大小与声明不一致。');
  }
  if (!validMediaSignature(Buffer.concat(first, Math.min(read, 16)), extension)) {
    throw new Error('媒体内容与扩展名不匹配。');
  }
  return Readable.from((async function* () {
    for (const chunk of first) yield chunk;
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      read += value.length;
      if (read > length) throw new Error('媒体大小与声明不一致。');
      yield value;
    }
    if (read !== length) throw new Error('媒体大小与声明不一致。');
  })());
}

export async function createBatchIngestServer({ port = 0, fetchImpl = fetch, staticDir = root,
  makeR2Settings = r2Settings, verifyR2 = verifyR2Target, uploadDirect = uploadR2,
  profileStore = new ProfileStore() } = {}) {
  const sessions = new Map();
  const appCsrf = randomBytes(24).toString('base64url');
  const server = createServer(async (request, response) => {
    const host = request.headers.host;
    if (!/^127\.0\.0\.1:\d+$/.test(host || '')) return json(response, 403, { error: '本地地址无效。' });
    const origin = `http://${host}`;
    const url = new URL(request.url, origin);
    const isMutation = !['GET', 'HEAD'].includes(request.method);
    if (isMutation && (request.headers.origin !== origin || request.headers['x-requested-with'] !== 'FlareTuneIngest')) {
      return json(response, 403, { error: '本地请求来源无效。' });
    }
    const token = cookie(request, 'ft_ingest');
    const session = token && sessions.get(token);
    const localCsrf = session?.localCsrf || appCsrf;
    if (isMutation && request.headers['x-ingest-csrf'] !== localCsrf) {
      return json(response, 403, { error: '本地会话无效。' });
    }
    try {
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const data = await readJson(request);
        const selected = data.profileId ? (await profileStore.list()).find((item) => item.id === data.profileId) : null;
        if (data.profileId && !selected) throw new Error('实例配置不存在。');
        const baseUrl = selected?.baseUrl || data.baseUrl;
        const username = selected?.username || data.username;
        const password = data.password || (selected?.savedPassword ? await profileStore.password(selected.id) : '');
        if (!password) throw new Error('请填写管理员密码。');
        const remote = new RemoteCatalog(baseUrl, fetchImpl);
        const account = await remote.login(username, password);
        let saved;
        try {
          saved = await profileStore.save({ id: selected?.id, name: selected?.name || data.name,
            baseUrl, username, password, rememberPassword: data.rememberPassword === true ||
              (selected?.savedPassword === true && data.rememberPassword !== false) });
        } catch (error) {
          await remote.logout().catch(() => {});
          throw error;
        }
        if (session) {
          await session.remote.logout().catch(() => {});
          session.r2?.client.destroy();
          sessions.delete(token);
        }
        const localToken = randomBytes(32).toString('base64url');
        const localCsrf = randomBytes(24).toString('base64url');
        sessions.set(localToken, { remote, localCsrf, r2: null, profileId: saved.profile.id });
        return json(response, 200, { account, csrf: localCsrf, profile: saved.profile, warning: saved.warning }, {
          'Set-Cookie': `ft_ingest=${localToken}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (url.pathname === '/api/state' && request.method === 'GET') {
        return json(response, 200, { loggedIn: Boolean(session),
          account: session?.remote.account || null, csrf: localCsrf,
          baseUrl: session?.remote.base || null, profileId: session?.profileId || null,
          r2Ready: Boolean(session?.r2) });
      }
      if (url.pathname === '/api/profiles' && request.method === 'GET') {
        return json(response, 200, { profiles: await profileStore.list() });
      }
      const profileDelete = /^\/api\/profiles\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (profileDelete && request.method === 'DELETE') {
        if (session?.profileId === profileDelete[1]) throw new Error('请先切换或退出当前实例，再删除此配置。');
        await profileStore.remove(profileDelete[1]);
        return json(response, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session) return json(response, 401, { error: '请先登录管理员账户。' });
        if (url.pathname === '/api/catalog' && request.method === 'GET') {
          return json(response, 200, { songs: await session.remote.listSongs() });
        }
        if (url.pathname === '/api/song' && request.method === 'POST') {
          const song = await readJson(request);
          return json(response, 200, await session.remote.createSong(song));
        }
        if (url.pathname.startsWith('/api/song/') && request.method === 'GET') {
          return json(response, 200, { song: await session.remote.getSong(url.pathname.slice('/api/song/'.length)) });
        }
        if (url.pathname.startsWith('/api/song/') && request.method === 'PUT') {
          return json(response, 200, await session.remote.updateSong(url.pathname.slice('/api/song/'.length), await readJson(request)));
        }
        if (url.pathname.startsWith('/api/song/') && request.method === 'DELETE') {
          const { expectedVersion } = await readJson(request);
          return json(response, 200, await session.remote.deleteSong(url.pathname.slice('/api/song/'.length), expectedVersion));
        }
        if (url.pathname === '/api/r2/config' && request.method === 'POST') {
          session.r2?.client.destroy();
          session.r2 = null;
          const candidate = makeR2Settings(await readJson(request));
          try {
            await verifyR2(candidate, session.remote);
          } catch (error) {
            candidate.client.destroy();
            throw error;
          }
          session.r2 = candidate;
          return json(response, 200, { ready: true, bucket: candidate.bucket, prefix: candidate.prefix });
        }
        if (url.pathname === '/api/r2/clear' && request.method === 'POST') {
          session.r2?.client.destroy();
          session.r2 = null;
          return json(response, 200, { ready: false });
        }
        if (url.pathname === '/api/logout' && request.method === 'POST') {
          await session.remote.logout().catch(() => {});
          session.r2?.client.destroy();
          sessions.delete(token);
          return json(response, 200, { ok: true }, {
            'Set-Cookie': 'ft_ingest=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
          });
        }
        const media = /^\/api\/media\/(audio|cover)\/([0-9a-f]{16})\.([a-z0-9]+)$/.exec(url.pathname);
        if (media && request.method === 'HEAD') {
          const [, kind, id, extension] = media;
          mediaType(kind, extension);
          const remote = await session.remote.mediaHead(kind, id, extension);
          if (remote.status === 404) { response.writeHead(204, { 'Cache-Control': 'no-store' }); return response.end(); }
          response.writeHead(remote.status, { 'Content-Length': remote.headers.get('content-length') || '0',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end();
        }
        if (media && request.method === 'PUT') {
          const [, kind, id, extension] = media;
          const contentType = mediaType(kind, extension);
          const length = Number(request.headers['content-length']);
          const mode = url.searchParams.get('mode') || 'worker';
          if (!Number.isSafeInteger(length) || length < 1 || length > 5 * 1024 ** 3) {
            throw new Error('媒体文件大小无效。');
          }
          if (mode === 'worker' && length > WORKER_MAX_BYTES) throw new Error('Worker 模式单文件不超过 100 MB。');
          if (mode === 'direct' && !session.r2) throw new Error('请先验证 R2 直传配置。');
          if (!['worker', 'direct'].includes(mode)) throw new Error('上传模式无效。');
          const body = await checkedStream(request, extension, length);
          const uploaded = mode === 'worker'
            ? await session.remote.uploadWorker(kind, id, extension, contentType, length, body)
            : await uploadDirect(session.r2, { kind, id, extension, contentType, length, body });
          return json(response, 200, uploaded);
        }
        return json(response, 404, { error: '接口不存在。' });
      }
      if (request.method !== 'GET') return json(response, 405, { error: '方法不支持。' });
      if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
      const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const path = resolve(join(staticDir, requested.slice(1)));
      const rel = relative(staticDir, path);
      if (rel.startsWith('..' + sep) || rel === '..' || rel.startsWith(sep)) return json(response, 404, { error: '页面不存在。' });
      const bytes = await readFile(path);
      const type = path.endsWith('.html') ? 'text/html; charset=utf-8'
        : path.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'" });
      return response.end(bytes);
    } catch (error) {
      return json(response, 400, { error: error?.message || '操作失败。' });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await createBatchIngestServer({ port: Number(process.env.FLARETUNE_INGEST_PORT || 14573) });
  process.stdout.write(`FlareTune 曲库工具：${url}\n`);
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
  catch { /* URL is printed above. */ }
}
