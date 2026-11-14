import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { bundleWorkerModules } from '../dev/bundle-worker-modules.mjs';
import { sealYouTubeConnection, YOUTUBE_CONNECTION_KEY } from '../../server/src/plugins/youtubeConnection.js';
import { credentialScope } from '../../server/src/plugins/youtube/upstream.mjs';
import { PROFILE } from '../../server/src/plugins/youtube/player.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const id = 'QBtVFL0Qefs';
const SETUP_SECRET = 'synthetic-youtube-runtime-actor-setup-secret-2026';
const credentials = { clientId: 'runtime-actor-client-id', clientSecret: 'runtime-actor-client-secret', refreshToken: 'runtime-actor-refresh-token' };

test('real private SQLite actor reads encrypted binding, proxies ranges/HEAD and retires a changed generation', { timeout: 30000 }, async () => {
  const temporaryRoot = resolve(root, '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(resolve(temporaryRoot, 'youtube-runtime-actor-'));
  const actorPath = relative(directory, resolve(root, 'server/src/plugins/youtube/runtime-actor.mjs')).split(sep).join('/');
  const entryPoint = resolve(directory, 'worker.mjs');
  const installationEpoch = crypto.randomUUID(), bindingId = crypto.randomUUID(), epoch = installationEpoch + ':' + bindingId;
  const media = Uint8Array.from({ length: 16 }, (_, index) => index);
  let mf, mediaRequests = 0, anonymousRequests = 0, releaseThird;
  let thirdMediaReached;
  const thirdMedia = new Promise(resolve => { thirdMediaReached = resolve; });
  const continueThird = new Promise(resolve => { releaseThird = resolve; });
  try {
    await writeFile(entryPoint, `export {YouTubeRuntime} from ${JSON.stringify(actorPath)};
export default {fetch(request,env){const epoch=request.headers.get('X-FlareTune-YT-Epoch')||'missing';
const stub=env.YTM_RUNTIME.get(env.YTM_RUNTIME.idFromName('youtube:'+epoch));return stub.fetch(request);}};`);
    const bundled = await bundleWorkerModules({ esbuild, entryPoint });
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'youtube-runtime-actor-test', ...bundled,
      compatibilityDate: '2026-09-23', d1Databases: ['DB'], kvNamespaces: ['YTM_KV'], bindings: { SETUP_SECRET },
      durableObjects: { YTM_RUNTIME: { className: 'YouTubeRuntime', useSQLite: true } },
      async outboundService(request) {
        const url = new URL(request.url);
        for (const key of ['Cookie', 'Authorization', 'X-FlareTune-YT-Epoch', 'X-API-Key']) assert.equal(request.headers.has(key), false);
        if (url.hostname === 'www.youtube.com' && url.pathname === '/oembed') {
          anonymousRequests++;
          assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=' + id);
          return Response.json({ version: '1.0', type: 'video', provider_name: 'YouTube', provider_url: 'https://www.youtube.com/',
            title: 'Public music fixture', author_name: 'Fixture singer', author_url: 'https://www.youtube.com/channel/UCfixture',
            html: '<iframe src="https://www.youtube.com/embed/' + id + '?feature=oembed"></iframe>' });
        }
        if (url.hostname === 'rr.googlevideo.com' && url.pathname === '/actor-fixture') {
          mediaRequests++;
          if (mediaRequests === 3) { thirdMediaReached(); await continueThird; }
          const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range') || '');
          assert.ok(match); assert.equal(request.headers.get('If-Range'), 'fixture-etag');
          const start = Number(match[1]), end = Number(match[2]);
          return new Response(request.method === 'HEAD' ? null : media.slice(start, end + 1), { status: 206,
            headers: { 'Content-Type': 'audio/webm', 'Content-Range': `bytes ${start}-${end}/${media.length}`,
              'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
        }
        throw new Error('TEST_OUTBOUND_BLOCKED');
      } }] }));
    const { DB, YTM_KV } = await mf.getBindings('youtube-runtime-actor-test');
    await DB.prepare('CREATE TABLE instance_settings (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER,updated_by TEXT)').run();
    await DB.prepare('INSERT INTO instance_settings(key,value_json,revision) VALUES (?,?,1)')
      .bind('plugin.installation.youtube-music', JSON.stringify({ installed: true, epoch: installationEpoch })).run();
    const saveBinding = async currentBindingId => {
      const encrypted = await sealYouTubeConnection({ SETUP_SECRET }, { installationEpoch,
        binding: { id: currentBindingId, connectedAt: Date.now(), credentials } });
      await DB.prepare('INSERT INTO instance_settings(key,value_json,revision) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1')
        .bind(YOUTUBE_CONNECTION_KEY, JSON.stringify({ encrypted })).run();
    };
    await saveBinding(bindingId);
    await YTM_KV.put(`yt:stream:${await credentialScope(credentials, epoch)}:${PROFILE}:${id}`, JSON.stringify({ id,
      expiresAt: Date.now() + 3600000, formats: [{ itag: 774, url: 'https://rr.googlevideo.com/actor-fixture',
        mime_type: 'audio/webm; codecs="opus"', bitrate: 256000, has_audio: true, has_video: false }] }));
    const options = method => ({ method, headers: { 'X-FlareTune-YT-Epoch': epoch, Range: 'bytes=2-5', 'If-Range': 'fixture-etag',
      'User-Agent': 'Fixture browser', Cookie: 'private-browser-cookie', Authorization: 'Bearer private-browser-token' } });
    const streamed = await mf.dispatchFetch('https://private-actor.test/audio/' + id + '?codec=opus', options('GET'));
    assert.equal(streamed.status, 206, await streamed.clone().text());
    assert.equal(streamed.headers.get('Content-Range'), 'bytes 2-5/16');
    assert.equal(streamed.headers.get('Accept-Ranges'), 'bytes');
    assert.deepEqual(new Uint8Array(await streamed.arrayBuffer()), media.slice(2, 6));
    const head = await mf.dispatchFetch('https://private-actor.test/audio/' + id, options('HEAD'));
    assert.equal(head.status, 206); assert.equal(head.headers.get('Content-Length'), '4'); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await mf.dispatchFetch('https://private-actor.test/audio/' + id)).status, 403);
    assert.equal((await mf.dispatchFetch('https://private-actor.test/audio/' + id + '?url=https://invalid.test/', options('GET'))).status, 400);
    assert.equal((await mf.dispatchFetch('https://private-actor.test/audio/' + id, options('POST'))).status, 405);
    assert.equal(mediaRequests, 2); assert.equal(anonymousRequests, 1);
    const racing = mf.dispatchFetch('https://private-actor.test/audio/' + id, options('GET'));
    await thirdMedia;
    await saveBinding(crypto.randomUUID());
    releaseThird();
    const retired = await racing;
    assert.equal(retired.status, 409); assert.deepEqual(await retired.json(), { error: 'YOUTUBE_CONNECTION_CHANGED' });
    const stale = await mf.dispatchFetch('https://private-actor.test/audio/' + id, options('GET'));
    assert.equal(stale.status, 403); assert.equal(mediaRequests, 3);
  } finally {
    releaseThird();
    if (mf) await mf.dispose();
    assert.equal(dirname(directory), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  }
});
