import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createLyricReadCache } from './lyricReadCache.js';
import { tokenDigest } from '../auth/local/crypto.js';
import { makeReadyArtifact } from '../test/lyricAssetFixtures.js';
import { createInvocationDatabase } from './invocationDatabase.js';

const migrations = new URL('../../db/migrations-flaretune/', import.meta.url);
const schema = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(name, migrations), 'utf8')).join('\n');
const token = 't'.repeat(43), id = 'song-1', externalId = 'yt:abcdefghijk';
const payload = () => ({ code: 200, data: { version: 2, sourceId: 'lyrics-workbench', resultRef: 'opaque-host-validated-reference',
  lines: [{ time: 1, text: 'Hello' }], translationAvailable: true, translation: { supported: true, state: 'ready', lines: ['你好'] } } });

async function fixture(t, { cacheOptions, external = false, artifact: override } = {}) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close()); sqlite.exec(schema);
  const clock = { value: Date.now() }, songId = external ? externalId : id;
  for (const account of ['owner', 'other']) {
    sqlite.prepare("INSERT INTO accounts(account_id,username,role,created_at,updated_at) VALUES (?,?,'admin',?,?)")
      .run(account, account, clock.value - 10000, clock.value - 10000);
    sqlite.prepare(`INSERT INTO account_credentials(account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,must_change_password,updated_at)
      VALUES (?,'pbkdf2-sha256-chain',2,'{"iterations":100000,"rounds":6}',?,?,0,?)`)
      .run(account, 'A'.repeat(22), 'A'.repeat(43), clock.value);
  }
  const tokenHash = await tokenDigest(token);
  sqlite.prepare("INSERT INTO account_sessions(token_hash,account_id,mode,created_at,expires_at) VALUES (?,'owner','normal',?,?)")
    .run(tokenHash, clock.value - 10000, clock.value + 600000);
  sqlite.prepare("INSERT INTO Songs(id,title,artist,album,duration,language) VALUES (?,'Song','Artist','Album',120,'en')").run(id);
  if (external) sqlite.prepare(`INSERT INTO Member_External_Songs(account_id,song_id,source,source_id,metadata_json,updated_at)
    VALUES ('owner',?,'youtube','abcdefghijk',?,?)`).run(songId, JSON.stringify({ id: songId, title: 'Song', language: 'en' }), clock.value);
  const putSetting = (key, value) => sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,'owner')
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1`).run(key, JSON.stringify(value), clock.value);
  putSetting('lyrics.ai', { completionEnabled: true, targetLanguage: 'zh' });
  putSetting('lyrics.source-order', ['lyrics-workbench', 'youtube-music', 'file']);
  putSetting('plugin.installation.lyrics-workbench', { installed: true, epoch: 'e' });
  putSetting('plugin.delivery.v1', { activeDeployment: { buildId: 'a' } });
  sqlite.prepare(`INSERT INTO ai_model_profiles(id,name,provider,model,base_url,encrypted_key,key_iv,revision,created_at,updated_at,updated_by)
    VALUES ('p','Provider','deepseek','deepseek-flash','','cipher','iv',1,?,?,'owner')`).run(clock.value, clock.value);
  sqlite.exec(`INSERT INTO ai_profile_protocols(profile_id,source,protocol,options_json) VALUES ('p','deepseek','chat_completions','{}')`);
  const db = { calls: 0, fail: false, prepare(sql) {
    let bindings = [];
    return { bind(...values) { bindings = values; return this; }, async first() {
      db.calls++; if (db.fail) throw new Error('injected D1 outage'); return sqlite.prepare(sql).get(...bindings) || null;
    } };
  } };
  let artifact = override || makeReadyArtifact({ songId,
    aiCompletion: { status: 'completed', updatedAt: '2026-11-14T00:00:00.000Z' },
    translation: { source: 'ai', kind: 'ai', language: 'zh', originalTextHash: 'a'.repeat(64), lines: ['你好'], updatedAt: '2026-11-14T00:00:00.000Z' } });
  let revision = 1;
  const bucket = { calls: { get: 0, head: 0 }, beforeHead: null, failHead: false,
    async get() { bucket.calls.get++; const text = JSON.stringify(artifact); return artifact && { etag: 'v' + revision,
      size: new TextEncoder().encode(text).byteLength, text: async () => text }; },
    async head() { bucket.calls.head++; bucket.beforeHead?.(); if (bucket.failHead) throw new Error('injected R2 outage');
      return artifact && { etag: 'v' + revision }; } };
  const env = { DB: db, MEDIA_BUCKET: bucket, MEDIA_PREFIX: 'media', SETUP_SECRET: 'synthetic-instance-secret-longer-than-32' };
  const session = { tokenHash, mode: 'normal', account: { accountId: 'owner', role: 'admin' } };
  const cache = createLyricReadCache({ now: () => clock.value, ...cacheOptions });
  const request = (overrides = {}) => new Request('https://test.example/api/lyrics?songId=' + encodeURIComponent(songId),
    { headers: { Cookie: '__Host-ft_session=' + token, 'X-FlareTune-Expected-Account': 'owner', ...overrides.headers }, ...overrides,
      ...(overrides.headers ? { headers: { Cookie: '__Host-ft_session=' + token, 'X-FlareTune-Expected-Account': 'owner', ...overrides.headers } } : {}) });
  const begin = (req = request(), overrides = {}) => cache.begin({ request: req, env, db, session, accountId: 'owner', songId, ...overrides });
  const seed = async (body = payload()) => { const req = request(), value = await begin(req);
    assert.ok(value.ticket, 'terminal snapshot should issue an opaque fill ticket');
    assert.equal(await cache.store(value.ticket, req, body), true); };
  return { sqlite, db, bucket, env, session, cache, clock, songId, request, begin, seed, putSetting,
    changeArtifact(value = artifact) { artifact = value; revision++; }, getArtifact: () => structuredClone(artifact) };
}

test('terminal miss fills once; each hot response requires head then one fresh real SQL and returns an isolated clone', async t => {
  const f = await fixture(t); await f.seed(); f.db.calls = 0; f.bucket.calls.head = 0; f.bucket.calls.get = 0;
  const hit = await f.begin(); assert.deepEqual(hit.hitPayload, payload());
  assert.equal(f.db.calls, 1); assert.equal(f.bucket.calls.head, 1); assert.equal(f.bucket.calls.get, 0);
  hit.hitPayload.data.lines[0].text = 'Consumer mutation';
  assert.equal((await f.begin()).hitPayload.data.lines[0].text, 'Hello'); assert.equal(f.db.calls, 2);
});

test('hot-only probes preserve the instrumental cold short circuit without storage I/O', async t => {
  const f = await fixture(t, { cacheOptions: { ttlMs: 10 } });
  assert.equal((await f.begin(f.request(), { allowFill: false })).ticket, null);
  assert.deepEqual(f.bucket.calls, { get: 0, head: 0 }); assert.equal(f.db.calls, 0);
  await f.seed(); f.bucket.calls.get = 0; f.bucket.calls.head = 0; f.db.calls = 0;
  assert.ok((await f.begin(f.request(), { allowFill: false })).hitPayload);
  assert.deepEqual(f.bucket.calls, { get: 0, head: 1 }); assert.equal(f.db.calls, 1);
  f.clock.value += 11; f.bucket.calls.head = 0; f.db.calls = 0;
  const expired = await f.begin(f.request(), { allowFill: false });
  assert.equal(expired.hitPayload, null); assert.equal(expired.ticket, null);
  assert.deepEqual(f.bucket.calls, { get: 0, head: 0 }); assert.equal(f.db.calls, 0);
});

test('missing, unknown/weak, pending and failed artifacts perform zero extra D1 and never receive fill tickets', async t => {
  for (const artifact of [null, makeReadyArtifact({ songId: id }), makeReadyArtifact({ songId: id,
    aiCompletion: { status: 'pending', updatedAt: '2026-11-14T00:00:00.000Z' } }), makeReadyArtifact({ songId: id,
    aiCompletion: { status: 'failed', errorCode: 'invalid_output', updatedAt: '2026-11-14T00:00:00.000Z' } })]) {
    const f = await fixture(t); f.changeArtifact(artifact); const result = await f.begin();
    assert.equal(result.ticket, null); assert.equal(result.hitPayload, null); assert.equal(f.db.calls, 0);
  }
});

test('not_needed opaque results are cached, while pending or non-workbench results are not', async t => {
  const f = await fixture(t);
  for (const body of [{ ...payload(), data: { ...payload().data, sourceId: 'youtube-music' } },
    { ...payload(), data: { ...payload().data, translation: { state: 'pending' } } }]) {
    const req = f.request(), observation = await f.begin(req); assert.equal(await f.cache.store(observation.ticket, req, body), false);
  }
  const body = payload(); body.data.translation = { supported: false, state: 'not_needed' }; body.data.translationAvailable = false;
  await f.seed(body); assert.equal((await f.begin()).hitPayload.data.translation.state, 'not_needed');
});

for (const [name, change] of [
  ['revoked session', f => f.sqlite.exec('UPDATE account_sessions SET revoked_at=1')],
  ['expired session', f => f.sqlite.prepare('UPDATE account_sessions SET expires_at=?').run(f.clock.value - 1)],
  ['limited session mode', f => f.sqlite.exec("UPDATE account_sessions SET mode='must_change_password'")],
  ['disabled account', f => f.sqlite.exec("UPDATE accounts SET status='disabled' WHERE account_id='owner'")],
  ['changed role', f => f.sqlite.exec("UPDATE accounts SET role='member' WHERE account_id='owner'")],
  ['unusable credentials', f => f.sqlite.exec("UPDATE account_credentials SET password_hash='broken' WHERE account_id='owner'")],
  ['rotated credentials', f => f.sqlite.prepare("UPDATE account_credentials SET password_hash=? WHERE account_id='owner'").run('B'.repeat(43))],
  ['must-change credentials', f => f.sqlite.exec("UPDATE account_credentials SET must_change_password=1 WHERE account_id='owner'")],
  ['lyric target changed', f => f.putSetting('lyrics.ai', { targetLanguage: 'ja' })],
  ['source order changed', f => f.putSetting('lyrics.source-order', ['file', 'lyrics-workbench'])],
  ['installation epoch changed', f => f.putSetting('plugin.installation.lyrics-workbench', { installed: true, epoch: 'new' })],
  ['delivery changed', f => f.putSetting('plugin.delivery.v1', { activeDeployment: { buildId: 'new' } })],
  ['provider revision changed', f => f.sqlite.exec('UPDATE ai_model_profiles SET revision=revision+1')],
  ['protocol changed without provider revision', f => f.sqlite.exec("UPDATE ai_profile_protocols SET options_json='{\"temperature\":1}'")],
  ['song tag changed', f => f.sqlite.exec("UPDATE Songs SET language='zh' WHERE id='song-1'")],
  ['song deleted', f => f.sqlite.exec("DELETE FROM Songs WHERE id='song-1'")],
]) test(name + ' invalidates a cached response at the live gate', async t => {
  const f = await fixture(t); await f.seed(); change(f); const before = f.db.calls;
  assert.equal((await f.begin()).hitPayload, null); assert.equal(f.db.calls - before, 1);
});

test('another account/session, forged request cookie, resultRef and forged fill ticket cannot reuse an entry', async t => {
  const f = await fixture(t); await f.seed();
  assert.equal((await f.begin(f.request(), { accountId: 'other' })).hitPayload, null);
  assert.equal((await f.begin(f.request({ headers: { Cookie: '__Host-ft_session=' + 'x'.repeat(43) } }))).hitPayload, null);
  assert.equal((await f.begin(new Request('https://test.example/api/lyrics?songId=song-1&resultRef=x', { headers: { Cookie: '__Host-ft_session=' + token } }))).hitPayload, null);
  assert.equal(await f.cache.store({}, f.request(), payload()), false);
  const g = await fixture(t); const req = g.request(), observation = await g.begin(req);
  assert.equal(await g.cache.store(observation.ticket, g.request(), payload()), false);
});

test('one ticket cannot publish across setting or object changes between normal-read snapshots', async t => {
  for (const change of [f => f.putSetting('lyrics.ai', { targetLanguage: 'ja' }), f => f.changeArtifact()]) {
    const f = await fixture(t), req = f.request(), observation = await f.begin(req); change(f);
    assert.equal(await f.cache.store(observation.ticket, req, payload()), false);
    assert.equal(await f.cache.store(observation.ticket, req, payload()), false, 'tickets are single-use');
  }
});

test('object edits/deletion, R2/D1 failures and missing head always fall through', async t => {
  for (const change of [f => f.changeArtifact(), f => f.changeArtifact(null), f => { f.bucket.failHead = true; },
    f => { f.db.fail = true; }, f => { delete f.bucket.head; }]) {
    const f = await fixture(t); await f.seed(); change(f); assert.equal((await f.begin()).hitPayload, null);
  }
});

test('an aborted request never publishes a cache hit or a new fill', async t => {
  const f = await fixture(t); await f.seed(); const controller = new AbortController();
  f.bucket.beforeHead = () => controller.abort(); const before = f.db.calls;
  assert.equal((await f.begin(f.request({ signal: controller.signal }))).hitPayload, null); assert.equal(f.db.calls, before);
  const g = await fixture(t), owner = new AbortController(), req = g.request({ signal: owner.signal });
  const observation = await g.begin(req); owner.abort(); assert.equal(await g.cache.store(observation.ticket, req, payload()), false);
});

test('external metadata must exist for this account and changes invalidate opaque results', async t => {
  const f = await fixture(t, { external: true }); await f.seed();
  assert.ok((await f.begin()).hitPayload);
  f.sqlite.prepare("UPDATE Member_External_Songs SET metadata_json=? WHERE account_id='owner'").run('{"language":"ru"}');
  assert.equal((await f.begin()).hitPayload, null);
  f.sqlite.exec("DELETE FROM Member_External_Songs WHERE account_id='owner'");
  assert.equal((await f.begin()).ticket, null);
});

test('raw database wrappers share data cache scope without sharing their fresh invocation gate', async t => {
  const f = await fixture(t); await f.seed(); const controller = new AbortController();
  const wrapped = createInvocationDatabase(f.db, controller.signal);
  const before = f.db.calls;
  assert.ok((await f.begin(f.request(), { db: wrapped, env: { ...f.env, DB: wrapped } })).hitPayload);
  assert.equal(f.db.calls - before, 1);
});

test('TTL, bounded LRU and oversized payloads disable stale or oversized cache entries', async t => {
  const f = await fixture(t, { cacheOptions: { ttlMs: 10, maxEntries: 1 } }); await f.seed();
  f.clock.value += 11; assert.equal((await f.begin()).hitPayload, null);
  const g = await fixture(t, { cacheOptions: { maxEntryBytes: 128 } }); const req = g.request(), observation = await g.begin(req);
  assert.equal(await g.cache.store(observation.ticket, req, payload()), false);
  const h = await fixture(t, { cacheOptions: { maxEntries: 1 } }); await h.seed();
  const req2 = h.request({ headers: { 'Accept-Language': 'ja' } }), next = await h.begin(req2);
  assert.equal(await h.cache.store(next.ticket, req2, payload()), true);
  assert.equal((await h.begin()).hitPayload, null, 'different locale entry evicted the older entry');
});
