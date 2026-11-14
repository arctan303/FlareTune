import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beginQr, pollQr, exchange, listDevices, playMusic, stopMusic, pauseMusic, resumeMusic,
  setVolume, seekMusic, getPlaybackState, XiaomiError } from './xiaomi.js';

const NOW = 1800000000000;
const LP = 'https://c3.lp.account.xiaomi.com/longPolling/await?ticket=private';
const QR = 'https://account.xiaomi.com/longPolling/qr?ticket=private';
const ACCOUNT = { userId: '123456', serviceToken: 'test-service-token' };
const AUDIO = 'https://music.example/speaker-media/opaque/audio.mp3';
const HANDSHAKE = { _sign: 'sign', qs: 'query', callback: 'https://account.xiaomi.com/callback' };
function response(body, { status = 200, cookies = [], headers = {} } = {}) {
  const result = new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
  for (const cookie of cookies) result.headers.append('Set-Cookie', cookie);
  return result;
}
function image() { return response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }); }
function callsOf(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      const next = responses.shift();
      assert.notEqual(next, undefined, 'unexpected network request');
      return typeof next === 'function' ? next(url, options) : next;
    },
  };
}
async function qrState(cookies = []) {
  const mock = callsOf([response(HANDSHAKE, { cookies }), response({ lp: LP, qr: QR }), image()]);
  return (await beginQr({ fetchImpl: mock.fetchImpl, now: NOW })).state;
}
function isError(code, status) {
  return error => {
    assert.ok(error instanceof XiaomiError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

test('QR, long polling and micoapi exchange preserve large integers and isolate service cookies', async () => {
  const nonce = '9223372036854775807';
  const userId = '18446744073709551616';
  const secret = 'test-ssecurity';
  const mock = callsOf([
    response(HANDSHAKE, { cookies: ['serviceToken=mijia-token; Domain=.xiaomi.com; Path=/; Secure', 'qrSession=qr-only; Path=/'] }),
    response({ lp: LP, qr: QR }),
    image(),
    response(`&&&START&&&{"code":0,"userId":${userId},"passToken":"test-pass-token"}`, { cookies: ['confirmed=yes; Domain=.xiaomi.com; Path=/'] }),
    (url, options) => {
      assert.equal(new URL(url).searchParams.get('sid'), 'micoapi');
      assert.match(options.headers.Cookie, /passToken=test-pass-token/);
      assert.match(options.headers.Cookie, new RegExp(`userId=${userId}`));
      assert.doesNotMatch(options.headers.Cookie, /mijia-token|qrSession|confirmed/);
      return response(`&&&START&&&{"code":0,"userId":${userId},"nonce":${nonce},"ssecurity":"${secret}","location":"https://api.mina.mi.com/sts?ticket=private"}`);
    },
    (url, options) => {
      const expected = createHash('sha1').update(`nonce=${nonce}&${secret}`).digest('base64');
      assert.equal(new URL(url).searchParams.get('clientSign'), expected);
      assert.equal(options.headers.Cookie, undefined, 'account passToken must not travel to MiNA');
      return response('', { status: 302, headers: { location: 'https://api2.mina.mi.com/sts/finish' }, cookies: ['bridge=ok; Domain=.mi.com; Path=/; Secure'] });
    },
    (url, options) => {
      assert.equal(new URL(url).hostname, 'api2.mina.mi.com');
      assert.equal(options.headers.Cookie, 'bridge=ok');
      return response('', { cookies: ['serviceToken=micoapi-token; Domain=.mi.com; Path=/; Secure'] });
    },
  ]);
  const started = await beginQr({ fetchImpl: mock.fetchImpl, now: NOW });
  assert.equal(started.qrDataUrl, 'data:image/png;base64,iVBORw==');
  assert.equal(started.expiresAt, NOW + 300000);
  assert.deepEqual(JSON.parse(JSON.stringify(started.state)), started.state);
  assert.equal(mock.calls[0].url.searchParams.get('sid'), 'mijia');
  assert.equal(mock.calls[1].url.searchParams.get('_dc'), String(NOW));
  const original = structuredClone(started.state);
  const polled = await pollQr(started.state, { fetchImpl: mock.fetchImpl, now: NOW + 1 });
  assert.equal(polled.phase, 'confirmed');
  assert.deepEqual(polled.login, { userId, passToken: 'test-pass-token' });
  assert.deepEqual(started.state, original, 'poll must not mutate stored caller state');
  assert.match(mock.calls[3].options.headers.Cookie, /serviceToken=mijia-token/);
  assert.doesNotMatch(mock.calls[3].options.headers.Cookie, /qrSession/);
  assert.deepEqual(await exchange(polled.login, polled.state, { fetchImpl: mock.fetchImpl }), { userId, serviceToken: 'micoapi-token' });
  assert.equal(mock.calls.length, 7);
  assert.ok(mock.calls.every(call => call.options.redirect === 'manual'));
});

test('independent QR sessions do not share cookies or login credentials', async () => {
  const [first, second] = await Promise.all([
    qrState(['session=first; Domain=.xiaomi.com; Path=/']),
    qrState(['session=second; Domain=.xiaomi.com; Path=/']),
  ]);
  assert.notEqual(first.deviceId, second.deviceId);
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(options.headers.Cookie); return response({ code: 0 }); };
  await Promise.all([pollQr(first, { fetchImpl, now: NOW }), pollQr(second, { fetchImpl, now: NOW })]);
  assert.match(seen[0], /session=first/);
  assert.doesNotMatch(seen[0], /second/);
  assert.match(seen[1], /session=second/);
  assert.doesNotMatch(seen[1], /first/);
});

test('Cookie domain, host, path boundary and expiration rules are honored', async () => {
  const mock = callsOf([
    response(HANDSHAKE, { cookies: [
      'root=shared; Domain=.xiaomi.com; Path=/; Secure',
      'host=account-only; Path=/',
      'path=pass-only; Path=/pass',
      'prefix=no; Path=/long',
      'brief=expired; Domain=.xiaomi.com; Path=/; Max-Age=1',
      'precedence=alive; Domain=.xiaomi.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60',
      'deleted=gone; Domain=.xiaomi.com; Path=/; Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT',
      'foreign=bad; Domain=.evil.example; Path=/',
      'suffix=bad; Domain=.com; Path=/',
      'boundary=bad; Domain=.xiaomi.com.evil.example; Path=/',
    ] }),
    (url, options) => {
      assert.match(options.headers.Cookie, /root=shared/);
      assert.match(options.headers.Cookie, /host=account-only/);
      assert.doesNotMatch(options.headers.Cookie, /path=|prefix=|foreign=|suffix=|boundary=|deleted=/);
      return response({ lp: LP, qr: QR });
    },
    image(),
    (url, options) => {
      assert.match(options.headers.Cookie, /root=shared/);
      assert.match(options.headers.Cookie, /precedence=alive/);
      assert.doesNotMatch(options.headers.Cookie, /host=|path=|prefix=|brief=|deleted=|foreign=|suffix=|boundary=/);
      return response({ code: 0 });
    },
  ]);
  const { state } = await beginQr({ fetchImpl: mock.fetchImpl, now: NOW });
  assert.equal((await pollQr(state, { fetchImpl: mock.fetchImpl, now: NOW + 2000 })).phase, 'waiting');
});

test('Workers getAll and a combined Expires header both preserve separate cookies', async () => {
  for (const workers of [true, false]) {
    const cookies = ['one=1; Domain=.xiaomi.com; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT', 'two=2; Domain=.xiaomi.com; Path=/'];
    const real = response(HANDSHAKE);
    const header = {
      get: name => name.toLowerCase() === 'set-cookie' ? cookies.join(', ') : real.headers.get(name),
      ...(workers ? { getAll: name => { assert.equal(name, 'Set-Cookie'); return cookies; } } : {}),
    };
    const mock = callsOf([{ status: real.status, body: real.body, headers: header }, response({ lp: LP, qr: QR }), image()]);
    const { state } = await beginQr({ fetchImpl: mock.fetchImpl, now: NOW });
    assert.equal(state.cookies.find(cookie => cookie.name === 'one')?.value, '1');
    assert.equal(state.cookies.find(cookie => cookie.name === 'two')?.value, '2');
  }
});

test('a sibling host cannot set an account Cookie, and deletion does not retain an old value', async () => {
  const state = await qrState(['shared=original; Domain=.xiaomi.com; Path=/']);
  const first = await pollQr(state, {
    now: NOW,
    fetchImpl: async () => response({ code: 0 }, { cookies: [
      'shared=; Domain=.xiaomi.com; Path=/; Max-Age=0',
      'foreign=invalid; Domain=api2.mina.mi.com; Path=/',
    ] }),
  });
  assert.equal(first.state.cookies.some(cookie => cookie.name === 'shared' || cookie.name === 'foreign'), false);
});

test('login destinations reject HTTP, credentials, arbitrary ports and deceptive domain suffixes before fetching', async () => {
  const unsafe = [
    'http://account.xiaomi.com/path',
    'https://name:password@account.xiaomi.com/path',
    'https://account.xiaomi.com:8443/path',
    'https://account.xiaomi.com.evil.example/path',
    'https://c3.lp.account.xiaomi.com.evil.example/path',
    'https://evil.example/path?serviceToken=secret',
  ];
  for (const destination of unsafe) {
    for (const field of ['lp', 'qr']) {
      const mock = callsOf([response(HANDSHAKE), response({ lp: LP, qr: QR, [field]: destination })]);
      await assert.rejects(beginQr({ fetchImpl: mock.fetchImpl, now: NOW }), isError('XIAOMI_UNSAFE_URL', 502));
      assert.equal(mock.calls.length, 2);
    }
    const redirected = callsOf([response('', { status: 302, headers: { location: destination } })]);
    await assert.rejects(beginQr({ fetchImpl: redirected.fetchImpl, now: NOW }), isError('XIAOMI_UNSAFE_URL'));
    assert.equal(redirected.calls.length, 1);
  }
});

test('manual redirects are bounded and relative account redirects remain allowed', async () => {
  const redirect = () => response('', { status: 302, headers: { location: '/loop' } });
  const mock = callsOf(Array.from({ length: 6 }, redirect));
  await assert.rejects(beginQr({ fetchImpl: mock.fetchImpl, now: NOW }), isError('XIAOMI_REDIRECT_LIMIT'));
  assert.equal(mock.calls.length, 6);
  const allowed = callsOf([
    response('', { status: 302, headers: { location: '/pass/next' }, cookies: ['redirect=accepted; Path=/'] }),
    (url, options) => { assert.equal(new URL(url).pathname, '/pass/next'); assert.match(options.headers.Cookie, /redirect=accepted/); return response(HANDSHAKE); },
    response({ lp: LP, qr: QR }), image(),
  ]);
  assert.equal((await beginQr({ fetchImpl: allowed.fetchImpl, now: NOW })).state.lp, LP);
});

test('exchange rejects unsafe callback redirects without leaking credentials or upstream text', async () => {
  const state = await qrState();
  const mock = callsOf([
    response({ code: 0, nonce: '9999999999999999999', ssecurity: 'secret', location: 'https://api.mina.mi.com/sts' }),
    response('', { status: 302, headers: { location: 'https://evil.example/?passToken=upstream-secret' } }),
  ]);
  await assert.rejects(exchange({ userId: '123', passToken: 'secret-pass' }, state, { fetchImpl: mock.fetchImpl }), error => {
    isError('XIAOMI_UNSAFE_URL')(error);
    assert.doesNotMatch(String(error), /evil|upstream-secret|secret-pass|https:/);
    return true;
  });
  assert.equal(mock.calls.length, 2);
});

test('nonce-looking string content is not rewritten during signature parsing', async () => {
  const state = await qrState();
  const nonce = '900719925474099312345';
  const mock = callsOf([
    response(`{"code":0,"nonce":${nonce},"ssecurity":"secret","description":"escaped \\\"nonce\\\":123 content","location":"https://api2.mina.mi.com/sts"}`),
    (url) => {
      assert.equal(new URL(url).searchParams.get('clientSign'), createHash('sha1').update(`nonce=${nonce}&secret`).digest('base64'));
      return response('', { cookies: ['serviceToken=fresh; Path=/'] });
    },
  ]);
  assert.equal((await exchange({ userId: '123', passToken: 'pass' }, state, { fetchImpl: mock.fetchImpl })).serviceToken, 'fresh');
});

test('one poll maps an upstream timeout to waiting and never loops or extends expiration', async () => {
  const state = await qrState();
  let calls = 0;
  const result = await pollQr(state, { now: NOW + 1000, fetchImpl: async () => { calls++; throw new DOMException('private URL omitted', 'TimeoutError'); } });
  assert.equal(result.phase, 'waiting');
  assert.equal(result.state.expiresAt, state.expiresAt);
  assert.equal(calls, 1);
  await assert.rejects(pollQr(state, { now: state.expiresAt, fetchImpl: async () => { throw new Error('must not fetch'); } }), isError('XIAOMI_QR_EXPIRED', 410));
});

test('long polling has a real deadline even when the fetch implementation ignores cancellation', async t => {
  const state = await qrState();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let signal;
  const result = pollQr(state, { now: NOW, fetchImpl: async (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}); } });
  t.mock.timers.tick(25000);
  assert.equal((await result).phase, 'waiting');
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test('cancelled caller signal stops a poll before making a request', async () => {
  const state = await qrState();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pollQr(state, { now: NOW, signal: controller.signal, fetchImpl: async () => { throw new Error('must not fetch'); } }), isError('XIAOMI_CANCELLED', 499));
});

test('upstream content length, streamed body size and QR content types are bounded', async () => {
  const oversized = callsOf([response(HANDSHAKE, { headers: { 'content-length': String(512 * 1024 + 1) } })]);
  await assert.rejects(beginQr({ fetchImpl: oversized.fetchImpl, now: NOW }), isError('XIAOMI_RESPONSE_TOO_LARGE'));
  const stream = callsOf([response(' '.repeat(512 * 1024 + 1))]);
  await assert.rejects(beginQr({ fetchImpl: stream.fetchImpl, now: NOW }), isError('XIAOMI_RESPONSE_TOO_LARGE'));
  const html = callsOf([response(HANDSHAKE), response({ lp: LP, qr: QR }), response('<html>private</html>', { headers: { 'content-type': 'text/html' } })]);
  await assert.rejects(beginQr({ fetchImpl: html.fetchImpl, now: NOW }), isError('XIAOMI_INVALID_RESPONSE'));
});

test('device discovery uses only the micoapi token and returns a minimal supported-device view', async () => {
  const mock = callsOf([response({ code: 0, data: [
    { deviceID: 'l05b-id', name: '客厅', hardware: 'L05B', miotDID: 'never-return', secret: 'never-return' },
    { deviceID: 'other-id', name: '卧室', hardware: 'LX06' },
    { name: 'missing-id' }, null,
  ] })]);
  assert.deepEqual(await listDevices(ACCOUNT, { fetchImpl: mock.fetchImpl }), [
    { id: 'l05b-id', name: '客厅', hardware: 'L05B', supported: true },
    { id: 'other-id', name: '卧室', hardware: 'LX06', supported: false },
  ]);
  const { url, options } = mock.calls[0];
  assert.equal(url.pathname, '/admin/v2/device_list');
  assert.equal(url.searchParams.get('master'), '0');
  assert.match(url.searchParams.get('requestId'), /^app_ios_[a-f0-9]{30}$/);
  assert.equal(options.headers.Cookie, 'userId=123456; serviceToken=test-service-token');
  assert.match(options.headers['User-Agent'], /MICO\/iOSApp/);
});

test('L05B playback serializes the two JSON layers and sends exactly one command', async () => {
  const mock = callsOf([response({ code: 0, data: { code: 0 } })]);
  const { audioId, ...receipt } = await playMusic(ACCOUNT, 'l05b-id', AUDIO, { fetchImpl: mock.fetchImpl });
  assert.deepEqual(receipt, { outcome: 'sent', code: 0, deviceCode: 0 });
  assert.equal(mock.calls.length, 1);
  const { url, options } = mock.calls[0];
  assert.equal(url.href, 'https://api2.mina.mi.com/remote/ubus');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(options.body);
  assert.equal(form.get('deviceId'), 'l05b-id');
  assert.equal(form.get('method'), 'player_play_music');
  assert.equal(form.get('path'), 'mediaplayer');
  const message = JSON.parse(form.get('message'));
  assert.equal(message.startaudioid, audioId);
  assert.equal(typeof message.music, 'string');
  const music = JSON.parse(message.music);
  assert.equal(music.play_behavior, 'REPLACE_ALL');
  assert.equal(music.payload.audio_items.length, 1);
  assert.equal(music.payload.audio_items[0].item_id.audio_id, message.startaudioid);
  assert.deepEqual(music.payload.audio_items[0].item_id.cp, { album_id: '-1', episode_index: 0, id: '355454500', name: 'xiaowei' });
  assert.equal(music.payload.audio_items[0].stream.url, AUDIO);
  assert.deepEqual(music.payload.list_params, { listId: '-1', loadmore_offset: 0, origin: 'xiaowei', type: 'MUSIC' });
});

test('stop halts the L05B renderer with one pause operation and reports only the receipt', async () => {
  const mock = callsOf([response({ code: 0, data: '{"code":0}' })]);
  assert.equal((await stopMusic(ACCOUNT, 'l05b-id', { fetchImpl: mock.fetchImpl })).outcome, 'sent');
  assert.equal(mock.calls.length, 1);
  const form = new URLSearchParams(mock.calls[0].options.body);
  assert.equal(form.get('method'), 'player_play_operation');
  assert.deepEqual(JSON.parse(form.get('message')), { action: 'pause', media: 'app_ios' });
});

test('code 100, unfamiliar failures and incomplete receipts stay uncertain without retrying play', async () => {
  for (const body of [{ code: 100 }, { code: 100, data: { code: 0 } }, { code: 0, data: { code: 100 } }, { code: 17 }, { code: 0 }, { code: 0, data: { code: 17 } }, { unrelated: true }, 'private-invalid-json']) {
    const mock = callsOf([response(body)]);
    assert.equal((await playMusic(ACCOUNT, 'l05b-id', AUDIO, { fetchImpl: mock.fetchImpl })).outcome, 'uncertain');
    assert.equal(mock.calls.length, 1);
  }
});

test('network loss, HTTP 500 and redirects never trigger a second command', async () => {
  for (const next of [
    () => { throw new TypeError('private serviceToken and URL must stay private'); },
    () => { throw new DOMException('timeout after sending', 'TimeoutError'); },
    response({ code: 0, data: { code: 0 } }, { status: 500 }),
    response('', { status: 307, headers: { location: 'https://api2.mina.mi.com/remote/ubus' } }),
  ]) {
    const mock = callsOf([next]);
    const { audioId, ...receipt } = await playMusic(ACCOUNT, 'l05b-id', AUDIO, { fetchImpl: mock.fetchImpl });
    assert.match(audioId, /^\d+$/);
    assert.deepEqual(receipt, { outcome: 'uncertain' });
    assert.equal(mock.calls.length, 1);
  }
});

test('explicit HTTP request rejection is failed while authentication expiry is a safe exception', async () => {
  const rejected = callsOf([response('private', { status: 400 })]);
  assert.equal((await playMusic(ACCOUNT, 'l05b-id', AUDIO, { fetchImpl: rejected.fetchImpl })).outcome, 'failed');
  for (const reply of [response('private', { status: 401 }), response({ code: 3, message: 'User auth failed: private account' }), response({ code: 403 })]) {
    const mock = callsOf([reply]);
    await assert.rejects(playMusic(ACCOUNT, 'l05b-id', AUDIO, { fetchImpl: mock.fetchImpl }), isError('XIAOMI_AUTH_EXPIRED', 401));
    assert.equal(mock.calls.length, 1);
  }
});

test('pause, resume and volume use single bounded ubus requests without replacing playback', async () => {
  for (const [execute, method, message] of [
    [(options) => pauseMusic(ACCOUNT, 'l05b-id', options), 'player_play_operation', { action: 'pause', media: 'app_ios' }],
    [(options) => resumeMusic(ACCOUNT, 'l05b-id', options), 'player_play_operation', { action: 'play', media: 'app_ios' }],
    [(options) => setVolume(ACCOUNT, 'l05b-id', 37, options), 'player_set_volume', { volume: 37, media: 'app_ios' }],
  ]) {
    const mock = callsOf([response({ code: 0, data: { code: 0 } })]);
    assert.equal((await execute({ fetchImpl: mock.fetchImpl })).outcome, 'sent');
    assert.equal(mock.calls.length, 1);
    const form = new URLSearchParams(mock.calls[0].options.body);
    assert.equal(form.get('method'), method);
    assert.deepEqual(JSON.parse(form.get('message')), message);
  }
});

test('seek and optional starting offset serialize the candidate millisecond protocol once', async () => {
  const seek = callsOf([response({ code: 0, data: { code: 0 } })]);
  assert.equal((await seekMusic(ACCOUNT, 'l05b-id', 12.345, { fetchImpl: seek.fetchImpl })).outcome, 'sent');
  const form = new URLSearchParams(seek.calls[0].options.body);
  assert.equal(form.get('method'), 'player_set_positon');
  assert.deepEqual(JSON.parse(form.get('message')), { position: 12345, media: 'app_ios' });
  const start = callsOf([response({ code: 0, data: { code: 0 } })]);
  await playMusic(ACCOUNT, 'l05b-id', AUDIO, { fetchImpl: start.fetchImpl, positionSeconds: 5.25 });
  const message = JSON.parse(new URLSearchParams(start.calls[0].options.body).get('message'));
  assert.equal(message.startOffset, 5250);
  assert.equal(start.calls.length, 1);
  assert.equal(seek.calls.length, 1);
});

test('playback state selects only documented fields and normalizes milliseconds without rounding audio IDs', async () => {
  const audioId = '9223372036854775807';
  const info = `{"status":1,"volume":31,"deviceID":"private-device","play_song_detail":{"audio_id":${audioId},"position":1250,"duration":180000,"url":"https://private.invalid/?ticket=secret"}}`;
  const mock = callsOf([response({ code: 0, data: { code: 0, info } })]);
  assert.deepEqual(await getPlaybackState(ACCOUNT, 'l05b-id', { fetchImpl: mock.fetchImpl }), {
    audioId, positionSeconds: 1.25, durationSeconds: 180, volume: 31, status: 'playing',
  });
  const form = new URLSearchParams(mock.calls[0].options.body);
  assert.equal(form.get('method'), 'player_get_play_status');
  assert.deepEqual(JSON.parse(form.get('message')), { media: 'app_ios' });
});

test('missing, invalid and unfamiliar state fields stay null without inventing playback', async () => {
  const pending = callsOf([response({ code: 100, data: { code: 0, info: { status: 1, volume: 80 } } })]);
  assert.deepEqual(await getPlaybackState(ACCOUNT, 'l05b-id', { fetchImpl: pending.fetchImpl }), {
    audioId: null, positionSeconds: null, durationSeconds: null, volume: null, status: null,
  });
  assert.equal(pending.calls.length, 1);
  for (const info of [{}, { status: 9, volume: 101, play_song_detail: { position: -1, duration: '180000' } }, 'unparseable']) {
    const mock = callsOf([response({ code: 0, data: { code: 0, info } })]);
    assert.deepEqual(await getPlaybackState(ACCOUNT, 'l05b-id', { fetchImpl: mock.fetchImpl }), {
      audioId: null, positionSeconds: null, durationSeconds: null, volume: null, status: null,
    });
  }
  for (const [status, normalized] of [[0, 'idle'], [2, 'paused']]) {
    const mock = callsOf([response({ code: 0, data: JSON.stringify({ code: 0, info: { status, volume: 0, play_song_detail: { global_id: 'owned-audio', position: 0, duration: 0 } } }) })]);
    assert.deepEqual(await getPlaybackState(ACCOUNT, 'l05b-id', { fetchImpl: mock.fetchImpl }), {
      audioId: 'owned-audio', positionSeconds: 0, durationSeconds: 0, volume: 0, status: normalized,
    });
  }
});

test('opt-in state diagnostics contain only numeric status and protocol codes', async () => {
  for (const code of [0, 17]) {
    const diagnostics = [];
    const mock = callsOf([response({ code, private: 'credential-and-url-must-not-leak', data: { code: 0, info: {} } })]);
    const pending = getPlaybackState(ACCOUNT, 'l05b-id', { fetchImpl: mock.fetchImpl, diagnostic: value => diagnostics.push(value) });
    if (code === 0) await pending;
    else await assert.rejects(pending, isError('XIAOMI_UPSTREAM_ERROR', 502));
    assert.deepEqual(diagnostics, [{ httpStatus: 200 }, { code }]);
  }
});

test('new commands reject out-of-range input before fetching and do not retry unknown receipts', async () => {
  const fetchImpl = async () => { assert.fail('invalid input must not fetch'); };
  for (const volume of [-1, 101, 1.5, '30', null]) await assert.rejects(setVolume(ACCOUNT, 'l05b-id', volume, { fetchImpl }), isError('XIAOMI_INVALID_REQUEST', 400));
  for (const seconds of [-1, Infinity, NaN, 85501, '4', null]) {
    await assert.rejects(seekMusic(ACCOUNT, 'l05b-id', seconds, { fetchImpl }), isError('XIAOMI_INVALID_REQUEST', 400));
    await assert.rejects(playMusic(ACCOUNT, 'l05b-id', AUDIO, { fetchImpl, positionSeconds: seconds }), isError('XIAOMI_INVALID_REQUEST', 400));
  }
  const mock = callsOf([response({ code: 100 })]);
  assert.equal((await resumeMusic(ACCOUNT, 'l05b-id', { fetchImpl: mock.fetchImpl })).outcome, 'uncertain');
  assert.equal(mock.calls.length, 1);
});

test('invalid local credentials, audio URLs and device IDs fail before any command is sent', async () => {
  const fetchImpl = async () => { assert.fail('must not contact upstream'); };
  for (const url of ['http://music.example/audio.mp3', 'https://a:b@music.example/audio.mp3', 'https://music.example:8443/audio.mp3', 'invalid']) {
    await assert.rejects(playMusic(ACCOUNT, 'l05b-id', url, { fetchImpl }), isError('XIAOMI_INVALID_REQUEST', 400));
  }
  await assert.rejects(playMusic(ACCOUNT, '', AUDIO, { fetchImpl }), isError('XIAOMI_INVALID_REQUEST', 400));
  await assert.rejects(stopMusic({ userId: '123', serviceToken: 'bad\r\nCookie: leaked' }, 'l05b-id', { fetchImpl }), isError('XIAOMI_AUTH_EXPIRED', 401));
});
