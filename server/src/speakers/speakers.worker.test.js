import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hashPassword } from '../auth/local/crypto.js';
import { MIGRATION_BUNDLE } from '../instance/migrationBundle.generated.js';
import { CURRENT_SCHEMA_VERSION, KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';
import { bundleWorkerModules } from '../../../tooling/dev/bundle-worker-modules.mjs';

const ORIGIN = 'https://speaker-worker.test';
const PASSWORD = 'synthetic-speaker-worker-password';
const SETUP_SECRET = 'synthetic-speaker-worker-setup-secret-at-least-32-bytes';
const OWNER = 'speaker-worker-owner';
const SONG = 'speaker-worker-song';
const OBJECT_KEY = 'media/audio/speaker-worker.mp3';
const AUDIO = Uint8Array.from({ length: 256 }, (_, i) => i);
const XIAOMI_USER = '987654321';
const PASS_TOKEN = 'fixture-pass-token';
const MIJIA_TOKEN = 'fixture-mijia-token';
const MICO_TOKEN = 'fixture-micoapi-token';
const NONCE = '9223372036854775807';
const SSECURITY = 'fixture-signing-material';
const XIAOMI_BUILD = pluginBuilds.find(build => build.id === 'xiaomi-speaker').sourceDigest;
const pluginSummary = ({ id, version, installed, revision }) => ({ id, version, installed, revision });

function upstreamJson(value, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { headers });
}

function syntheticXiaomi() {
  const calls = [];
  const commands = [];
  const audioUrls = [];
  let playback = { audioId: null, status: 0, position: 0, volume: 35 };
  return {
    calls, commands, audioUrls,
    // Miniflare installs this as the only outbound network service. Every
    // unmatched request fails locally; this fixture never delegates to fetch.
    async outboundService(request) {
      const url = new URL(request.url);
      const cookie = request.headers.get('Cookie') || '';
      calls.push({ host: url.hostname, path: url.pathname });
      assert.equal(url.protocol, 'https:');
      if (url.hostname === 'account.xiaomi.com' && url.pathname === '/pass/serviceLogin') {
        assert.equal(request.method, 'GET');
        if (url.searchParams.get('sid') === 'mijia') {
          assert.doesNotMatch(cookie, /passToken=|serviceToken=/);
          return upstreamJson({ _sign: 'fixture-sign', qs: 'fixture-query', callback: 'https://account.xiaomi.com/callback' }, [
            'qrSession=fixture-qr-session; Domain=.xiaomi.com; Path=/; Secure',
            `serviceToken=${MIJIA_TOKEN}; Domain=.xiaomi.com; Path=/; Secure`,
          ]);
        }
        assert.equal(url.searchParams.get('sid'), 'micoapi');
        assert.match(cookie, new RegExp(`userId=${XIAOMI_USER}`));
        assert.match(cookie, new RegExp(`passToken=${PASS_TOKEN}`));
        assert.doesNotMatch(cookie, /qrSession=|fixture-mijia-token/);
        return upstreamJson(`&&&START&&&{"code":0,"userId":"${XIAOMI_USER}","nonce":${NONCE},"ssecurity":"${SSECURITY}","location":"https://api.mina.mi.com/sts?fixture=1"}`);
      }
      if (url.hostname === 'account.xiaomi.com' && url.pathname === '/longPolling/loginUrl') {
        assert.equal(url.searchParams.get('sid'), 'mijia');
        assert.match(cookie, /qrSession=fixture-qr-session/);
        return upstreamJson({ lp: 'https://c3.lp.account.xiaomi.com/longPolling/await?fixture=1', qr: 'https://account.xiaomi.com/longPolling/qr?fixture=1' });
      }
      if (url.hostname === 'account.xiaomi.com' && url.pathname === '/longPolling/qr') {
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'Content-Type': 'image/png' } });
      }
      if (url.hostname === 'c3.lp.account.xiaomi.com' && url.pathname === '/longPolling/await') {
        assert.match(cookie, /qrSession=fixture-qr-session/);
        assert.match(cookie, new RegExp(`serviceToken=${MIJIA_TOKEN}`));
        return upstreamJson({ code: 0, userId: XIAOMI_USER, passToken: PASS_TOKEN });
      }
      if (url.hostname === 'api.mina.mi.com' && url.pathname === '/sts') {
        assert.equal(url.searchParams.get('clientSign'), createHash('sha1').update(`nonce=${NONCE}&${SSECURITY}`).digest('base64'));
        assert.doesNotMatch(cookie, /passToken=|userId=|fixture-mijia-token/);
        return new Response('', { status: 302, headers: {
          Location: 'https://api2.mina.mi.com/sts/finish',
          'Set-Cookie': 'bridge=fixture-bridge; Domain=.mi.com; Path=/; Secure',
        } });
      }
      if (url.hostname === 'api2.mina.mi.com' && url.pathname === '/sts/finish') {
        assert.equal(cookie, 'bridge=fixture-bridge');
        return upstreamJson({}, [`serviceToken=${MICO_TOKEN}; Domain=.mi.com; Path=/; Secure`]);
      }
      if (url.hostname === 'api2.mina.mi.com') {
        assert.match(cookie, new RegExp(`userId=${XIAOMI_USER}`));
        assert.match(cookie, new RegExp(`serviceToken=${MICO_TOKEN}`));
        assert.doesNotMatch(cookie, /passToken=|qrSession=|fixture-mijia-token/);
        if (url.pathname === '/admin/v2/device_list') {
          assert.equal(request.method, 'GET');
          assert.equal(url.searchParams.get('master'), '0');
          return upstreamJson({ code: 0, data: [{ deviceID: 'fixture-mina-device', name: 'Fixture speaker', hardware: 'L05B' }] });
        }
        if (url.pathname === '/remote/ubus') {
          assert.equal(request.method, 'POST');
          const form = new URLSearchParams(await request.text());
          assert.equal(form.get('deviceId'), 'fixture-mina-device');
          assert.equal(form.get('path'), 'mediaplayer');
          const message = JSON.parse(form.get('message'));
          if (form.get('method') === 'player_get_play_status') {
            return upstreamJson({ code: 0, data: { code: 0, info: JSON.stringify({
              status: playback.status, volume: playback.volume,
              play_song_detail: { audio_id: playback.audioId, position: playback.position, duration: 15000, url: 'private-upstream-field' },
            }) } });
          }
          commands.push(form.get('method'));
          if (form.get('method') === 'player_play_music') {
            const music = JSON.parse(message.music);
            assert.equal(music.play_behavior, 'REPLACE_ALL');
            assert.equal(music.payload.audio_items.length, 1);
            const mediaUrl = new URL(music.payload.audio_items[0].stream.url);
            assert.equal(mediaUrl.origin, ORIGIN);
            assert.equal(mediaUrl.pathname, '/speaker-media/audio.mp3');
            assert.ok(mediaUrl.searchParams.get('ticket'));
            audioUrls.push(mediaUrl.href);
            playback = { ...playback, audioId: message.startaudioid, position: message.startOffset || 0, status: 1 };
          } else if (form.get('method') === 'player_set_volume') {
            assert.deepEqual(message, { volume: 27, media: 'app_ios' });
            playback.volume = message.volume;
          } else if (form.get('method') === 'player_set_positon') {
            assert.deepEqual(message, { position: 2500, media: 'app_ios' });
            playback.position = message.position;
          } else {
            assert.equal(form.get('method'), 'player_play_operation');
            assert.equal(message.media, 'app_ios');
            assert.ok(['pause', 'play'].includes(message.action));
            playback.status = message.action === 'pause' ? 2 : 1;
          }
          return upstreamJson({ code: 0, data: { code: 0 } });
        }
      }
      throw new Error('TEST_OUTBOUND_BLOCKED');
    },
  };
}

// Bundle the actual production entrypoint. No test routes or authentication
// shortcuts are installed in the Worker; only its upstream network is mocked.
test('workerd speaker HTTP flow persists encrypted D1 state and streams conditional R2 ranges', { timeout: 90000 }, async () => {
  const bundled = await bundleWorkerModules({ esbuild: { build },
    entryPoint: resolve('server/src/flaretune.js'), buildOptions: { target: 'es2022' } });
  const upstream = syntheticXiaomi();
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'speakers-worker', ...bundled,
    compatibilityDate: '2026-09-23',
    d1Databases: ['DB'], r2Buckets: ['MEDIA_BUCKET'],
    bindings: { SETUP_SECRET, MEDIA_PREFIX: 'media' },
    outboundService: upstream.outboundService,
  }] }));
  try {
    const { DB: db, MEDIA_BUCKET: bucket } = await mf.getBindings('speakers-worker');
    const material = await hashPassword(PASSWORD);
    const now = Date.now();
    const migration = KNOWN_MIGRATIONS.find(item => item.version === CURRENT_SCHEMA_VERSION);
    await db.batch([
      ...MIGRATION_BUNDLE.flatMap(item => item.statements).map(sql => db.prepare(sql)),
      db.prepare(`INSERT INTO ft_migrations (version,name,checksum,stage,state,started_at,completed_at)
        VALUES (?,?,?,?,'completed',?,?)`).bind(migration.version, migration.name, migration.checksum, migration.stage, now, now),
      db.prepare(`INSERT INTO accounts (account_id,username,role,created_at,updated_at)
        VALUES (?,'speaker-owner','admin',?,?)`).bind(OWNER, now, now),
      db.prepare(`INSERT INTO account_credentials (account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,must_change_password,updated_at)
        VALUES (?,?,?,?,?,?,0,?)`).bind(OWNER, material.kdf, material.kdf_version, material.kdf_params_json, material.salt, material.password_hash, now),
      db.prepare(`INSERT INTO instance_settings (key,value_json,revision,updated_at,updated_by)
        VALUES ('cors.allowed_origins','[]',1,?,?)`).bind(now, OWNER),
      db.prepare(`INSERT INTO Songs (id,title,artist,duration,audio_url,created_at)
        VALUES (?,'Synthetic audio','Fixture artist',15,'/media/audio/speaker-worker.mp3',?)`).bind(SONG, now),
      db.prepare(`UPDATE ft_instance SET schema_version=?,initialized_at=?,revision=revision+1,updated_at=? WHERE id=1`)
        .bind(CURRENT_SCHEMA_VERSION, now, now),
    ]);
    const storedObject = await bucket.put(OBJECT_KEY, AUDIO, { httpMetadata: { contentType: 'audio/mpeg' } });

    // Exercise actual R2 preconditions, including its metadata-only mismatch
    // response, separately from the route's preliminary head/ETag check.
    const conditional = await bucket.get(OBJECT_KEY, { onlyIf: { etagMatches: storedObject.etag }, range: { offset: 2, length: 4 } });
    const conditionalBody = conditional?.body;
    assert.ok(conditionalBody);
    assert.deepEqual(new Uint8Array(await new Response(conditionalBody).arrayBuffer()), AUDIO.slice(2, 6));
    const mismatch = await bucket.get(OBJECT_KEY, { onlyIf: { etagMatches: 'not-the-object-etag' }, range: { offset: 2, length: 4 } });
    assert.equal(mismatch?.body, undefined);

    let cookie;
    let csrfToken;
    async function api(path, { method = 'GET', body, authenticated = true, csrf = true, expected = 200, expectedAccount, pluginBuild = XIAOMI_BUILD } = {}) {
      const result = await mf.dispatchFetch(ORIGIN + path, {
        method,
        headers: {
          Origin: ORIGIN, 'X-Requested-With': 'FlareTune', 'Content-Type': 'application/json',
          'CF-Connecting-IP': '192.0.2.25',
          ...(authenticated && cookie ? { Cookie: cookie } : {}),
          ...(authenticated && csrf && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...(expectedAccount ? { 'X-FlareTune-Expected-Account': expectedAccount } : {}),
          ...(pluginBuild ? { 'X-FlareTune-Plugin-Build': pluginBuild } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await result.json();
      assert.equal(result.status, expected, JSON.stringify(data));
      return { response: result, data };
    }
    assert.equal((await api('/api/instance/status', { authenticated: false })).data.state, 'ready');
    const signed = await api('/api/auth/login', { method: 'POST', body: { username: 'speaker-owner', password: PASSWORD }, authenticated: false });
    assert.equal(signed.data.authenticated, true);
    cookie = signed.response.headers.get('Set-Cookie').split(';')[0];
    csrfToken = signed.data.csrfToken;
    assert.match(cookie, /^__Host-ft_session=/);
    assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await mf.dispatchFetch(ORIGIN + '/media/audio/speaker-worker.mp3')).status, 401);
    await api('/api/account/plugins/xiaomi-speaker', { authenticated: false, expected: 401 });
    await api('/api/account/plugins/xiaomi-speaker/login', { method: 'POST', body: {}, csrf: false, expected: 403 });
    assert.equal(upstream.calls.length, 0, 'CSRF rejection must precede any Xiaomi request');

    const availablePlugin = (await api('/api/admin/plugins')).data.plugins.find(plugin => plugin.id === 'xiaomi-speaker');
    assert.deepEqual(pluginSummary(availablePlugin), { id: 'xiaomi-speaker', version: '1.1.0', installed: false, revision: 0 });
    assert.equal(availablePlugin.availability.reason, 'not_installed');
    assert.match(availablePlugin.manifestDigest, /^[a-f0-9]{64}$/);
    assert.match(availablePlugin.buildDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual((await api('/api/account/plugins')).data, { plugins: [] });
    assert.equal((await api('/api/account/plugins/xiaomi-speaker', { expected: 409 })).data.error, 'PLUGIN_NOT_INSTALLED');
    await api('/api/account/plugins/xiaomi-speaker/login', { method: 'POST', body: {}, expected: 409 });
    assert.equal(upstream.calls.length, 0, 'the built-in plugin must never install itself');
    assert.equal((await api('/api/admin/plugins/xiaomi-speaker', { method: 'PUT',
      body: { installed: true, revision: 0 }, expectedAccount: 'another-account', expected: 409 })).data.error, 'account_changed');
    const installedPlugin = (await api('/api/admin/plugins/xiaomi-speaker', { method: 'PUT', body: { installed: true, revision: 0 } })).data.plugin;
    assert.deepEqual(pluginSummary(installedPlugin), { id: 'xiaomi-speaker', version: '1.1.0', installed: true, revision: 1 });
    assert.equal(installedPlugin.availability.available, true);
    for (const pluginBuild of [null, '0'.repeat(64)]) {
      assert.equal((await api('/api/account/plugins/xiaomi-speaker', { pluginBuild, expected: 409 })).data.error, 'PLUGIN_BUILD_MISMATCH');
    }
    assert.equal(upstream.calls.length, 0, 'a missing or stale build must not execute plugin business');

    const started = (await api('/api/account/plugins/xiaomi-speaker/login', { method: 'POST', body: {} })).data;
    assert.match(started.loginId, /^[A-Za-z0-9_-]+$/);
    assert.match(started.qrDataUrl, /^data:image\/png;base64,/);
    const ready = (await api('/api/account/plugins/xiaomi-speaker/login/poll', { method: 'POST', body: { loginId: started.loginId } })).data;
    assert.equal(ready.phase, 'ready');
    assert.equal(ready.connected, true);
    assert.equal((await api('/api/account/plugins/xiaomi-speaker')).data.connected, true);
    assert.equal((await api('/api/account/speakers')).data.connected, true, 'the old speaker namespace remains a compatible read alias');
    assert.equal(ready.devices.length, 1);
    const speaker = ready.devices[0];
    assert.equal(speaker.hardware, 'L05B');
    assert.equal(speaker.supported, true);
    assert.notEqual(speaker.id, 'fixture-mina-device');
    const publicValue = JSON.stringify({ started, ready });
    for (const value of [PASS_TOKEN, MIJIA_TOKEN, MICO_TOKEN, '"passToken"', '"serviceToken"', '"cookies"', '"minaId"']) {
      assert.equal(publicValue.includes(value), false, 'private Xiaomi state must not reach an HTTP response');
    }
    const saved = await db.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(`account.speakers.${OWNER}`).first();
    assert.ok(saved.revision >= 4, 'separate HTTP requests must persist and decrypt the same owner record');
    assert.deepEqual(Object.keys(JSON.parse(saved.value_json)), ['encrypted']);
    for (const value of [PASS_TOKEN, MIJIA_TOKEN, MICO_TOKEN, 'fixture-mina-device']) assert.equal(saved.value_json.includes(value), false);
    const refreshed = (await api('/api/account/plugins/xiaomi-speaker/devices', { method: 'POST', body: {} })).data;
    assert.equal(refreshed.devices[0].id, speaker.id);

    const play = (await api('/api/account/plugins/xiaomi-speaker/play', { method: 'POST', body: { speakerId: speaker.id, songId: SONG } })).data;
    assert.equal(play.outcome, 'sent');
    assert.match(play.playback.audioId, /^\d+$/);
    assert.equal(upstream.audioUrls.length, 1);
    const mediaUrl = upstream.audioUrls[0];
    const state = async () => (await api('/api/account/plugins/xiaomi-speaker/state', { method: 'POST', body: { speakerId: speaker.id } })).data.playback;
    assert.deepEqual(await state(), { audioId: play.playback.audioId, positionSeconds: 0, durationSeconds: 15, volume: 35, status: 'playing', matched: true });
    assert.deepEqual((await api('/api/account/plugins/xiaomi-speaker/pause', { method: 'POST', body: { speakerId: speaker.id } })).data, { outcome: 'sent' });
    assert.equal((await state()).status, 'paused');
    assert.equal((await mf.dispatchFetch(mediaUrl, { method: 'HEAD' })).status, 200, 'pause must preserve the media capability');
    assert.deepEqual((await api('/api/account/plugins/xiaomi-speaker/resume', { method: 'POST', body: { speakerId: speaker.id } })).data, { outcome: 'sent' });
    assert.equal((await state()).status, 'playing');
    assert.deepEqual((await api('/api/account/plugins/xiaomi-speaker/volume', { method: 'POST', body: { speakerId: speaker.id, volume: 27 } })).data, { outcome: 'sent' });
    assert.equal((await state()).volume, 27);
    assert.deepEqual((await api('/api/account/plugins/xiaomi-speaker/seek', { method: 'POST', body: { speakerId: speaker.id, positionSeconds: 2.5 } })).data, { outcome: 'sent', protocolVerified: false });
    assert.equal((await state()).positionSeconds, 2.5);
    const full = await mf.dispatchFetch(mediaUrl);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(full.headers.get('Content-Length'), String(AUDIO.length));
    assert.equal(full.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), AUDIO);
    const head = await mf.dispatchFetch(mediaUrl, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Length'), String(AUDIO.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const partial = await mf.dispatchFetch(mediaUrl, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('Content-Range'), `bytes 2-5/${AUDIO.length}`);
    assert.equal(partial.headers.get('Content-Length'), '4');
    assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), AUDIO.slice(2, 6));
    const suffix = await mf.dispatchFetch(mediaUrl, { headers: { Range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), AUDIO.slice(-3));
    const invalidRange = await mf.dispatchFetch(mediaUrl, { headers: { Range: 'bytes=300-' } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get('Content-Range'), `bytes */${AUDIO.length}`);
    assert.equal((await mf.dispatchFetch(ORIGIN + '/speaker-media/audio.mp3')).status, 403);

    const beforeUninstall = await db.prepare('SELECT value_json FROM instance_settings WHERE key=?').bind(`account.speakers.${OWNER}`).first();
    await api('/api/admin/plugins/xiaomi-speaker', { method: 'PUT', body: { installed: false, revision: 1 } });
    assert.equal((await mf.dispatchFetch(mediaUrl)).status, 409);
    assert.equal((await api('/api/account/plugins/xiaomi-speaker/state', { method: 'POST', body: { speakerId: speaker.id }, expected: 409 })).data.error, 'PLUGIN_NOT_INSTALLED');
    const afterUninstall = await db.prepare('SELECT value_json FROM instance_settings WHERE key=?').bind(`account.speakers.${OWNER}`).first();
    assert.equal(afterUninstall.value_json, beforeUninstall.value_json, 'uninstall retains the encrypted per-user binding');
    await api('/api/admin/plugins/xiaomi-speaker', { method: 'PUT', body: { installed: true, revision: 2 } });
    assert.equal((await mf.dispatchFetch(mediaUrl)).status, 403, 'reinstallation cannot revive an old grant');
    assert.equal((await api('/api/account/plugins/xiaomi-speaker/resume', { method: 'POST', body: { speakerId: speaker.id }, expected: 409 })).data.error, 'SPEAKER_PLAYBACK_EXPIRED');

    assert.deepEqual((await api('/api/account/plugins/xiaomi-speaker/stop', { method: 'POST', body: { speakerId: speaker.id } })).data, { outcome: 'sent' });
    assert.equal((await mf.dispatchFetch(mediaUrl)).status, 403, 'stop must revoke the issued media capability');
    assert.deepEqual(upstream.commands, ['player_play_music', 'player_play_operation', 'player_play_operation', 'player_set_volume', 'player_set_positon', 'player_play_operation']);
    assert.equal((await api('/api/account/plugins/xiaomi-speaker/resume', { method: 'POST', body: { speakerId: speaker.id }, expected: 409 })).data.error, 'SPEAKER_PLAYBACK_EXPIRED');
    const unlinked = (await api('/api/account/plugins/xiaomi-speaker', { method: 'DELETE', body: {} })).data;
    assert.deepEqual(unlinked, { connected: false, needsReconnect: false, devices: [] });
    assert.deepEqual((await api('/api/account/plugins/xiaomi-speaker')).data, unlinked);
    assert.equal((await mf.dispatchFetch(mediaUrl)).status, 403);
    assert.equal((await mf.dispatchFetch(ORIGIN + '/media/audio/speaker-worker.mp3')).status, 401);
    assert.equal(upstream.calls.length, 20, 'only the expected fake account/device/control exchanges may occur');
  } finally { await mf.dispose(); }
});
