import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Transform } from 'node:stream';
import { RemoteCatalog } from '../batch-ingest/remote.mjs';
import { LocalFolder } from '../batch-ingest/localFolder.mjs';
import { mediaType, targetUrl } from '../batch-ingest/core.mjs';

const API = '/api/admin/ingest/devices';
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const isTransportFailure = (error) => error instanceof TypeError && error.message === 'fetch failed';
const connectionError = (error) => {
  const causes = [error?.cause, ...(error?.cause?.errors || [])];
  const codes = [...new Set(causes.map((cause) => cause?.code).filter(Boolean))];
  return `${error.message}${codes.length ? `（${codes.join('、')}）` : ''}`;
};
export function defaultAgentPath() {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'FlareTune', 'ingest-agent.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'FlareTune', 'ingest-agent.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'flaretune', 'ingest-agent.json');
}
export async function readAgentConfig(path = defaultAgentPath()) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!/^[a-f0-9]{32}$/.test(config.deviceId || '') || !Array.isArray(config.roots)
    || !config.roots.length || !config.name || !config.username || !config.password) {
    throw new Error('入库设备配置无效，请重新运行配置命令。');
  }
  config.baseUrl = targetUrl(config.baseUrl);
  return config;
}
async function writeConfig(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export async function configureAgent({ path = defaultAgentPath(), ask, print = console.log } = {}) {
  let input;
  if (!ask) {
    input = createInterface({ input: process.stdin, output: process.stdout });
    ask = (prompt) => input.question(prompt);
  }
  try {
    const name = (await ask('当前设备名称：')).trim().slice(0, 80);
    const baseUrl = targetUrl((await ask('实例地址：')).trim());
    const username = (await ask('管理员用户名：')).trim();
    const password = await ask('管理员密码：');
    const roots = (await ask('本地音乐目录（多个用 ; 分隔）：')).split(';').map((part) => part.trim()).filter(Boolean);
    if (!name || !username || !password || !roots.length || roots.length > 16) throw new Error('请填写设备名称、账号、密码和 1～16 个音乐目录。');
    const resolvedRoots = [];
    for (const root of roots) {
      if (!isAbsolute(root) || !(await stat(root)).isDirectory()) throw new Error(`音乐目录无效：${root}`);
      resolvedRoots.push(resolve(root));
    }
    const remote = new RemoteCatalog(baseUrl);
    await remote.login(username, password);
    await remote.logout().catch(() => {});
    const old = await readAgentConfig(path).catch(() => null);
    const config = { deviceId: old?.deviceId || randomBytes(16).toString('hex'), name,
      baseUrl, username, password, roots: [...new Set(resolvedRoots)] };
    await writeConfig(path, config);
    print(`配置完成：${name} · ${baseUrl} · ${config.roots.length} 个目录。运行 npm run ingest 启动。`);
    return config;
  } finally { input?.close(); }
}

export class IngestAgent {
  constructor({ config, remote, log = console.log, delay = wait, heartbeatIntervalMs = 20_000 } = {}) {
    this.config = config;
    this.remote = remote;
    this.log = log;
    this.delay = delay;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.folders = config.roots.map(() => new LocalFolder());
    this.fileFolders = new Map();
    this.stopped = false;
  }
  path(suffix = '') { return `${API}/${this.config.deviceId}${suffix}`; }
  async heartbeat() {
    return this.remote.json(this.path('/heartbeat'), { method: 'POST',
      body: JSON.stringify({ name: this.config.name, roots: this.config.roots.map((root) => basename(root)) }),
      headers: { 'Content-Type': 'application/json' } });
  }
  async scan() {
    const files = [];
    const fileFolders = new Map();
    for (let index = 0; index < this.folders.length; index += 1) {
      const result = await this.folders[index].scan(this.config.roots[index]);
      for (const file of result.files) {
        files.push({ ...file, rootIndex: index, rootLabel: basename(this.config.roots[index]) });
        fileFolders.set(file.id, this.folders[index]);
      }
    }
    await this.remote.json(this.path('/manifest'), { method: 'PUT',
      body: JSON.stringify({ files }), headers: { 'Content-Type': 'application/json' } });
    this.fileFolders = fileFolders;
    this.log(`已扫描 ${files.length} 首音频。`);
    return files;
  }
  async upload(job) {
    const folder = this.fileFolders.get(job.fileId);
    if (!folder) throw new Error('文件引用已失效，请在后台刷新扫描。');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const media = await folder.media(job.fileId, job.kind);
      if (!Number.isSafeInteger(media.size) || media.size < 1) {
        media.body.destroy?.();
        throw new Error('读取到的媒体文件大小无效，请重新扫描。');
      }
      let stage = '媒体检查';
      let progressWrites = Promise.resolve();
      let progressBody = media.body;
      try {
        const existing = await this.remote.mediaHead(job.kind, job.mediaId, media.extension);
        if (existing.status === 200) {
          if (Number(existing.headers.get('Content-Length')) !== media.size) throw new Error('远端媒体 ID 已被不同大小的文件占用。');
          return `/media/${job.kind}/${job.mediaId}.${media.extension}`;
        }
        if (existing.status !== 404) throw new Error(`媒体读回失败（${existing.status}）。`);
        stage = '媒体上传';
        if (typeof media.body.pipe === 'function') {
          let loaded = 0;
          let lastReported = 0;
          let progressErrorLogged = false;
          progressBody = media.body.pipe(new Transform({
            transform: (chunk, _encoding, done) => {
              loaded += chunk.byteLength;
              if (loaded - lastReported >= 1_000_000 || loaded === media.size) {
                const reportLoaded = loaded;
                lastReported = reportLoaded;
                progressWrites = progressWrites.then(() => this.remote.json(this.path(`/jobs/${job.id}/progress`), {
                  method: 'PUT', body: JSON.stringify({ loaded: reportLoaded, total: media.size }),
                  headers: { 'Content-Type': 'application/json' },
                })).catch((error) => {
                  if (!progressErrorLogged) this.log(`传输进度暂不可用：${error.message}`);
                  progressErrorLogged = true;
                });
              }
              done(null, chunk);
            },
          }));
        }
        const uploaded = await this.remote.uploadWorker(job.kind, job.mediaId, media.extension,
          mediaType(job.kind, media.extension), media.size, progressBody, AbortSignal.timeout(120_000));
        await progressWrites;
        return uploaded.url;
      } catch (error) {
        this.log(`${job.kind} ${stage}失败（第 ${attempt + 1} 次，${media.size} 字节）：${error.cause?.message || error.message}`);
        const confirmed = await this.remote.mediaHead(job.kind, job.mediaId, media.extension).catch(() => null);
        if (confirmed?.status === 200 && Number(confirmed.headers.get('Content-Length')) === media.size) {
          return `/media/${job.kind}/${job.mediaId}.${media.extension}`;
        }
        if (attempt === 0 && error instanceof TypeError && error.message === 'fetch failed') {
          await this.delay(350);
          continue;
        }
        throw error;
      } finally {
        media.body.destroy?.();
        if (progressBody !== media.body) progressBody.destroy?.();
      }
    }
  }
  async process(job) {
    let status = 'done', url = null, message = '';
    try {
      if (job.kind === 'refresh') await this.scan();
      else url = await this.upload(job);
    } catch (error) {
      status = 'error';
      message = error.cause?.message || error.message || '设备操作失败。';
    }
    await this.remote.json(this.path(`/jobs/${job.id}`), { method: 'PUT',
      body: JSON.stringify({ status, url, message }), headers: { 'Content-Type': 'application/json' } });
    if (status === 'error') this.log(`任务 ${job.id} 失败：${message}`);
  }
  async start() {
    await this.heartbeat();
    await this.scan();
    let heartbeatUnavailable = false;
    try { await this.heartbeat(); }
    catch (error) {
      if (!isTransportFailure(error)) throw error;
      heartbeatUnavailable = true;
      this.log(`扫描后的设备心跳暂时失败：${connectionError(error)}；定时心跳会继续重试。`);
    }
    if (!heartbeatUnavailable) this.log(`设备“${this.config.name}”已连接；后台可以选择目录歌曲。`);
    let heartbeatBusy = false;
    const heartbeatTimer = setInterval(() => {
      if (this.stopped || heartbeatBusy) return;
      heartbeatBusy = true;
      void this.heartbeat().then(() => {
        if (heartbeatUnavailable) this.log(`设备“${this.config.name}”心跳已恢复。`);
        heartbeatUnavailable = false;
      }).catch((error) => {
        if (!heartbeatUnavailable) this.log(`设备心跳失败：${connectionError(error)}`);
        heartbeatUnavailable = true;
      })
        .finally(() => { heartbeatBusy = false; });
    }, this.heartbeatIntervalMs);
    let pollUnavailable = false;
    try {
      while (!this.stopped) {
        let jobs;
        try { ({ jobs = [] } = await this.remote.json(this.path('/poll'))); }
        catch (error) {
          if (!isTransportFailure(error)) throw error;
          if (!pollUnavailable) this.log(`任务轮询暂时失败：${connectionError(error)}；10 秒后重试，不重新扫描。`);
          pollUnavailable = true;
          await this.delay(10_000);
          continue;
        }
        if (pollUnavailable) this.log('任务轮询已恢复。');
        pollUnavailable = false;
        for (const job of jobs) {
          if (this.stopped) break;
          await this.process(job);
        }
        await this.delay(5_000);
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
  stop() { this.stopped = true; }
}

export async function startConfiguredAgent({ path = defaultAgentPath() } = {}) {
  const config = await readAgentConfig(path);
  const remote = new RemoteCatalog(config.baseUrl);
  const agent = new IngestAgent({ config, remote });
  process.once('SIGINT', () => agent.stop());
  process.once('SIGTERM', () => agent.stop());
  for (;;) {
    try {
      await remote.login(config.username, config.password);
      await agent.start();
      break;
    }
    catch (error) {
      if (agent.stopped) break;
      console.error('设备连接失败：' + connectionError(error) + '；10 秒后重试。');
      await wait(10_000);
    }
  }
  await remote.logout().catch(() => {});
}
