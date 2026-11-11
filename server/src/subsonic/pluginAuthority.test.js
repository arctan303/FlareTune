import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, PASSWORD } from './test-support.js';
import { authenticate, subsonicPrincipalForAccount } from './credentials.js';
import { createSubsonicPluginServiceLease } from './pluginAuthority.js';
import { pluginRegistry } from '../plugins/registry.js';
import { md5 } from './md5.js';
import { buildReadyLyricArtifact } from '../services/lyricAssetWorkflow.js';
import { DEFAULT_LYRIC_AI_CONFIG } from '../utils/lyricAiConfig.js';

const payload = async response => (await response.json())['subsonic-response'];
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const aiReply = () => Response.json({ choices: [{ message: { content: JSON.stringify({
  songLanguage: 'ja', discardLineIndices: [], translations: [{ unitId: 0, text: '你好' }],
}) } }] });
const artifact = f => JSON.parse(new TextDecoder().decode(f.objects.get('media/lyrics/s1.json').bytes));
async function install(f, id, installed = true) {
  return pluginRegistry.setInstalled(f.env, f.signed.session, id,
    { installed, revision: (await pluginRegistry.readInstallation(f.env, id)).revision });
}
async function initializeWorkbenchModel(f) {
  const response = await f.api('admin/plugins/lyrics-workbench/model/initialize', 'POST', { expectedRevision: 0 }, f.signed,
    { 'X-FlareTune-Plugin-Build': pluginRegistry.getBuildDigest('lyrics-workbench') });
  assert.equal(response.status, 200, await response.clone().text());
}
async function setup(t, installed = true) {
  const f = await fixture(); t.after(f.close);
  const member = await f.signIn('member'); await f.enable(member);
  f.sqlite.prepare(`INSERT OR REPLACE INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES ('lyrics.ai',?,1,1,'test')`).run(JSON.stringify({ ...DEFAULT_LYRIC_AI_CONFIG,
    completionEnabled: true, automaticCompletionEnabled: true }));
  const song = f.sqlite.prepare("SELECT * FROM Songs WHERE id='s1'").get();
  const saved = await buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc', lines: [{ time: 1, text: 'Hello' }] });
  f.objects.set('media/lyrics/s1.json', { bytes: new TextEncoder().encode(JSON.stringify(saved.artifact)), type: 'application/json' });
  f.env.DEEPSEEK_API_KEY = 'fixture-key';
  if (installed) for (const id of ['lyrics-workbench', 'ai-gateway']) await install(f, id);
  if (installed) await initializeWorkbenchModel(f);
  const principal = async () => {
    const account = await authenticate(f.db, new URLSearchParams({ u: 'member', t: md5(`${PASSWORD}fixture-salt`), s: 'fixture-salt' }), f.env);
    return subsonicPrincipalForAccount(account);
  };
  const lease = async principal => createSubsonicPluginServiceLease({ env: f.env, principal,
    consumerId: 'lyrics-workbench', providerId: 'ai-gateway' });
  return { ...f, member, principal, lease };
}

function enforceBindingBudget(db, maximum) {
  const calls = []; const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const count = (method, sql) => {
    calls.push({ method, sql });
    if (calls.length > maximum) throw new Error('D1 invocation binding budget exceeded');
  };
  db.prepare = sql => {
    const statement = prepare(sql);
    for (const method of ['first', 'all', 'run']) {
      const execute = statement[method].bind(statement);
      statement[method] = (...args) => { count(method, sql); return execute(...args); };
    }
    return statement;
  };
  db.batch = statements => { count('batch', 'guarded batch'); return batch(statements); };
  return calls;
}

async function compactLyrics(f, lineCount) {
  f.sqlite.prepare("UPDATE instance_settings SET value_json=? WHERE key='lyrics.ai'")
    .run(JSON.stringify({ ...DEFAULT_LYRIC_AI_CONFIG, model: 'deepseek-flash' }));
  const modelKey = 'plugin.data.lyrics-workbench.instance.ai-model';
  const selected = f.sqlite.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').get(modelKey);
  const value = JSON.parse(selected.value_json);
  value.selection.model = 'deepseek-flash';
  f.sqlite.prepare('UPDATE instance_settings SET value_json=?,revision=revision+1 WHERE key=?').run(JSON.stringify(value), modelKey);
  const song = f.sqlite.prepare("SELECT * FROM Songs WHERE id='s1'").get();
  const saved = await buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc',
    lines: Array.from({ length: lineCount }, (_, unitId) => ({ time: unitId, text: `I sing unique verse number ${unitId} under a blue sky` })) });
  f.objects.set('media/lyrics/s1.json', { bytes: new TextEncoder().encode(JSON.stringify(saved.artifact)), type: 'application/json' });
}

function batchReply(options) {
  const data = JSON.parse(JSON.parse(options.body).messages.find(message => message.role === 'user').content);
  return Response.json({ choices: [{ message: { content: JSON.stringify({
    ...(data.languageSample ? { songLanguage: 'en', discardLineIndices: [] } : {}),
    translations: data.units.map(unit => ({ unitId: unit.unitId, text: `这是第${unit.unitId}行译文` })),
  }) } }] });
}

test('only genuine Subsonic authentication issues an opaque playback principal; it creates no browser session', async t => {
  const f = await setup(t); const before = f.sqlite.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count;
  assert.equal(subsonicPrincipalForAccount({ accountId: 'member', username: 'member' }), null);
  for (const forged of [{}, { accountId: 'member' }, { accountId: f.owner, role: 'admin' }]) {
    await assert.rejects(f.lease(forged), error => error.code === 'PLUGIN_SERVICE_PRINCIPAL_INVALID');
  }
  const principal = await f.principal(); assert.equal(JSON.stringify(principal), '{}');
  const lease = await f.lease(principal);
  assert.deepEqual(lease.identity, { accountId: 'member', role: 'member', mode: 'subsonic' });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count, before);
  await assert.rejects(createSubsonicPluginServiceLease({ env: f.env, principal,
    consumerId: 'assistant', providerId: 'ai-gateway' }), error => error.code === 'PLUGIN_SERVICE_FEATURE_FORBIDDEN');
  await assert.rejects(createSubsonicPluginServiceLease({ env: { ...f.env, SETUP_SECRET: 'rotated-secret-32-characters-long' }, principal,
    consumerId: 'lyrics-workbench', providerId: 'ai-gateway' }), error => error.code === 'PLUGIN_SERVICE_PRINCIPAL_INVALID');
});

test('Subsonic service lease pins credentials, opt-in, account role/status and both installation epochs', async t => {
  const cases = [
    ["UPDATE instance_settings SET revision=revision+1 WHERE key='account.subsonic.member'"],
    ["UPDATE instance_settings SET value_json='{}' WHERE key='account.subsonic.member'"],
    ["UPDATE account_credentials SET password_hash=(CASE substr(password_hash,1,1) WHEN 'A' THEN 'B' ELSE 'A' END)||substr(password_hash,2) WHERE account_id='member'"],
    ["UPDATE account_credentials SET salt='changed-salt' WHERE account_id='member'"],
    ["UPDATE account_credentials SET must_change_password=1 WHERE account_id='member'"],
    ["UPDATE accounts SET role='admin' WHERE account_id='member'"],
    ["UPDATE accounts SET status='disabled' WHERE account_id='member'"],
  ];
  const f = await setup(t);
  for (const [sql] of cases) {
    const principal = await f.principal(); const lease = await f.lease(principal);
    f.sqlite.exec('SAVEPOINT revoke'); f.sqlite.exec(sql);
    await assert.rejects(lease.assertCurrent(), error => error.code === 'PLUGIN_SERVICE_RETIRED');
    await assert.rejects(lease.guardedDb(f.db).prepare("UPDATE Songs SET language='ja' WHERE id='s1'").run());
    assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
    f.sqlite.exec('ROLLBACK TO revoke; RELEASE revoke');
  }
  for (const id of ['lyrics-workbench', 'ai-gateway']) {
    const principal = await f.principal(); const lease = await f.lease(principal);
    await install(f, id, false); await install(f, id);
    await assert.rejects(lease.assertCurrent(), error => error.code === 'PLUGIN_SERVICE_RETIRED');
    await assert.rejects(f.lease(principal), error => error.code === 'PLUGIN_SERVICE_RETIRED');
    await (await f.lease(await f.principal())).assertCurrent();
  }
});

test('Subsonic final SQL guard rolls back the business write if authority changes inside the batch', async t => {
  const f = await setup(t); const lease = await f.lease(await f.principal()); const db = lease.guardedDb(f.db);
  let changed = false;
  f.db.beforeWrite = sql => {
    if (changed || !sql.startsWith('UPDATE Songs SET language')) return;
    changed = true; f.sqlite.exec("UPDATE instance_settings SET revision=revision+1 WHERE key='account.subsonic.member'");
  };
  await assert.rejects(db.prepare("UPDATE Songs SET language='ja' WHERE id='s1'").run());
  f.db.beforeWrite = null;
  assert.equal(changed, true); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
});

test('both Subsonic lyric endpoints keep original reads without plugins, and run the same automatic AI after installation', async t => {
  const f = await setup(t, false); let calls = 0; const tasks = [];
  t.mock.method(globalThis, 'fetch', async input => { assert.ok(new URL(input).hostname.includes('deepseek')); calls++; return aiReply(); });
  const options = { username: 'member', executionContext: { waitUntil: task => tasks.push(task) } };
  assert.equal((await payload(await f.rest('getLyrics', { id: 's1' }, options))).lyrics.value, 'Hello');
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }, options))).status, 'ok');
  await install(f, 'lyrics-workbench'); await f.rest('getLyricsBySongId', { id: 's1' }, options);
  await Promise.all(tasks); assert.equal(calls, 0); assert.equal(artifact(f).aiCompletion, null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM AI_Daily_Usage').get().count, 0);
  await install(f, 'ai-gateway');
  await initializeWorkbenchModel(f);
  assert.equal((await payload(await f.rest('getLyrics', { id: 's1' }, options))).lyrics.value, 'Hello');
  await Promise.all(tasks); assert.equal(calls, 1); assert.equal(artifact(f).translation.lines[0], '你好');
  const refreshed = await payload(await f.rest('getLyricsBySongId', { id: 's1', enhanced: true }, options));
  assert.equal(refreshed.lyricsList.structuredLyrics[1].line[0].value, '你好');
  assert.equal(f.sqlite.prepare('SELECT generation_count FROM AI_Daily_Usage').get().generation_count, 1);
});

test('Subsonic automatic AI preserves the established quota limit', async t => {
  const f = await setup(t); f.env.AI_TRANSLATION_DAILY_LIMIT = '0'; const tasks = [];
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Quota must stop upstream'); });
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }, { username: 'member',
    executionContext: { waitUntil: task => tasks.push(task) } }))).status, 'ok');
  await Promise.all(tasks);
  assert.equal(upstream.mock.calls.length, 0); assert.equal(artifact(f).aiCompletion.errorCode, 'quota_exhausted');
});

test('complete authenticated Subsonic automatic AI including waitUntil fits the Free 50 binding limit', async t => {
  for (const endpoint of ['getLyricsBySongId', 'getLyrics']) {
    const f = await setup(t), tasks = []; let upstreamCalls = 0;
    const upstream = t.mock.method(globalThis, 'fetch', async () => { upstreamCalls++; return aiReply(); });
    const calls = enforceBindingBudget(f.db, 50);
    try {
      const result = await payload(await f.rest(endpoint, { id: 's1' }, { username: 'member',
        executionContext: { waitUntil: task => tasks.push(task) } }));
      assert.equal(result.status, 'ok'); await Promise.all(tasks);
      assert.equal(upstreamCalls, 1); assert.equal(artifact(f).translation?.lines[0], '你好');
      assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, 'ja');
      assert.ok(calls.length <= 50, JSON.stringify(calls));
      t.diagnostic(`${endpoint} including waitUntil: ${calls.length}/50 D1 bindings`);
    } finally { upstream.mock.restore(); }
  }
});

test('Subsonic automatic AI retains the 50 binding budget through 24 seconds of upstream polling', async t => {
  const f = await setup(t), tasks = [], entered = deferred(), reply = deferred(); let upstreamCalls = 0;
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(globalThis, 'fetch', async () => { upstreamCalls++; entered.resolve(); await reply.promise; return aiReply(); });
  const calls = enforceBindingBudget(f.db, 50);
  const result = await payload(await f.rest('getLyricsBySongId', { id: 's1' }, { username: 'member',
    executionContext: { waitUntil: task => tasks.push(task) } }));
  assert.equal(result.status, 'ok'); await entered.promise;
  const beforePolling = calls.length;
  for (let second = 1; second <= 24; second++) {
    t.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
  }
  const pollCalls = calls.length - beforePolling;
  reply.resolve(); await Promise.all(tasks);
  assert.equal(pollCalls, 12); assert.equal(upstreamCalls, 1); assert.equal(artifact(f).translation?.lines[0], '你好');
  assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, 'ja');
  assert.ok(calls.length <= 50); t.diagnostic(`24s upstream polling including waitUntil: ${calls.length}/50 D1 bindings (${pollCalls} waiting checks)`);
});

test('144-line compact translation and its one JSON retry complete within the full Subsonic 50 binding limit', async t => {
  for (const retry of [false, true]) {
    const f = await setup(t), tasks = []; await compactLyrics(f, 144); let upstreamCalls = 0;
    const upstream = t.mock.method(globalThis, 'fetch', async (input, options) => {
      upstreamCalls++;
      if (retry && upstreamCalls === 1) return Response.json({ choices: [{ message: { content: '{invalid' } }] });
      return batchReply(options);
    });
    const calls = enforceBindingBudget(f.db, 50);
    try {
      const result = await payload(await f.rest('getLyricsBySongId', { id: 's1' }, { username: 'member',
        executionContext: { waitUntil: task => tasks.push(task) } }));
      assert.equal(result.status, 'ok'); await Promise.all(tasks);
      assert.equal(upstreamCalls, retry ? 10 : 9); assert.equal(artifact(f).translation?.lines.length, 144);
      assert.equal(artifact(f).aiCompletion, null); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, 'en');
      assert.ok(calls.length <= 50); t.diagnostic(`144 lines${retry ? ' with JSON retry' : ''}: ${calls.length}/50 D1 bindings`);
    } finally { upstream.mock.restore(); }
  }
});

test('multi-batch AI with JSON retry and upstream waiting reserves failed settlement and a later request can retry', async t => {
  const f = await setup(t), tasks = [], entered = deferred(), reply = deferred(); await compactLyrics(f, 144);
  t.mock.timers.enable({ apis: ['setInterval'] }); let upstreamCalls = 0, waitFirst = true;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    upstreamCalls++;
    if (waitFirst) {
      waitFirst = false; entered.resolve(); await reply.promise;
      return Response.json({ choices: [{ message: { content: '{invalid' } }] });
    }
    return batchReply(options);
  });
  const calls = enforceBindingBudget(f.db, 50);
  const options = { username: 'member', executionContext: { waitUntil: task => tasks.push(task) } };
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }, options))).status, 'ok');
  await entered.promise;
  for (let second = 1; second <= 24; second++) { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); }
  reply.resolve(); await Promise.all(tasks);
  assert.equal(artifact(f).translation, null); assert.equal(artifact(f).aiCompletion?.status, 'failed');
  assert.equal(artifact(f).aiCompletion?.errorCode, 'request_budget_exhausted');
  assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
  assert.ok(calls.length <= 50); t.diagnostic(`144 lines plus waiting failed safely: ${calls.length}/50 D1 bindings`);
  calls.length = 0; tasks.length = 0; const priorCalls = upstreamCalls;
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }, options))).status, 'ok');
  await Promise.all(tasks);
  assert.equal(upstreamCalls - priorCalls, 9); assert.equal(artifact(f).translation?.lines.length, 144);
  assert.equal(artifact(f).aiCompletion, null); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, 'en');
  assert.ok(calls.length <= 50); t.diagnostic(`next invocation retry completes: ${calls.length}/50 D1 bindings`);
});

test('ordinary 176 and 200-line compact lyrics fully complete within the entire invocation budget', async t => {
  for (const length of [176, 200]) {
    const f = await setup(t), tasks = []; await compactLyrics(f, length); let upstreamCalls = 0;
    const upstream = t.mock.method(globalThis, 'fetch', async (input, options) => { upstreamCalls++; return batchReply(options); });
    const calls = enforceBindingBudget(f.db, 50);
    try {
      assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }, { username: 'member',
        executionContext: { waitUntil: task => tasks.push(task) } }))).status, 'ok');
      await Promise.all(tasks);
      assert.equal(upstreamCalls, Math.ceil(length / 16)); assert.equal(artifact(f).translation?.lines.length, length);
      assert.equal(artifact(f).aiCompletion, null); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, 'en');
      assert.ok(calls.length <= 50); t.diagnostic(`${length} lines fully complete: ${calls.length}/50 D1 bindings`);
    } finally { upstream.mock.restore(); }
  }
});

test('Subsonic mixed not-needed compact batches retain the final completion request before settling', async t => {
  const f = await setup(t), tasks = []; await compactLyrics(f, 32); let upstream = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => ++upstream === 1
    ? Response.json({ choices: [{ message: { content: JSON.stringify({ songLanguage: 'en', discardLineIndices: [], notNeeded: true }) } }] })
    : batchReply(options));
  const calls = enforceBindingBudget(f.db, 50);
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }, { username: 'member',
    executionContext: { waitUntil: task => tasks.push(task) } }))).status, 'ok');
  await Promise.all(tasks); assert.equal(upstream, 3); assert.equal(artifact(f).translation?.lines.length, 32);
  assert.equal(artifact(f).aiCompletion, null); assert.ok(calls.length <= 50);
});

test('larger compact lyrics exceeding the request budget finish as failed without a partial translation or pending lock', async t => {
  const f = await setup(t), tasks = []; await compactLyrics(f, 224); let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => { upstreamCalls++; return batchReply(options); });
  const calls = enforceBindingBudget(f.db, 50);
  assert.equal((await payload(await f.rest('getLyricsBySongId', { id: 's1' }, { username: 'member',
    executionContext: { waitUntil: task => tasks.push(task) } }))).status, 'ok');
  await Promise.all(tasks);
  assert.equal(upstreamCalls, 13); assert.equal(artifact(f).translation, null);
  assert.equal(artifact(f).aiCompletion?.status, 'failed'); assert.equal(artifact(f).aiCompletion.errorCode, 'request_budget_exhausted');
  assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
  assert.ok(calls.length <= 50); t.diagnostic(`224 lines settle without partial save: ${calls.length}/50 D1 bindings`);
});

test('opt-in withdrawal, credential changes and either plugin reinstall discard delayed Subsonic AI without shared writes', async t => {
  for (const revoke of ['opt-in', 'password', 'workbench', 'gateway']) {
    const f = await setup(t); const entered = deferred(), response = deferred(), tasks = [];
    const upstream = t.mock.method(globalThis, 'fetch', async () => { entered.resolve(); await response.promise; return aiReply(); });
    try {
      const result = await payload(await f.rest('getLyricsBySongId', { id: 's1' }, { username: 'member',
        executionContext: { waitUntil: task => tasks.push(task) } }));
      assert.equal(result.status, 'ok'); await entered.promise;
      const pending = JSON.stringify(artifact(f));
      if (revoke === 'opt-in') {
        const status = await (await f.api('account/subsonic', 'GET', undefined, f.member)).json();
        assert.equal((await f.api('account/subsonic', 'PUT', { enabled: false, expectedRevision: status.revision }, f.member)).status, 200);
      } else if (revoke === 'password') f.sqlite.exec("UPDATE account_credentials SET must_change_password=1 WHERE account_id='member'");
      else { const id = revoke === 'workbench' ? 'lyrics-workbench' : 'ai-gateway'; await install(f, id, false); await install(f, id); }
      response.resolve(); await Promise.allSettled(tasks);
      assert.equal(JSON.stringify(artifact(f)), pending, revoke);
      assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null, revoke);
    } finally { response.resolve(); upstream.mock.restore(); }
  }
});
