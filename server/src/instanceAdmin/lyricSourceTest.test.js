import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { MIGRATION_BUNDLE } from '../instance/migrationBundle.generated.js';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';
import { handleApi } from '../instance/httpRouter.js';
import { sessionCookie } from '../auth/local/index.js';
import { csrfTokenForSession, tokenDigest } from '../auth/local/crypto.js';
import { testLyricSource } from './lyricSourceTest.js';

const SONG = { title: '夜航', artist: '歌手甲', duration: 200 };
const SOURCE = { protocol: 'custom_krc', searchUrl: 'https://lyrics.example.com/search',
  downloadUrl: 'https://lyrics.example.com/download', translationLanguage: 'zh' };
const input = (source = SOURCE, song = SONG) => ({ source: { ...source }, song: { ...song } });
const candidate = (id = 'candidate-1') => ({ id, accesskey: `private-accesskey-${id}`,
  song: SONG.title, singer: SONG.artist, duration: 200_000 });
const base64 = text => Buffer.from(text, 'utf8').toString('base64');
const KRC_KEY = Uint8Array.from([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]);
function krc(text) {
  const zipped = deflateSync(Buffer.from(text, 'utf8'));
  return Buffer.concat([Buffer.from('krc1'), Buffer.from(zipped.map((byte, index) => byte ^ KRC_KEY[index % KRC_KEY.length]))]).toString('base64');
}
const WORD_CONTENT = krc(`[language:${base64(JSON.stringify({ version: 1,
  content: [{ type: 1, language: 0, lyricContent: [['现在我们'], ['脱下鞋子']] }] }))}]\n`
  + '[1000,1000]<0,1000,0>僕らは今\n[2000,1000]<0,1000,0>靴を脱ぐ');

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATION_BUNDLE) for (const sql of migration.statements) sqlite.exec(sql);
  const migration = KNOWN_MIGRATIONS.find(item => item.version === 2);
  sqlite.prepare("INSERT INTO ft_migrations(version,name,checksum,stage,state,started_at,completed_at) VALUES (?,?,?,?,'completed',1,1)")
    .run(migration.version, migration.name, migration.checksum, migration.stage);
  sqlite.exec(`UPDATE ft_instance SET schema_version=2, initialized_at=1 WHERE id=1;
    INSERT INTO accounts(account_id,username,role,status,created_at,updated_at)
      VALUES ('admin','owner','admin','active',1,1),('member','reader','member','active',1,1),('disabled','disabled','admin','disabled',1,1);
    INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      VALUES ('lyrics.sources','{"saved":"configuration must remain untouched"}',7,1,'admin');`);
  for (const id of ['admin', 'member', 'disabled']) {
    sqlite.prepare(`INSERT INTO account_credentials(account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,updated_at)
      VALUES (?,'pbkdf2-sha256-chain',2,'{"iterations":100000,"rounds":6}',?,?,1)`)
      .run(id, Buffer.alloc(16, 1).toString('base64url'), Buffer.alloc(32, 2).toString('base64url'));
  }
  let writes = 0;
  const db = { prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; },
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { writes++; return { success: true, meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
  }; }, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const item of statements) results.push(await item.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const snapshot = () => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]);
  const signIn = async (accountId = 'admin') => {
    const token = Buffer.alloc(32, accountId === 'admin' ? 3 : 4).toString('base64url');
    const now = Date.now();
    sqlite.prepare("INSERT INTO account_sessions(token_hash,account_id,mode,created_at,expires_at) VALUES (?,?,'normal',?,?)")
      .run(await tokenDigest(token), accountId, now, now + 60_000);
    return { Cookie: sessionCookie(token).split(';')[0], 'X-CSRF-Token': await csrfTokenForSession(token) };
  };
  return { db, sqlite, snapshot, signIn, writes: () => writes };
}

function assertSafeSummary(result) {
  assert.ok(Number.isSafeInteger(result.elapsedMs) && result.elapsedMs >= 0);
  assert.ok(Number.isSafeInteger(result.candidateCount) && result.candidateCount >= 0);
  assert.doesNotMatch(JSON.stringify(result), /https?:|accesskey|private-|僕ら|靴を|lyrics\.example/u);
  assert.ok(Object.keys(result).every(key => ['status', 'stage', 'kind', 'syncMode', 'lineCount',
    'hasTranslation', 'candidateCount', 'elapsedMs'].includes(key)));
}

test('draft probe searches and parses actual KRC, LRC or plain lyrics without persisting settings, lyrics, AI or candidate data', async t => {
  const f = fixture(t);
  const before = f.snapshot();
  for (const [syncMode, content, hasTranslation] of [
    ['word', WORD_CONTENT, true],
    ['line', base64('[00:01.00]第一句\n[00:02.00]第二句'), false],
    ['none', base64('第一句\n第二句'), false],
  ]) {
    const seen = [];
    const result = await testLyricSource(f.db, 'admin', input(), { fetchImpl: async (url, init) => {
      const parsed = new URL(url); seen.push(parsed);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Accept, 'application/json');
      if (parsed.pathname === '/search') return Response.json({ candidates: [candidate()] });
      assert.equal(parsed.searchParams.get('accesskey'), 'private-accesskey-candidate-1');
      return Response.json({ content: parsed.searchParams.get('fmt') === 'krc' && syncMode !== 'word' ? base64('broken-krc') : content });
    } });
    assert.deepEqual({ ...result, elapsedMs: 0 }, { status: 'ready', stage: 'parse', syncMode,
      lineCount: 2, hasTranslation, candidateCount: 1, elapsedMs: 0 });
    assert.equal(seen[0].searchParams.get('keyword'), '歌手甲-夜航');
    assert.equal(seen[0].searchParams.get('duration'), '200000');
    assert.deepEqual(seen.slice(1).map(url => url.searchParams.get('fmt')), syncMode === 'word' ? ['krc'] : ['krc', 'lrc']);
    assertSafeSummary(result);
    assert.deepEqual(f.snapshot(), before);
  }
  assert.equal(f.writes(), 0);
});

test('empty candidates are no_matches, while malformed search data is a failed search', async t => {
  const { db } = fixture(t);
  for (const [payload, status, kind] of [[{ candidates: [] }, 'no_matches', undefined], [{}, 'failed', 'invalid']]) {
    let downloads = 0;
    const result = await testLyricSource(db, 'admin', input(), { fetchImpl: async url => {
      if (new URL(url).pathname !== '/search') downloads++;
      return Response.json(payload);
    } });
    assert.equal(result.status, status); assert.equal(result.stage, 'search');
    assert.equal(result.kind, kind); assert.equal(result.candidateCount, 0); assert.equal(downloads, 0);
    assertSafeSummary(result);
  }
});

test('probe falls back through the top three candidates, and never downloads a fourth', async t => {
  const { db } = fixture(t);
  for (const thirdWorks of [true, false]) {
    const downloads = [];
    let searches = 0;
    const result = await testLyricSource(db, 'admin', input(), { fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.pathname === '/search') {
        searches++;
        return Response.json({ candidates: ['a', 'b', 'c', 'd'].map(candidate) });
      }
      const id = parsed.searchParams.get('id'); downloads.push(id);
      if (thirdWorks && id === 'c') return Response.json({ content: WORD_CONTENT });
      return Response.json({}, { status: 404 });
    } });
    assert.equal(searches, 1); assert.equal(result.candidateCount, 4);
    assert.equal(result.status, thirdWorks ? 'ready' : 'failed');
    assert.deepEqual([...new Set(downloads)], ['a', 'b', 'c']);
    assert.equal(downloads.includes('d'), false);
    assertSafeSummary(result);
  }
});

test('draft probe retains its sixteen-request ceiling and safe rate-limited summary across search and fallback formats', async t => {
  const { db } = fixture(t);
  const song = { title: 'Song (feat. Guest)', artist: 'Artist / Singer', duration: 200.6 };
  let requests = 0, searches = 0;
  const result = await testLyricSource(db, 'admin', input(SOURCE, song), { fetchImpl: async raw => {
    requests += 1;
    if (new URL(raw).pathname === '/search') {
      searches += 1;
      return Response.json({ candidates: searches < 12 ? [] : ['a', 'b', 'c'].map(id => ({
        id, accesskey: 'private', song: song.title, singer: song.artist, duration: 200600,
      })) });
    }
    return new Response(null, { status: 404 });
  } });
  assert.equal(requests, 16);
  assert.equal(searches, 12);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'download');
  assert.equal(result.kind, 'rate_limited');
  assert.equal(result.candidateCount, 3);
  assertSafeSummary(result);
});

test('failures identify search, download and parse stages without returning raw upstream details', async t => {
  const { db } = fixture(t);
  for (const scenario of [
    { stage: 'search', kind: 'network', search: () => { throw new Error('https://private.example.com/?accesskey=private-key'); } },
    { stage: 'download', kind: 'upstream', download: () => Response.json({ error: 'private-key' }, { status: 500 }) },
    { stage: 'parse', kind: 'invalid', download: url => Response.json({ content: url.searchParams.get('fmt') === 'krc' ? base64('broken') : base64('[ar:credits]') }) },
  ]) {
    const result = await testLyricSource(db, 'admin', input(), { fetchImpl: async raw => {
      const url = new URL(raw);
      return url.pathname === '/search'
        ? scenario.search ? scenario.search() : Response.json({ candidates: [candidate()] })
        : scenario.download(url);
    } });
    assert.equal(result.status, 'failed'); assert.equal(result.stage, scenario.stage); assert.equal(result.kind, scenario.kind);
    assertSafeSummary(result);
  }
});

test('redirects are not followed and oversized header or streamed responses fail within the size limit', async t => {
  const { db } = fixture(t);
  let cancelled = false;
  for (const makeResponse of [
    () => new Response(null, { status: 302, headers: { Location: 'https://private.example.com/redirect?accesskey=private-key' } }),
    () => new Response('{}', { headers: { 'Content-Length': '4000001' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4_000_001)); },
      cancel() { cancelled = true; } })),
  ]) {
    let calls = 0;
    const result = await testLyricSource(db, 'admin', input(), { fetchImpl: async (_url, init) => {
      calls++; assert.equal(init.redirect, 'manual'); return makeResponse();
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'failed'); assert.equal(result.stage, 'search');
    assert.equal(result.kind, 'invalid'); assertSafeSummary(result);
  }
  assert.equal(cancelled, true);
});

test('total deadline and caller abort cancel outstanding work and return distinct safe classifications', async t => {
  const { db } = fixture(t);
  const signalAwareFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const timeout = await testLyricSource(db, 'admin', input(), { fetchImpl: signalAwareFetch, budgetMs: 5 });
  assert.equal(timeout.status, 'failed'); assert.equal(timeout.kind, 'timeout'); assert.equal(timeout.stage, 'search');
  assertSafeSummary(timeout);
  const controller = new AbortController();
  const pending = testLyricSource(db, 'admin', input(), { signal: controller.signal,
    fetchImpl: async (url, init) => {
      controller.abort(new Error('private-caller-detail'));
      return signalAwareFetch(url, init);
    } });
  const aborted = await pending;
  assert.equal(aborted.status, 'failed'); assert.equal(aborted.kind, 'aborted'); assertSafeSummary(aborted);
  let calls = 0;
  const preAborted = await testLyricSource(db, 'admin', input(), { signal: controller.signal,
    fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(preAborted.kind, 'aborted'); assert.equal(calls, 0);
});

test('illegal destinations and malformed draft/song input are rejected before any network request', async t => {
  const { db } = fixture(t);
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw new Error('invalid draft must not fetch'); } };
  for (const endpoint of ['http://lyrics.example.com/search', 'https://127.0.0.1/search', 'https://2130706433/search',
    'https://[::1]/search', 'https://service.local/search', 'https://lyrics.example.com:8443/search',
    'https://user:password@lyrics.example.com/search', 'https://lyrics.example.com/search?accesskey=secret',
    'https://lyrics.example.com/search#fragment', ' https://lyrics.example.com/search', 'https://lyrics.example.com/has space', '']) {
    for (const field of ['searchUrl', 'downloadUrl']) {
      await assert.rejects(testLyricSource(db, 'admin', input({ ...SOURCE, [field]: endpoint }), options), { code: 'invalid_input', status: 400 });
    }
  }
  for (const malformed of [null, [], {}, { ...input(), song: null }, { ...input(), source: [] },
    { ...input(), extra: 'ignored?' }, input({ ...SOURCE, protocol: 'lrclib' }),
    input({ ...SOURCE, translationLanguage: 'invalid' }), input({ ...SOURCE, headers: { Cookie: 'private-key' } }),
    input(SOURCE, { ...SONG, title: '' }), input(SOURCE, { ...SONG, artist: '   ' }),
    input(SOURCE, { ...SONG, title: 'x'.repeat(301) }), input(SOURCE, { ...SONG, artist: 'bad\nartist' }),
    input(SOURCE, { ...SONG, duration: '200' }), input(SOURCE, { ...SONG, duration: 0 }),
    input(SOURCE, { ...SONG, duration: 86401 }), input(SOURCE, { ...SONG, duration: Infinity }),
    input(SOURCE, { ...SONG, id: 'untrusted-song-id' })]) {
    await assert.rejects(testLyricSource(db, 'admin', malformed, options), { code: 'invalid_input', status: 400 });
  }
  assert.equal(calls, 0);
});

test('service rejects anonymous, member, missing and disabled administrators before fetching', async t => {
  const { db } = fixture(t);
  let calls = 0;
  for (const actor of [null, 'member', 'missing', 'disabled']) {
    await assert.rejects(testLyricSource(db, actor, input(), { fetchImpl: async () => { calls++; } }), { code: 'forbidden', status: 403 });
  }
  assert.equal(calls, 0);
});

test('actual HTTP route rejects anonymous/member/CSRF/Origin failures and permits an authenticated draft test without persistence', async t => {
  const f = fixture(t);
  const admin = await f.signIn('admin'), member = await f.signIn('member');
  const before = f.snapshot();
  const path = '/api/admin/lyrics/source-test';
  const headers = { Origin: 'https://app.example.com', 'X-Requested-With': 'FlareTune', 'Content-Type': 'application/json' };
  const mock = t.mock.method(globalThis, 'fetch', async url => new URL(url).pathname === '/search'
    ? Response.json({ candidates: [candidate()] }) : Response.json({ content: WORD_CONTENT }));
  for (const [auth, extra, status, error] of [
    [{}, {}, 401, 'authentication_required'], [member, {}, 403, 'forbidden'],
    [admin, { 'X-CSRF-Token': '' }, 403, 'csrf_rejected'],
    [admin, { Origin: 'https://foreign.example.com' }, 403, 'csrf_rejected'],
  ]) {
    const response = await handleApi(new Request(`https://app.example.com${path}`, { method: 'POST',
      headers: { ...headers, ...auth, ...extra }, body: JSON.stringify(input()) }), { DB: f.db }, path);
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
    assert.equal(mock.mock.callCount(), 0);
  }
  const response = await handleApi(new Request(`https://app.example.com${path}`, { method: 'POST',
    headers: { ...headers, ...admin }, body: JSON.stringify(input()) }), { DB: f.db }, path);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const result = await response.json();
  assert.equal(result.status, 'ready'); assert.equal(result.syncMode, 'word'); assertSafeSummary(result);
  assert.equal(mock.mock.callCount(), 2);
  assert.deepEqual(f.snapshot(), before); assert.equal(f.writes(), 0);
});
