import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Transform } from 'node:stream';
import { RemoteCatalog } from '../batch-ingest/remote.mjs';
import { LocalFolder } from '../batch-ingest/localFolder.mjs';
import { mediaType, targetUrl } from '../batch-ingest/core.mjs';
import { openIngestHistory } from './history.mjs';

const API = '/api/admin/ingest/devices';
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const isTransportFailure = (error) => error instanceof TypeError && error.message === 'fetch failed';
const connectionError = (error) => {
  const causes = [error?.cause, ...(error?.cause?.errors || [])];
  const codes = [...new Set(causes.map((cause) => cause?.code).filter(Boolean))];
  return `${error.message}${codes.length ? ` (${codes.join(', ')})` : ''}`;
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
    throw new Error('Invalid ingest device configuration. Run the configure command again.');
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
    const name = (await ask('Device name: ')).trim().slice(0, 80);
    const baseUrl = targetUrl((await ask('Instance URL: ')).trim());
    const username = (await ask('Administrator username: ')).trim();
    const password = await ask('Administrator password: ');
    const roots = (await ask('Local music folders (separate multiple paths with ;): ')).split(';').map((part) => part.trim()).filter(Boolean);
    if (!name || !username || !password || !roots.length || roots.length > 16) throw new Error('Enter a device name, account, password, and 1–16 music folders.');
    const resolvedRoots = [];
    for (const root of roots) {
      if (!isAbsolute(root) || !(await stat(root)).isDirectory()) throw new Error(`Invalid music folder: ${root}`);
      resolvedRoots.push(resolve(root));
    }
    const remote = new RemoteCatalog(baseUrl);
    await remote.login(username, password);
    await remote.logout().catch(() => {});
    const old = await readAgentConfig(path).catch(() => null);
    const config = { deviceId: old?.deviceId || randomBytes(16).toString('hex'), name,
      baseUrl, username, password, roots: [...new Set(resolvedRoots)] };
    await writeConfig(path, config);
    print(`Configured ${name} · ${baseUrl} · ${config.roots.length} folders. Run npm run ingest to start.`);
    return config;
  } finally { input?.close(); }
}

export class IngestAgent {
  constructor({ config, remote, history = null, log = console.log, delay = wait, heartbeatIntervalMs = 20_000 } = {}) {
    this.config = config;
    this.remote = remote;
    this.history = history;
    this.manifest = [];
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
        files.push({ ...file, rootIndex: index, rootLabel: basename(this.config.roots[index]),
          localLocation: resolve(this.config.roots[index], file.path.split('/').slice(1).join('/')) });
        fileFolders.set(file.id, this.folders[index]);
      }
    }
    this.history?.observe(files);
    if (this.history) {
      try { this.history.reconcile(await this.remote.listSongs()); }
      catch (error) { this.log(`Catalog history check failed: ${connectionError(error)}. The admin page will check again.`); }
    }
    this.manifest = files;
    await this.publishManifest();
    this.fileFolders = fileFolders;
    this.log(`Scanned ${files.length} audio files.`);
    return this.history ? this.history.filesWithHistory(files) : files.map(({ localLocation, ...file }) => file);
  }
  async publishManifest(preserveScanTime = false) {
    const files = this.history ? this.history.filesWithHistory(this.manifest)
      : this.manifest.map(({ localLocation, ...file }) => file);
    await this.remote.json(this.path('/manifest'), { method: 'PUT',
      body: JSON.stringify({ files, preserveScanTime }), headers: { 'Content-Type': 'application/json' } });
  }
  async upload(job) {
    const folder = this.fileFolders.get(job.fileId);
    if (!folder) throw new Error('The file reference has expired. Refresh the scan in the admin page.');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const media = await folder.media(job.fileId, job.kind);
      if (!Number.isSafeInteger(media.size) || media.size < 1) {
        media.body.destroy?.();
        throw new Error('The media file has an invalid size. Scan again.');
      }
      let stage = 'media check';
      let progressWrites = Promise.resolve();
      let progressBody = media.body;
      try {
        const existing = await this.remote.mediaHead(job.kind, job.mediaId, media.extension);
        if (existing.status === 200) {
          if (Number(existing.headers.get('Content-Length')) !== media.size) throw new Error('The remote media ID belongs to a file with a different size.');
          return `/media/${job.kind}/${job.mediaId}.${media.extension}`;
        }
        if (existing.status !== 404) throw new Error(`Media verification failed (${existing.status}).`);
        stage = 'media upload';
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
                  if (!progressErrorLogged) this.log(`Transfer progress is temporarily unavailable: ${error.message}`);
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
        this.log(`${job.kind} ${stage} failed (attempt ${attempt + 1}, ${media.size} bytes): ${error.cause?.message || error.message}`);
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
      message = error.cause?.message || error.message || 'Device operation failed.';
    }
    // Persist even if the final job receipt is lost. The same pending job can be
    // recovered via its fixed media ID; media success is not catalog success.
    this.history?.record(job, { status, url, message });
    await this.remote.json(this.path(`/jobs/${job.id}`), { method: 'PUT',
      body: JSON.stringify({ status, url, message }), headers: { 'Content-Type': 'application/json' } });
    if (this.history && job.kind !== 'refresh') {
      await this.publishManifest(true).catch((error) => this.log(`History refresh failed: ${connectionError(error)}`));
    }
    if (status === 'error') this.log(`Job ${job.id} failed: ${message}`);
  }
  async start() {
    await this.heartbeat();
    await this.scan();
    let heartbeatUnavailable = false;
    try { await this.heartbeat(); }
    catch (error) {
      if (!isTransportFailure(error)) throw error;
      heartbeatUnavailable = true;
      this.log(`Device heartbeat failed after the scan: ${connectionError(error)}. Scheduled heartbeats will retry.`);
    }
    if (!heartbeatUnavailable) this.log(`Device "${this.config.name}" is connected. Folder songs are available in the admin page.`);
    let heartbeatBusy = false;
    const heartbeatTimer = setInterval(() => {
      if (this.stopped || heartbeatBusy) return;
      heartbeatBusy = true;
      void this.heartbeat().then(() => {
        if (heartbeatUnavailable) this.log(`Device "${this.config.name}" heartbeat recovered.`);
        heartbeatUnavailable = false;
      }).catch((error) => {
        if (!heartbeatUnavailable) this.log(`Device heartbeat failed: ${connectionError(error)}`);
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
          if (!pollUnavailable) this.log(`Job polling failed: ${connectionError(error)}. Retrying in 10 seconds without rescanning.`);
          pollUnavailable = true;
          await this.delay(10_000);
          continue;
        }
        if (pollUnavailable) this.log('Job polling recovered.');
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
      if (agent.historyAccount !== remote.account.accountId) {
        agent.history?.close();
        agent.history = null;
        try {
          agent.history = await openIngestHistory(join(dirname(path), 'ingest-history.sqlite'),
            config.baseUrl, remote.account.accountId, config.deviceId);
          agent.historyAccount = remote.account.accountId;
        } catch (error) { error.code = 'INGEST_HISTORY_ERROR'; throw error; }
      }
      await agent.start();
      break;
    }
    catch (error) {
      if (error.code === 'INGEST_HISTORY_ERROR') {
        await remote.logout().catch(() => {});
        throw error;
      }
      if (agent.stopped) break;
      console.error('Device connection failed: ' + connectionError(error) + '. Retrying in 10 seconds.');
      await wait(10_000);
    }
  }
  await remote.logout().catch(() => {});
  agent.history?.close();
}
