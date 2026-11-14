import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture as baseFixture } from '../subsonic/test-support.js';
import worker from '../flaretune.js';
import { beginLogin, pollLogin, status, disconnect, refreshDevices, playbackState, command, TEST_AUDIO_URL } from './service.js';
import { readRecord, saveRecord, seal, open, speakerKey } from './store.js';
import { parseSpeakerRange } from '../routes/speakerMedia.js';
import { setInstalled, readInstallation, INSTALLATION_KEY } from '../plugins/registry.js';

async function fixture() {
  const f = await baseFixture();
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 0 });
  return f;
}
async function install(f, installed) {
  const current = await readInstallation(f.env);
  return setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed, revision: current.revision });
}
const rawBinding = f => f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(speakerKey(f.owner))?.value_json;

const upstreamAccount = { userId: 'private-xiaomi-user', serviceToken: 'private-service-token' };
const adapter = overrides => ({
  beginQr: async () => ({ state: { lp: 'https://account.xiaomi.com/private-poll', cookies: [{ value: 'private-cookie' }] },
    qrDataUrl: 'data:image/png;base64,aW1hZ2U=', expiresAt: Date.now() + 300000 }),
  pollQr: async state => ({ phase: 'confirmed', state, login: { userId: upstreamAccount.userId, passToken: 'private-pass-token' } }),
  exchange: async () => upstreamAccount,
  listDevices: async () => [{ id: 'private-mina-device-id', name: 'Living room', hardware: 'L05B' }, { id: 'other', name: 'Other', hardware: 'LX06' }],
  playMusic: async () => ({ outcome: 'sent', audioId: 'fixture-owned-audio' }), stopMusic: async () => ({ outcome: 'sent' }),
  pauseMusic: async () => ({ outcome: 'sent' }), resumeMusic: async () => ({ outcome: 'sent' }),
  setVolume: async () => ({ outcome: 'sent' }), seekMusic: async () => ({ outcome: 'sent' }),
  getPlaybackState: async () => ({ audioId: null, positionSeconds: null, durationSeconds: null, volume: null, status: null }), ...overrides,
});
async function app(t) {
  const f = await fixture();
  t.after(() => f.close());
  const session = f.signed.session;
  const fake = adapter();
  const qr = await beginLogin(f.env, session, fake);
  const ready = await pollLogin(f.env, session, qr.loginId, undefined, fake);
  return { ...f, session, fake, device: ready.devices[0], qr };
}
const media = (f, url, init) => worker.fetch(new Request(url, init), f.env);
async function play(f, overrides = {}) {
  let url;
  const result = await command(f.env, f.session, { speakerId: f.device.id, songId: 's1' }, 'play', 'https://test.example',
    adapter({ playMusic: async (_account, _device, link) => { url = link; return { outcome: 'sent', audioId: 'fixture-owned-audio' }; }, ...overrides }));
  return { result, url };
}

test('speaker connection encrypts credentials and private QR state; public status and API never disclose them', async t => {
  const f = await app(t);
  const raw = f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(speakerKey(f.owner)).value_json;
  for (const secret of Object.values(upstreamAccount)) assert.ok(!raw.includes(secret));
  const saved = await readRecord(f.env, f.owner);
  assert.equal(saved.value.binding.account.serviceToken, upstreamAccount.serviceToken);
  assert.equal(saved.value.login, null, 'passToken and QR state cleared after exchange');
  const response = await f.api('account/speakers');
  assert.equal(response.status, 200);
  const body = await response.text();
  for (const secret of [...Object.values(upstreamAccount), 'private-mina-device-id', 'private-pass-token']) assert.ok(!body.includes(secret));
  assert.equal((await status(f.env, (await f.signIn('member')).session)).connected, false);
  assert.equal((await command(f.env, f.session, { speakerId: f.device.id }, 'test', 'https://test.example',
    adapter({ playMusic: async (_a, device, url) => { assert.equal(device, 'private-mina-device-id'); assert.equal(url, TEST_AUDIO_URL); return { outcome: 'sent' }; } }))).outcome, 'sent');
});

test('encryption binds rows to owner and separates ticket/record purposes; key rotation fails closed and allows reconnect', async t => {
  const f = await app(t);
  const value = await seal({ owner: f.owner }, f.env, 'account record', f.owner);
  await assert.rejects(open(value, f.env, 'account record', 'member'));
  await assert.rejects(open(value, f.env, 'media ticket', f.owner));
  const copied = f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(speakerKey(f.owner)).value_json;
  f.sqlite.prepare('INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,?)').run(speakerKey('member'), copied, Date.now(), f.owner);
  assert.equal((await status(f.env, (await f.signIn('member')).session)).needsReconnect, true);
  f.env.SETUP_SECRET = 'rotated-test-only-setup-secret-at-least-32-characters';
  assert.deepEqual(await status(f.env, f.session), { connected: false, needsReconnect: true, devices: [] });
  await disconnect(f.env, f.session);
  assert.equal((await status(f.env, f.session)).needsReconnect, false);
});

test('QR ownership, expiry, cooldown and exchange retry use persisted state across requests', async t => {
  const f = await fixture(); t.after(() => f.close());
  const session = f.signed.session;
  const qr = await beginLogin(f.env, session, adapter());
  await assert.rejects(beginLogin(f.env, session, adapter()), { code: 'SPEAKER_RATE_LIMITED' });
  const otherSession = (await f.signIn()).session;
  await assert.rejects(pollLogin(f.env, otherSession, qr.loginId, undefined, adapter()), { code: 'SPEAKER_LOGIN_NOT_FOUND' });
  let polls = 0;
  await assert.rejects(pollLogin(f.env, session, qr.loginId, undefined, adapter({
    pollQr: async state => { polls++; return { phase: 'confirmed', state, login: { userId: 'u', passToken: 'private-pass-token' } }; },
    exchange: async () => { throw new Error('fixed-upstream-failure'); },
  })));
  const pending = await readRecord(f.env, f.owner);
  assert.equal(pending.value.login.credentials.passToken, 'private-pass-token');
  assert.equal((await pollLogin(f.env, session, qr.loginId, undefined, adapter({ pollQr: async () => assert.fail('must reuse confirmation') }))).phase, 'ready');
  assert.equal(polls, 1);
});

test('unlink and logout while QR exchange is pending cannot resurrect a connection', async t => {
  for (const action of ['unlink', 'logout']) await t.test(action, async t => {
    const f = await fixture(); t.after(() => f.close());
    const session = f.signed.session;
    const qr = await beginLogin(f.env, session, adapter());
    let release, entered;
    const atExchange = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const pending = pollLogin(f.env, session, qr.loginId, undefined, adapter({ exchange: async () => { entered(); await waiting; return upstreamAccount; } }));
    await atExchange;
    if (action === 'unlink') await disconnect(f.env, session);
    else f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), session.tokenHash);
    release();
    await assert.rejects(pending, { code: 'SPEAKER_CHANGED' });
    assert.equal((await status(f.env, session)).connected, false);
  });
});

test('play validates owner, device, MP3 resource, HTTPS and session lifetime before sending', async t => {
  const f = await app(t);
  let sends = 0;
  const fake = adapter({ playMusic: async () => { sends++; return { outcome: 'sent' }; } });
  const submit = (input, session = f.session, origin = 'https://test.example') => command(f.env, session, input, 'play', origin, fake);
  await assert.rejects(submit({ speakerId: f.device.id, songId: 's1' }, (await f.signIn('member')).session), { code: 'SPEAKER_RECONNECT_REQUIRED' });
  await assert.rejects(submit({ speakerId: 'foreign', songId: 's1' }), { code: 'SPEAKER_NOT_FOUND' });
  await assert.rejects(submit({ speakerId: f.device.id, songId: 's2' }), { code: 'SPEAKER_MP3_REQUIRED' });
  await assert.rejects(submit({ speakerId: f.device.id, songId: 'missing' }), { code: 'SPEAKER_SONG_NOT_FOUND' });
  await assert.rejects(submit({ speakerId: f.device.id, songId: 's1' }, f.session, 'http://test.example'), { code: 'SPEAKER_HTTPS_REQUIRED' });
  await assert.rejects(submit({ speakerId: f.device.id, songId: 's1' }, { ...f.session, expiresAt: Date.now() + 10000 }), { code: 'SPEAKER_SESSION_EXPIRING' });
  for (const path of ['https://external.test/audio.mp3', '/media/cover/one.mp3', '/media/ingest-devices/manifest.mp3', '/media/audio/%2e%2e/private.mp3']) {
    f.sqlite.prepare('UPDATE Songs SET audio_url=? WHERE id=?').run(path, 's1');
    await assert.rejects(submit({ speakerId: f.device.id, songId: 's1' }), { code: 'SPEAKER_MP3_REQUIRED' });
  }
  assert.equal(sends, 0);
});

test('media grants are opaque single-song capabilities; GET/HEAD/ranges have exact bytes and no login redirect', async t => {
  const f = await app(t);
  const objectBytes = Uint8Array.from([1, 2, 3, 4, 5]);
  f.env.MEDIA_BUCKET.get = async (key, options = {}) => {
    assert.equal(key, 'media/audio/one.mp3');
    assert.equal(options.onlyIf.etagMatches, 'test-etag');
    const range = options.range;
    return { body: range ? objectBytes.slice(range.offset, range.offset + range.length) : objectBytes,
      size: 5, etag: 'test-etag', httpEtag: '"test-etag"' };
  };
  // Preserve the fixture's metadata without its head() internally calling get().
  f.env.MEDIA_BUCKET.head = async () => ({ size: 5, etag: 'test-etag', httpEtag: '"test-etag"' });
  const { result, url } = await play(f);
  assert.equal(result.outcome, 'sent');
  assert.ok(!url.includes(f.owner));
  assert.ok(!url.includes('/media/audio/one.mp3'));
  const whole = await media(f, url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(whole.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(whole.headers.get('Content-Length'), '5');
  assert.deepEqual([...new Uint8Array(await whole.arrayBuffer())], [...objectBytes]);
  const head = await media(f, url, { method: 'HEAD', headers: { Range: 'bytes=1-2' } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), '5'); assert.equal(await head.text(), '');
  for (const [range, expected, contentRange] of [['bytes=1-2', [2, 3], 'bytes 1-2/5'], ['bytes=3-', [4, 5], 'bytes 3-4/5'], ['bytes=-2', [4, 5], 'bytes 3-4/5'], ['bytes=0-999', [1, 2, 3, 4, 5], 'bytes 0-4/5']]) {
    const response = await media(f, url, { headers: { Range: range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected);
  }
  for (const range of ['bytes=9-', 'bytes=3-1', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=abc-', 'bytes=999999999999999999999-']) {
    const response = await media(f, url, { headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), 'bytes */5');
  }
  assert.equal((await media(f, 'https://test.example/media/audio/one.mp3')).status, 401);
  assert.equal((await media(f, url + '&ticket=another')).status, 403);
  const tampered = new URL(url);
  const token = tampered.searchParams.get('ticket');
  tampered.searchParams.set('ticket', token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21));
  assert.equal((await media(f, tampered.href)).status, 403);
  assert.equal((await media(f, url, { method: 'POST' })).status, 405);
});

test('configured media origin changes only the hostname; grants and revocation stay enforced', async t => {
  const f = await app(t);
  f.env.SPEAKER_MEDIA_ORIGIN = 'https://speaker.test.example';
  const { url } = await play(f);
  assert.equal(new URL(url).origin, 'https://speaker.test.example');
  assert.equal((await media(f, url)).status, 200);
  await command(f.env, f.session, { speakerId: f.device.id }, 'stop', 'https://test.example', f.fake);
  assert.equal((await media(f, url)).status, 403);
  let sends = 0;
  for (const value of ['http://speaker.test.example', 'not a URL', 'https://user:secret@speaker.test.example',
    'https://speaker.test.example/elsewhere', 'https://speaker.test.example?ticket=other', 'https://speaker.test.example#fragment']) {
    f.env.SPEAKER_MEDIA_ORIGIN = value;
    await assert.rejects(play(f, { playMusic: async () => { sends++; return { outcome: 'sent' }; } }));
  }
  assert.equal(sends, 0);
});

test('stop, replacement, unlink, expiration, session/account revocation, key rotation and song change deny new media reads', async t => {
  for (const action of ['stop', 'replace', 'unlink', 'expire', 'logout', 'disable', 'password-reset', 'credential-corruption', 'rotate', 'song-change', 'etag-change']) await t.test(action, async t => {
    const f = await app(t);
    const { url } = await play(f);
    if (action === 'stop') await command(f.env, f.session, { speakerId: f.device.id }, 'stop', 'https://test.example', f.fake);
    if (action === 'replace') await play(f);
    if (action === 'unlink') await disconnect(f.env, f.session);
    if (action === 'expire') {
      const record = await readRecord(f.env, f.owner);
      record.value.binding.tickets[f.device.id].expiresAt = Date.now() - 1;
      await saveRecord(f.env, f.session, record, record.value);
    }
    if (action === 'logout') f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), f.session.tokenHash);
    if (action === 'disable') f.sqlite.prepare("UPDATE accounts SET status='disabled' WHERE account_id=?").run(f.owner);
    if (action === 'password-reset') f.sqlite.prepare('UPDATE account_credentials SET must_change_password=1 WHERE account_id=?').run(f.owner);
    if (action === 'credential-corruption') f.sqlite.prepare("UPDATE account_credentials SET kdf='invalid' WHERE account_id=?").run(f.owner);
    if (action === 'rotate') f.env.SETUP_SECRET = 'rotated-test-only-setup-secret-at-least-32-characters';
    if (action === 'song-change') f.sqlite.prepare("UPDATE Songs SET audio_url='audio/replaced.mp3' WHERE id='s1'").run();
    if (action === 'etag-change') f.objects.get('media/audio/one.mp3').etag = 'replacement-etag';
    const response = await media(f, url);
    assert.ok([403, 404, 503].includes(response.status), `${action}: ${response.status}`);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Location'), null);
  });
});

test('commands serialize in D1, do not retry uncertain sends, and unlink during send wins', async t => {
  const f = await app(t);
  let release, entered, url, sends = 0;
  const sent = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const pending = command(f.env, f.session, { speakerId: f.device.id, songId: 's1' }, 'play', 'https://test.example', adapter({
    playMusic: async (_a, _d, link) => { sends++; url = link; entered(); await waiting; return { outcome: 'uncertain' }; },
  }));
  await sent;
  await assert.rejects(command(f.env, f.session, { speakerId: f.device.id }, 'stop', 'https://test.example', f.fake), { code: 'SPEAKER_BUSY' });
  await disconnect(f.env, f.session);
  release();
  assert.equal((await pending).outcome, 'uncertain');
  assert.equal(sends, 1);
  assert.equal((await status(f.env, f.session)).connected, false);
  assert.equal((await media(f, url)).status, 403);
});

test('explicit upstream auth expiry clears authorization and tickets; failed command never leaves playable link', async t => {
  const f = await app(t);
  const first = await play(f);
  await assert.rejects(refreshDevices(f.env, f.session, adapter({ listDevices: async () => { throw Object.assign(new Error(), { code: 'XIAOMI_AUTH_EXPIRED' }); } })));
  assert.equal((await status(f.env, f.session)).needsReconnect, true);
  assert.equal((await media(f, first.url)).status, 403);
});

test('API routes preserve session, must-change-password and CSRF gates', async t => {
  const f = await app(t);
  assert.equal((await worker.fetch(new Request('https://test.example/api/account/speakers'), f.env)).status, 401);
  const csrf = await f.api('account/speakers', 'DELETE', {}, f.signed, { 'X-CSRF-Token': 'wrong' });
  assert.equal(csrf.status, 403);
  const changed = await f.api('account/speakers', 'DELETE', {}, f.signed, { 'X-FlareTune-Expected-Account': 'member' });
  assert.equal(changed.status, 409);
  assert.equal((await f.api('account/speakers')).status, 200);
  assert.equal((await f.api('account/speakers', 'DELETE', {})).status, 200);
  assert.equal((await f.api('account/speakers')).headers.get('Cache-Control'), 'private, no-store');
});

test('range parser rejects unsafe/multiple ranges and supports suffix/open-ended ranges', () => {
  assert.deepEqual(parseSpeakerRange('bytes=-100', 5), { offset: 0, length: 5 });
  assert.deepEqual(parseSpeakerRange('bytes=0-', 5), { offset: 0, length: 5 });
  assert.equal(parseSpeakerRange('bytes=0-1,2-3', 5), false);
});

test('pause, resume, volume and seek preserve the active capability; stop still revokes it', async t => {
  const f = await app(t);
  const first = await play(f);
  assert.equal(first.result.playback.audioId, 'fixture-owned-audio');
  const before = (await readRecord(f.env, f.owner)).value.binding.tickets[f.device.id];
  const calls = [];
  const fake = adapter({
    pauseMusic: async (_account, device) => { calls.push(['pause', device]); return { outcome: 'sent' }; },
    resumeMusic: async (_account, device) => { calls.push(['resume', device]); return { outcome: 'uncertain' }; },
    setVolume: async (_account, device, volume) => { calls.push(['volume', device, volume]); return { outcome: 'sent' }; },
    seekMusic: async (_account, device, seconds) => { calls.push(['seek', device, seconds]); return { outcome: 'sent' }; },
  });
  for (const [action, input, outcome] of [
    ['pause', {}, 'sent'], ['resume', {}, 'uncertain'], ['volume', { volume: 33 }, 'sent'], ['seek', { positionSeconds: 3.25 }, 'sent'],
  ]) {
    const result = await command(f.env, f.session, { speakerId: f.device.id, ...input }, action, 'https://test.example', fake);
    assert.equal(result.outcome, outcome);
    if (action === 'seek') assert.equal(result.protocolVerified, false);
    assert.equal((await media(f, first.url)).status, 200);
    const after = (await readRecord(f.env, f.owner)).value.binding.tickets[f.device.id];
    assert.deepEqual(after, before);
  }
  assert.deepEqual(calls, [
    ['pause', 'private-mina-device-id'], ['resume', 'private-mina-device-id'],
    ['volume', 'private-mina-device-id', 33], ['seek', 'private-mina-device-id', 3.25],
  ]);
  await command(f.env, f.session, { speakerId: f.device.id }, 'stop', 'https://test.example', fake);
  assert.equal((await media(f, first.url)).status, 403);
  await assert.rejects(command(f.env, f.session, { speakerId: f.device.id }, 'resume', 'https://test.example', fake), { code: 'SPEAKER_PLAYBACK_EXPIRED' });
  assert.equal(calls.length, 4, 'resume cannot silently issue a replacement play');
});

test('offset playback returns a safe issued identity while unsupported units remain explicit', async t => {
  const f = await app(t);
  let options;
  const result = await command(f.env, f.session, { speakerId: f.device.id, songId: 's1', positionSeconds: 2.5 }, 'play', 'https://test.example',
    adapter({ playMusic: async (_a, _d, _url, supplied) => { options = supplied; return { outcome: 'sent', audioId: 'issued-audio-123', url: 'private-url', token: 'private-token' }; } }));
  assert.deepEqual(options, { positionSeconds: 2.5 });
  assert.deepEqual(result, { outcome: 'sent', playback: { audioId: 'issued-audio-123' }, protocolVerified: false });
  assert.equal((await readRecord(f.env, f.owner)).value.binding.tickets[f.device.id].audioId, 'issued-audio-123');
});

test('playback state reports only this session issued audio; missing identity is unknown rather than takeover', async t => {
  const f = await app(t);
  await play(f);
  let reported = { audioId: 'fixture-owned-audio', positionSeconds: 2.5, durationSeconds: 15, volume: 42, status: 'playing',
    token: 'private-token', url: 'private-url', deviceId: 'private-device' };
  const fake = adapter({ getPlaybackState: async () => reported });
  const revision = (await readRecord(f.env, f.owner)).revision;
  const state = () => playbackState(f.env, f.session, { speakerId: f.device.id }, fake);
  assert.deepEqual(await state(), { playback: { audioId: 'fixture-owned-audio', positionSeconds: 2.5, durationSeconds: 15, volume: 42, status: 'playing', matched: true } });
  assert.equal((await readRecord(f.env, f.owner)).revision, revision, 'polling must not race commands by writing unchanged snapshots');
  reported = { ...reported, audioId: 'private-other-source-audio' };
  assert.deepEqual(await state(), { playback: { audioId: null, positionSeconds: null, durationSeconds: null, volume: 42, status: null, matched: false } });
  reported = { ...reported, audioId: null };
  assert.deepEqual(await state(), { playback: { audioId: null, positionSeconds: null, durationSeconds: null, volume: 42, status: null, matched: null } });
  reported = { audioId: 'fixture-owned-audio', positionSeconds: -1, durationSeconds: Infinity, volume: '50', status: 'arbitrary' };
  assert.deepEqual(await state(), { playback: { audioId: 'fixture-owned-audio', positionSeconds: null, durationSeconds: null, volume: null, status: null, matched: true } });
});

test('a delayed state response cannot label a replacement song or an unlinked device as current', async t => {
  const f = await app(t);
  for (const action of ['replace', 'unlink']) {
    await play(f);
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const pending = playbackState(f.env, f.session, { speakerId: f.device.id }, adapter({
      getPlaybackState: async () => { entered(); await waiting; return { audioId: 'fixture-owned-audio', status: 'playing', positionSeconds: 10, durationSeconds: 15, volume: 30 }; },
    }));
    await started;
    if (action === 'replace') await play(f);
    else await disconnect(f.env, f.session);
    release();
    const result = await pending;
    assert.equal(result.playback.matched, null);
    assert.equal(result.playback.audioId, null);
    assert.equal(result.playback.positionSeconds, null);
  }
});

test('state rechecks session validity after a slow upstream read and discards old control revisions', async t => {
  const f = await app(t);
  await play(f);
  async function pendingRead() {
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const pending = playbackState(f.env, f.session, { speakerId: f.device.id }, adapter({
      getPlaybackState: async () => { entered(); await waiting; return { audioId: 'fixture-owned-audio', status: 'playing', positionSeconds: 4, volume: 50 }; },
    }));
    await started;
    return { pending, release };
  }
  const stale = await pendingRead();
  await command(f.env, f.session, { speakerId: f.device.id }, 'pause', 'https://test.example', f.fake);
  stale.release();
  assert.deepEqual((await stale.pending).playback, { audioId: null, positionSeconds: null, durationSeconds: null, volume: null, status: null, matched: null });
  const revoked = await pendingRead();
  f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), f.session.tokenHash);
  revoked.release();
  await assert.rejects(revoked.pending, { code: 'SPEAKER_CHANGED' });
});

test('expired or other-session tickets and invalid volume/seek never send commands', async t => {
  const f = await app(t);
  let calls = 0;
  const sent = async () => { calls++; return { outcome: 'sent' }; };
  const fake = adapter({ resumeMusic: sent, seekMusic: sent, setVolume: sent, playMusic: sent });
  const invoke = (action, input = {}, session = f.session) => command(f.env, session, { speakerId: f.device.id, ...input }, action, 'https://test.example', fake);
  for (const volume of [-1, 101, '50', null, 1.5]) await assert.rejects(invoke('volume', { volume }), { code: 'invalid_input' });
  for (const positionSeconds of [-1, Infinity, '2', null, 85501]) await assert.rejects(invoke('seek', { positionSeconds }), { code: 'invalid_input' });
  await assert.rejects(invoke('resume'), { code: 'SPEAKER_PLAYBACK_EXPIRED' });
  await play(f);
  await assert.rejects(invoke('seek', { positionSeconds: 16 }), { code: 'invalid_input' });
  await assert.rejects(invoke('play', { songId: 's1', positionSeconds: 16 }), { code: 'invalid_input' });
  const otherSession = (await f.signIn()).session;
  await assert.rejects(invoke('resume', {}, otherSession), { code: 'SPEAKER_PLAYBACK_EXPIRED' });
  const record = await readRecord(f.env, f.owner);
  record.value.binding.tickets[f.device.id].expiresAt = Date.now() - 1;
  await saveRecord(f.env, f.session, record, record.value);
  await assert.rejects(invoke('resume'), { code: 'SPEAKER_PLAYBACK_EXPIRED' });
  assert.equal(calls, 0);
});

test('new controls retain the lease, failed pause retains media, and auth-expired state clears capabilities', async t => {
  const f = await app(t);
  const first = await play(f);
  await command(f.env, f.session, { speakerId: f.device.id }, 'pause', 'https://test.example', adapter({ pauseMusic: async () => ({ outcome: 'failed' }) }));
  assert.equal((await media(f, first.url)).status, 200);
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const pending = command(f.env, f.session, { speakerId: f.device.id, volume: 40 }, 'volume', 'https://test.example', adapter({
    setVolume: async () => { entered(); await waiting; return { outcome: 'sent' }; },
  }));
  await started;
  await assert.rejects(command(f.env, f.session, { speakerId: f.device.id }, 'resume', 'https://test.example', f.fake), { code: 'SPEAKER_BUSY' });
  release();
  assert.equal((await pending).outcome, 'sent');
  await assert.rejects(playbackState(f.env, f.session, { speakerId: f.device.id }, adapter({
    getPlaybackState: async () => { throw Object.assign(new Error('upstream-private-text'), { code: 'XIAOMI_AUTH_EXPIRED' }); },
  })), { code: 'XIAOMI_AUTH_EXPIRED' });
  assert.equal((await status(f.env, f.session)).needsReconnect, true);
  assert.equal((await media(f, first.url)).status, 403);
});

test('every Xiaomi API is closed without installation, including when an old encrypted binding exists', async t => {
  const f = await app(t);
  const raw = rawBinding(f);
  f.sqlite.prepare('DELETE FROM instance_settings WHERE key=?').run(INSTALLATION_KEY);
  for (const [path, method, body] of [
    ['account/speakers', 'GET'], ['account/speakers', 'DELETE', {}],
    ...['login', 'login/poll', 'devices', 'state', 'play', 'stop', 'test', 'pause', 'resume', 'volume', 'seek']
      .map(action => [`account/speakers/${action}`, 'POST', { speakerId: f.device.id, songId: 's1', loginId: f.qr.loginId, volume: 20, positionSeconds: 1 }]),
  ]) {
    const response = await f.api(path, method, body);
    assert.equal(response.status, 409, path);
    assert.deepEqual(await response.json(), { error: 'PLUGIN_NOT_INSTALLED' });
  }
  assert.equal(rawBinding(f), raw, 'neither discovery nor a rejected command implicitly installs or edits a binding');
  assert.deepEqual(await (await f.api('account/plugins')).json(), { plugins: [] });
});

test('uninstall retains encrypted account data; reinstall invalidates grants, resume and queued QR sessions', async t => {
  const f = await app(t);
  const first = await play(f);
  const raw = rawBinding(f);
  await install(f, false);
  assert.equal(rawBinding(f), raw);
  for (const method of ['GET', 'HEAD']) assert.equal((await media(f, first.url, { method })).status, 409);
  await install(f, true);
  assert.equal((await status(f.env, f.session)).connected, true);
  assert.equal((await media(f, first.url)).status, 403);
  for (const action of ['pause', 'resume', 'seek']) await assert.rejects(
    command(f.env, f.session, { speakerId: f.device.id, positionSeconds: 1 }, action, 'https://test.example', f.fake),
    { code: 'SPEAKER_PLAYBACK_EXPIRED' });
  const state = await playbackState(f.env, f.session, { speakerId: f.device.id }, adapter({
    getPlaybackState: async () => ({ audioId: first.result.playback.audioId, positionSeconds: 2, durationSeconds: 15, volume: 20, status: 'playing' }),
  }));
  assert.deepEqual(state.playback, { audioId: null, positionSeconds: null, durationSeconds: null, volume: 20, status: null, matched: null });
  const second = await play(f);
  assert.equal((await media(f, second.url)).status, 200);
  assert.equal((await media(f, first.url)).status, 403);

  const fresh = await fixture(); t.after(() => fresh.close());
  const qr = await beginLogin(fresh.env, fresh.signed.session, adapter());
  await install(fresh, false); await install(fresh, true);
  let polls = 0;
  await assert.rejects(pollLogin(fresh.env, fresh.signed.session, qr.loginId, undefined,
    adapter({ pollQr: async () => { polls++; } })), { code: 'SPEAKER_LOGIN_NOT_FOUND' });
  assert.equal(polls, 0, 'a retired QR must not contact Xiaomi after reinstallation');
});

test('uninstall during QR preparation or exchange prevents saving credentials and further upstream calls', async t => {
  for (const stage of ['qr', 'exchange']) await t.test(stage, async t => {
    const f = await fixture(); t.after(() => f.close());
    let entered, release, deviceReads = 0;
    const atStage = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const fake = adapter({
      beginQr: async () => { if (stage === 'qr') { entered(); await waiting; } return adapter().beginQr(); },
      exchange: async () => { entered(); await waiting; return upstreamAccount; },
      listDevices: async () => { deviceReads++; return []; },
    });
    let pending;
    if (stage === 'qr') pending = beginLogin(f.env, f.signed.session, fake);
    else {
      const qr = await beginLogin(f.env, f.signed.session, fake);
      pending = pollLogin(f.env, f.signed.session, qr.loginId, undefined, fake);
    }
    await atStage;
    const raw = rawBinding(f);
    await install(f, false); await install(f, true);
    release();
    await assert.rejects(pending, { code: 'PLUGIN_NOT_INSTALLED' });
    assert.equal(rawBinding(f), raw);
    assert.equal(deviceReads, 0);
  });
});

test('uninstall while signing a song grant prevents both its CAS reservation and the device send', async t => {
  const f = await app(t);
  let entered, release, sends = 0;
  const atHead = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const head = f.env.MEDIA_BUCKET.head.bind(f.env.MEDIA_BUCKET);
  f.env.MEDIA_BUCKET.head = async key => { entered(); await waiting; return head(key); };
  const pending = play(f, { playMusic: async () => { sends++; return { outcome: 'sent' }; } });
  await atHead;
  const raw = rawBinding(f);
  await install(f, false); await install(f, true);
  release();
  await assert.rejects(pending, { code: 'PLUGIN_NOT_INSTALLED' });
  assert.equal(sends, 0);
  assert.equal(rawBinding(f), raw);
});

test('uninstall during a command or state read cannot resurrect tickets, write an old receipt or retry play', async t => {
  for (const action of ['play', 'state']) await t.test(action, async t => {
    const f = await app(t);
    let entered, release, sends = 0, url;
    const atUpstream = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const fake = adapter({
      playMusic: async (_a, _d, link) => { sends++; url = link; entered(); await waiting; return { outcome: 'sent', audioId: 'late-audio' }; },
      getPlaybackState: async () => { entered(); await waiting; return { audioId: 'late-audio', volume: 20, status: 'playing' }; },
    });
    const pending = action === 'play'
      ? command(f.env, f.session, { speakerId: f.device.id, songId: 's1' }, 'play', 'https://test.example', fake)
      : playbackState(f.env, f.session, { speakerId: f.device.id }, fake);
    await atUpstream;
    const raw = rawBinding(f);
    await install(f, false); await install(f, true);
    release();
    await assert.rejects(pending, { code: 'PLUGIN_NOT_INSTALLED' });
    assert.equal(rawBinding(f), raw);
    assert.equal(sends, action === 'play' ? 1 : 0);
    if (url) assert.equal((await media(f, url)).status, 403);
    if (action === 'play') {
      await assert.rejects(play(f), { code: 'SPEAKER_BUSY' });
      const record = await readRecord(f.env, f.owner);
      record.value.binding.command.until = Date.now() - 1;
      await saveRecord(f.env, f.session, record, record.value);
    }
    assert.equal((await play(f)).result.outcome, 'sent', 'the bounded old lease cannot permanently block the new installation');
  });
});

test('a media read delayed in R2 checks installation again before releasing bytes', async t => {
  const f = await app(t);
  const first = await play(f);
  let entered, release;
  const atHead = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const head = f.env.MEDIA_BUCKET.head.bind(f.env.MEDIA_BUCKET);
  f.env.MEDIA_BUCKET.head = async key => { entered(); await waiting; return head(key); };
  const pending = media(f, first.url);
  await atHead;
  await install(f, false);
  release();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal(await response.text(), '');
});

test('an uninstall at the receipt CAS returns the retired-plugin error instead of a successful HTTP result', async t => {
  const f = await app(t);
  const pending = play(f, { playMusic: async () => {
    f.db.beforeWrite = sql => {
      if (!sql.includes('INSERT INTO instance_settings')) return;
      f.db.beforeWrite = null;
      f.sqlite.prepare('UPDATE instance_settings SET value_json=?,revision=revision+1 WHERE key=?')
        .run(JSON.stringify({ installed: false, epoch: crypto.randomUUID() }), INSTALLATION_KEY);
    };
    return { outcome: 'sent', audioId: 'retired-receipt' };
  } });
  await assert.rejects(pending, { code: 'PLUGIN_NOT_INSTALLED' });
  const saved = await open(JSON.parse(rawBinding(f)).encrypted, f.env, 'account record', f.owner);
  assert.equal(saved.binding.tickets[f.device.id].audioId, undefined, 'the rejected receipt was not persisted');
});
