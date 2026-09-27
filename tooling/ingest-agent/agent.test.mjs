import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { startPreview } from '../dev/preview-worker.mjs';
import { RemoteCatalog } from '../batch-ingest/remote.mjs';
import { IngestAgent, configureAgent, readAgentConfig } from './agent.mjs';

const setupSecret = 'local-preview-only-claim-secret-not-for-deployment-2026';
const password = 'a private local test passphrase 2026';
const deviceId = 'd'.repeat(32);

test('one selected file travels from local Node to the existing catalog while another scanned file stays untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-agent-test-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  const preview = await startPreview({ ephemeral: true, seedEmpty: true,
    workerTestBindings: { SETUP_SECRET: setupSecret } });
  try {
    const mp3 = Uint8Array.of(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00);
    await writeFile(join(directory, 'selected.mp3'), mp3);
    await writeFile(join(directory, 'untouched.mp3'), mp3);
    const post = (path, body) => fetch(preview.origin + path, {
      method: 'POST', body: JSON.stringify(body), headers: {
        'Content-Type': 'application/json', Origin: preview.origin, 'X-Requested-With': 'FlareTune',
      },
    });
    const verified = await post('/api/auth/verify-setup', { setupSecret });
    assert.equal(verified.status, 200);
    const { proof } = await verified.json();
    assert.equal((await post('/api/auth/setup', { proof, username: 'owner', password })).status, 201);

    const configPath = join(directory, 'agent.json');
    const answers = ['测试设备', preview.origin, 'owner', password, directory];
    const configured = await configureAgent({ path: configPath,
      ask: async () => answers.shift(), print: () => {} });
    assert.equal(configured.roots[0], resolve(directory));
    assert.equal((await readAgentConfig(configPath)).password, password);

    const remote = new RemoteCatalog(preview.origin);
    await remote.login('owner', password);
    const originalJson = remote.json.bind(remote);
    let progressUpdates = 0;
    remote.json = async (path, options) => {
      if (path.endsWith('/progress') && options?.method === 'PUT') progressUpdates += 1;
      return originalJson(path, options);
    };
    const agent = new IngestAgent({ config: { deviceId, name: '测试设备', roots: [directory] },
      remote, log: () => {} });
    await agent.heartbeat();
    const files = await agent.scan();
    assert.equal(files.length, 2);
    const selected = files.find((file) => file.name === 'selected.mp3');
    const untouched = files.find((file) => file.name === 'untouched.mp3');
    assert.ok(selected && untouched);
    const list = await remote.json('/api/admin/ingest/devices');
    assert.equal(list.devices[0].name, '测试设备');
    const manifest = await remote.json(`/api/admin/ingest/devices/${deviceId}/manifest`);
    assert.equal(manifest.files.length, 2);
    const { job } = await remote.json(`/api/admin/ingest/devices/${deviceId}/jobs`, {
      method: 'POST', body: JSON.stringify({ kind: 'audio', fileId: selected.id }),
      headers: { 'Content-Type': 'application/json' },
    });
    const restarted = new IngestAgent({ config: { deviceId, name: '测试设备', roots: [directory] },
      remote, log: () => {} });
    const rescanned = await restarted.scan();
    assert.equal(rescanned.find((file) => file.name === 'selected.mp3')?.id, selected.id,
      'unchanged files must keep the same ID after a device process restart');
    await restarted.process(job);
    assert.ok(progressUpdates >= 1, 'the device must report transfer progress');
    const result = await remote.json(`/api/admin/ingest/devices/${deviceId}/jobs/${job.id}`);
    assert.equal(result.job.status, 'done', JSON.stringify(result));
    assert.match(result.job.url, /^\/media\/audio\/[a-f0-9]{16}\.mp3$/);
    assert.equal((await remote.mediaHead('audio', job.mediaId, 'mp3')).status, 200);
    const songId = 'agent-selected';
    await remote.createSong({ id: songId, title: basename(selected.name, '.mp3'),
      audio_url: result.job.url, artist: null, album: null, duration: null, cover_url: null,
      language: null });
    assert.equal((await remote.getSong(songId)).title, 'selected');
    assert.equal((await remote.json(`/api/admin/ingest/devices/${deviceId}/poll`)).jobs.length, 0);
    assert.ok(!(await remote.listSongs()).some((song) => song.title === 'untouched'));
    await remote.logout();
  } finally {
    await preview.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a transient upload connection failure reopens the file and keeps the same media ID', async () => {
  const mediaId = '1'.repeat(16);
  let opened = 0;
  let uploaded = 0;
  const folder = { media: async () => {
    opened += 1;
    return { extension: 'mp3', size: 8, body: new Uint8Array(8) };
  } };
  const remote = {
    mediaHead: async () => new Response(null, { status: 404 }),
    uploadWorker: async (_kind, id, _extension, _type, _size, _body, signal) => {
      assert.equal(id, mediaId);
      assert.ok(signal instanceof AbortSignal);
      uploaded += 1;
      if (uploaded === 1) throw new TypeError('fetch failed');
      return { url: `/media/audio/${id}.mp3` };
    },
  };
  const agent = new IngestAgent({ config: { deviceId, name: '测试设备', roots: ['D:/music'] },
    remote, delay: async () => {} });
  agent.fileFolders.set('file', folder);
  assert.equal(await agent.upload({ fileId: 'file', kind: 'audio', mediaId }),
    `/media/audio/${mediaId}.mp3`);
  assert.equal(opened, 2);
  assert.equal(uploaded, 2);
});

test('heartbeat continues during a long upload job', async () => {
  let beats = 0;
  const agent = new IngestAgent({
    config: { deviceId, name: '测试设备', roots: ['D:/music'] },
    remote: { json: async () => ({ jobs: [{ id: 'job' }] }) },
    heartbeatIntervalMs: 10, delay: async () => {}, log: () => {},
  });
  agent.scan = async () => [];
  agent.heartbeat = async () => { beats += 1; };
  agent.process = async () => {
    await new Promise((done) => setTimeout(done, 65));
    agent.stop();
  };
  await agent.start();
  assert.ok(beats >= 3, `only ${beats} heartbeats were sent`);
});

test('temporary poll transport failures retry without rescanning and report recovery once', async () => {
  let polls = 0;
  let scans = 0;
  const delays = [];
  const logs = [];
  let agent;
  const remote = { json: async (path) => {
    assert.match(path, /\/poll$/);
    polls += 1;
    if (polls <= 2) {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      throw error;
    }
    agent.stop();
    return { jobs: [] };
  } };
  agent = new IngestAgent({ config: { deviceId, name: '测试设备', roots: ['D:/music'] },
    remote, log: (message) => logs.push(message), delay: async (ms) => delays.push(ms) });
  agent.heartbeat = async () => {};
  agent.scan = async () => { scans += 1; return []; };
  await agent.start();
  assert.equal(scans, 1);
  assert.equal(polls, 3);
  assert.deepEqual(delays, [10_000, 10_000, 5_000]);
  assert.equal(logs.filter((message) => message.includes('不重新扫描')).length, 1);
  assert.ok(logs.some((message) => message.includes('ECONNRESET')));
  assert.equal(logs.filter((message) => message.includes('任务轮询已恢复')).length, 1);
});

test('a temporary post-scan heartbeat failure keeps the scanned device running', async () => {
  let heartbeats = 0;
  let scans = 0;
  let agent;
  const remote = { json: async (path) => {
    assert.match(path, /\/poll$/);
    agent.stop();
    return { jobs: [] };
  } };
  agent = new IngestAgent({ config: { deviceId, name: '测试设备', roots: ['D:/music'] },
    remote, log: () => {}, delay: async () => {} });
  agent.heartbeat = async () => {
    heartbeats += 1;
    if (heartbeats === 2) throw new TypeError('fetch failed');
  };
  agent.scan = async () => { scans += 1; return []; };
  await agent.start();
  assert.equal(heartbeats, 2);
  assert.equal(scans, 1);
});

test('a rejected poll still exits the connection loop for a fresh login', async () => {
  const agent = new IngestAgent({ config: { deviceId, name: '测试设备', roots: ['D:/music'] },
    remote: { json: async () => { throw new Error('管理员会话已失效'); } },
    delay: async () => {}, log: () => {} });
  agent.heartbeat = async () => {};
  agent.scan = async () => [];
  await assert.rejects(agent.start(), /管理员会话已失效/);
});
