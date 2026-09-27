// Local-only manual test instance. No Cloudflare credentials or data are used.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createBatchIngestServer } from './server.mjs';
import { ProfileStore } from './profiles.mjs';

const songs = [{ id: 'existing', title: '已有歌曲', artist: null, album: null,
  duration: 1, audio_url: '/media/audio/aaaaaaaaaaaaaaaa.wav',
  cover_url: '/media/cover/bbbbbbbbbbbbbbbb.jpg', language: 'zh', version: 'a'.repeat(64) }];
let versionCounter = 1;
const withVersion = (song) => ({ ...song, version: String(++versionCounter).padStart(64, '0') });
const media = new Map();
media.set('audio/aaaaaaaaaaaaaaaa.wav', Buffer.from('RIFFmockWAVE'));
media.set('cover/bbbbbbbbbbbbbbbb.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
let failNextUpload = process.env.FLARETUNE_MOCK_FAIL_FIRST_UPLOAD === '1';
let loseNextUploadReply = process.env.FLARETUNE_MOCK_LOSE_FIRST_UPLOAD_REPLY === '1';
let uploadAttempts = 0;
const mock = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const send = (status, data, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(data));
  };
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const { username, password } = JSON.parse(Buffer.concat(parts).toString());
    if (username !== 'demo' || password !== 'demo') return send(401, { error: 'invalid_credentials' });
    return send(200, { authenticated: true, user: { role: 'admin', username: 'demo', accountId: 'demo' },
      csrfToken: 'demo-csrf' }, { 'Set-Cookie': '__Host-ft_session=demo-session; Path=/; Secure; HttpOnly' });
  }
  if (request.headers.cookie !== '__Host-ft_session=demo-session') return send(401, { error: 'authentication_required' });
  if (url.pathname === '/__mock/stats' && request.method === 'GET') {
    return send(200, { uploadAttempts, mediaCount: media.size, songCount: songs.length });
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return send(200, { ok: true });
  if (url.pathname === '/api/admin/catalog/delete-preview' && request.method === 'POST') {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const { ids } = JSON.parse(Buffer.concat(parts).toString());
    const song = songs.find((item) => item.id === ids?.[0]);
    const data = { songs: song ? [song] : [], missing_ids: song ? [] : ids,
      affected_playlists: song ? [{ id: 'mock-list', name: '模拟歌单' }] : [],
      playlist_relations: song ? [{ playlist_id: 'mock-list', song_id: song.id }] : [],
      play_records: song ? [{ song_id: song.id, play_stats: 1, play_events: 2 }] : [],
      lyric_translations: song ? [{ song_id: song.id, count: 1 }] : [],
      media: song ? [
        { song_id: song.id, field: 'audio_url', path: 'audio/aaaaaaaaaaaaaaaa.wav', can_delete: true },
        { song_id: song.id, field: 'cover_url', path: 'cover/bbbbbbbbbbbbbbbb.jpg', can_delete: true },
      ] : [], impact_digest: 'a'.repeat(64) };
    return send(200, { code: 200, data });
  }
  if (url.pathname === '/api/admin/catalog/delete' && request.method === 'POST') {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const { ids, delete_media: deleteMedia, impact_digest: digest } = JSON.parse(Buffer.concat(parts).toString());
    if (digest !== 'a'.repeat(64)) return send(409, { code: 409, message: 'Deletion impact changed' });
    const index = songs.findIndex((item) => item.id === ids?.[0]);
    if (index < 0) return send(200, { code: 200, data: { deleted_ids: [], media: { deleted: [], failures: [] } } });
    const [song] = songs.splice(index, 1);
    const deleted = [];
    if (deleteMedia) for (const path of [song.audio_url, song.cover_url]) {
      const key = path.slice('/media/'.length);
      media.delete(key);
      deleted.push({ path: key });
    }
    return send(200, { code: 200, data: { deleted_ids: [song.id], media: { deleted, failures: [] },
      lyric_cleanup: { pending_song_ids: [] } } });
  }
  if (url.pathname === '/api/admin/catalog/songs' && request.method === 'GET') {
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 100);
    return send(200, { ok: true, data: { songs: songs.slice((page - 1) * limit, page * limit), total: songs.length } });
  }
  if (url.pathname.startsWith('/api/admin/catalog/songs/') && request.method === 'GET') {
    const song = songs.find((item) => item.id === url.pathname.split('/').at(-1));
    return song ? send(200, { ok: true, data: { song } }) : send(404, { error: 'SONG_NOT_FOUND' });
  }
  if (url.pathname.startsWith('/api/admin/catalog/songs/') && ['PUT', 'DELETE'].includes(request.method)) {
    const id = url.pathname.split('/').at(-1);
    const index = songs.findIndex((item) => item.id === id);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (index < 0) return send(404, { ok: false, message: '歌曲不存在' });
    if (body.expectedVersion !== songs[index].version) return send(409, { ok: false, message: '歌曲已被修改' });
    if (request.method === 'DELETE') {
      songs.splice(index, 1);
      return send(200, { ok: true, data: { deletedSongId: id, mediaRetained: true } });
    }
    const updated = withVersion({ ...songs[index], ...body });
    delete updated.expectedVersion;
    songs[index] = updated;
    return send(200, { ok: true, data: { song: updated } });
  }
  if (url.pathname === '/api/admin/catalog/songs' && request.method === 'POST') {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const song = JSON.parse(Buffer.concat(parts).toString());
    if (songs.some((item) => item.id === song.id)) return send(409, { error: 'SONG_EXISTS' });
    const created = withVersion(song);
    songs.push(created);
    return send(201, { ok: true, data: { song: created } });
  }
  const upload = /^\/api\/admin\/catalog\/media\/(audio|cover)\/([0-9a-f]{16})\.([a-z0-9]+)$/.exec(url.pathname);
  if (upload && request.method === 'PUT') {
    uploadAttempts += 1;
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    if (failNextUpload) {
      failNextUpload = false;
      return send(503, { ok: false, message: '模拟首首上传失败' });
    }
    media.set(`${upload[1]}/${upload[2]}.${upload[3]}`, Buffer.concat(parts));
    if (loseNextUploadReply) {
      loseNextUploadReply = false;
      return send(503, { ok: false, message: '模拟上传成功但回执丢失' });
    }
    return send(201, { ok: true, data: { url: `/media/${upload[1]}/${upload[2]}.${upload[3]}` } });
  }
  if (url.pathname.startsWith('/media/') && request.method === 'HEAD') {
    const body = media.get(url.pathname.slice('/media/'.length));
    response.writeHead(body ? 200 : 404, body ? { 'Content-Length': String(body.length) } : {});
    return response.end();
  }
  return send(404, { error: 'NOT_FOUND' });
});
await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const mockR2 = process.env.FLARETUNE_MOCK_R2 === '1';
const vaultSecrets = new Map();
const profileStore = new ProfileStore({ path: fileURLToPath(new URL(`../../output/playwright/mock-profiles-${process.pid}.json`, import.meta.url)),
  vault: { get: async ({ name }) => vaultSecrets.get(name) || null,
    set: async ({ name, value }) => { vaultSecrets.set(name, value); },
    delete: async ({ name }) => { vaultSecrets.delete(name); } } });
const tool = await createBatchIngestServer(mockR2 ? {
  profileStore,
  makeR2Settings: ({ bucket, prefix }) => ({ bucket, prefix, client: { destroy() {} } }),
  verifyR2: async (config) => { if (config.bucket === 'wrong') throw new Error('模拟目标不匹配'); },
  uploadDirect: async (_config, { kind, id, extension, body, length }) => {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== length) throw new Error('媒体大小不一致');
    media.set(`${kind}/${id}.${extension}`, bytes);
    return { url: `/media/${kind}/${id}.${extension}` };
  },
} : { profileStore });
process.stdout.write(`测试实例：http://127.0.0.1:${mock.address().port}\n`);
process.stdout.write(`批量工具：${tool.url}\n测试账号：demo / demo\n`);
