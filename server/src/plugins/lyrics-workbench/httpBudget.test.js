import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../../flaretune.js';
import { fixture } from '../../subsonic/test-support.js';
import { pluginRegistry } from '../registry.js';
import { buildReadyLyricArtifact } from '../../services/lyricAssetWorkflow.js';
import { DEFAULT_LYRIC_AI_CONFIG } from '../../utils/lyricAiConfig.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function app(t, length = 144) {
  const f = await fixture(); t.after(f.close);
  f.sqlite.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES ('lyrics.ai',?,1,1,'test')`).run(JSON.stringify({ ...DEFAULT_LYRIC_AI_CONFIG, model: 'deepseek-flash' }));
  const song = f.sqlite.prepare("SELECT * FROM Songs WHERE id='s1'").get();
  const saved = await buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc', lines:
    Array.from({ length }, (_, index) => ({ time: index, text: `I sing unique verse number ${index} under a blue sky` })) });
  f.objects.set('media/lyrics/s1.json', { bytes: new TextEncoder().encode(JSON.stringify(saved.artifact)), type: 'application/json' });
  f.env.DEEPSEEK_API_KEY = 'fixture-key';
  for (const id of ['lyrics-workbench', 'ai-gateway']) await pluginRegistry.setInstalled(f.env, f.signed.session, id, { installed: true, revision: 0 });
  const initialized = await f.api('admin/plugins/lyrics-workbench/model/initialize', 'POST', { expectedRevision: 0 }, f.signed,
    { 'X-FlareTune-Plugin-Build': pluginRegistry.getBuildDigest('lyrics-workbench') });
  assert.equal(initialized.status, 200, await initialized.clone().text());
  const tasks = [], calls = []; let nativeLimit = 0;
  const prepare = f.db.prepare.bind(f.db), batch = f.db.batch.bind(f.db);
  const spend = method => { calls.push(method); if (calls.length > 50) { nativeLimit++; throw new Error('D1 native Free binding limit'); } };
  f.db.prepare = sql => {
    const statement = prepare(sql);
    for (const method of ['first', 'all', 'run']) { const execute = statement[method].bind(statement); statement[method] = (...args) => { spend(method); return execute(...args); }; }
    return statement;
  };
  f.db.batch = statements => { spend('batch'); return batch(statements); };
  const read = () => JSON.parse(new TextDecoder().decode(f.objects.get('media/lyrics/s1.json').bytes));
  const request = async (kind, auth = f.signed) => {
    const path = kind === 'playback' ? '/api/lyrics?songId=s1' : kind === 'legacy' ? '/api/lyrics/workspace/s1/ai-completion'
      : `/api/account/plugins/lyrics-workbench/workspace/s1/${kind === 'draft' ? 'draft-ai' : 'ai-completion'}`;
    const response = await worker.fetch(new Request('https://test.example' + path, { method: kind === 'playback' ? 'GET' : 'POST',
      headers: { Cookie: auth.cookie, Origin: 'https://test.example', 'X-Requested-With': 'FlareTune', 'Content-Type': 'application/json',
        'X-CSRF-Token': auth.session.csrfToken, 'X-FlareTune-Plugin-Build': pluginRegistry.getBuildDigest('lyrics-workbench') },
      ...(kind === 'playback' ? {} : { body: JSON.stringify(kind === 'draft' ? { lines: saved.artifact.original.lines, etag: 'test-etag' } : {}) }),
    }), f.env, { waitUntil: task => tasks.push(task) });
    const body = await response.json(); await Promise.allSettled(tasks);
    return { response, body };
  };
  return { ...f, request, tasks, calls, read, nativeLimit: () => nativeLimit, controlEnv: { ...f.env, DB: { prepare, batch } } };
}
function reply(options, mode = 'normal') {
  const data = JSON.parse(JSON.parse(options.body).messages.find(message => message.role === 'user').content);
  return Response.json({ choices: [{ message: { content: mode === 'invalid' ? '{invalid' : JSON.stringify({
    ...(data.languageSample ? { songLanguage: 'en', discardLineIndices: [] } : {}),
    ...(mode === 'not-needed' ? { notNeeded: true } : { translations: data.units.map(unit => ({ unitId: unit.unitId, text: `这是第${unit.unitId}行译文` })) }),
  }) } }] });
}

test('all browser lyric AI consumers complete 144-line translation under the whole HTTP Free budget', async t => {
  for (const kind of ['playback', 'manual', 'legacy', 'draft']) await t.test(kind, async t => {
    const f = await app(t); let upstream = 0;
    t.mock.method(globalThis, 'fetch', async (input, options) => { upstream++; return reply(options); });
    const result = await f.request(kind);
    assert.ok(result.response.ok, JSON.stringify(result.body)); assert.equal(upstream, 9);
    if (kind === 'draft') {
      assert.equal(result.body.data?.lines.length, 144); assert.ok(result.body.data.lines.every(line => line.tlyric));
      assert.equal(f.read().translation, null); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
    } else {
      assert.equal(f.read().translation?.lines.length, 144, JSON.stringify(f.read().aiCompletion));
      assert.equal(f.read().aiCompletion, null); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, 'en');
    }
    assert.equal(f.nativeLimit(), 0); assert.ok(f.calls.length <= 50);
    t.diagnostic(`${kind} 144 lines entire HTTP+waitUntil: ${f.calls.length}/50 D1 bindings`);
  });
});

test('mixed not-needed compact batches finish their extra completion ask before settlement', async t => {
  for (const kind of ['playback', 'manual', 'draft']) await t.test(kind, async t => {
    const f = await app(t, 32); let upstream = 0;
    t.mock.method(globalThis, 'fetch', async (input, options) => reply(options, ++upstream === 1 ? 'not-needed' : 'normal'));
    const result = await f.request(kind); assert.ok(result.response.ok, JSON.stringify(result.body)); assert.equal(upstream, 3);
    const lines = kind === 'draft' ? result.body.data?.lines : f.read().translation?.lines;
    assert.equal(lines?.length, 32); assert.equal(f.nativeLimit(), 0); assert.ok(f.calls.length <= 50);
  });
});

test('every browser consumer retains one invalid-JSON retry for a 144-line translation', async t => {
  for (const kind of ['playback', 'manual', 'legacy', 'draft']) await t.test(kind, async t => {
    const f = await app(t); let upstream = 0;
    t.mock.method(globalThis, 'fetch', async (input, options) => reply(options, ++upstream === 1 ? 'invalid' : 'normal'));
    const result = await f.request(kind); assert.ok(result.response.ok, JSON.stringify(result.body)); assert.equal(upstream, 10);
    const lines = kind === 'draft' ? result.body.data?.lines : f.read().translation?.lines;
    assert.equal(lines?.length, 144); assert.equal(f.nativeLimit(), 0); assert.ok(f.calls.length <= 50);
    t.diagnostic(`${kind} 144 lines plus JSON retry: ${f.calls.length}/50 D1 bindings`);
  });
});

test('browser consumers reserve safe budget settlement across retry and waiting and recover on a fresh invocation', async t => {
  for (const kind of ['playback', 'manual', 'legacy', 'draft']) await t.test(kind, async t => {
    const f = await app(t), entered = deferred(), released = deferred(); let first = true, upstream = 0;
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      upstream++;
      if (first) { first = false; entered.resolve(); await released.promise; return reply(options, 'invalid'); }
      return reply(options);
    });
    const pending = f.request(kind); await entered.promise;
    for (let second = 1; second <= 24; second++) { t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); }
    released.resolve(); const result = await pending;
    assert.equal(f.read().translation, null); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
    if (kind === 'draft') { assert.equal(result.response.status, 503); assert.equal(f.read().aiCompletion, null); }
    else { assert.equal(f.read().aiCompletion?.status, 'failed'); assert.equal(f.read().aiCompletion.errorCode, 'request_budget_exhausted'); }
    assert.equal(f.nativeLimit(), 0); assert.ok(f.calls.length <= 50);
    t.diagnostic(`${kind} wait/retry safely settled: ${f.calls.length}/50 D1 bindings`);
    f.calls.length = 0; f.tasks.length = 0; const before = upstream;
    const retry = await f.request(kind); assert.ok(retry.response.ok, JSON.stringify(retry.body)); assert.equal(upstream - before, 9);
    const lines = kind === 'draft' ? retry.body.data?.lines : f.read().translation?.lines;
    assert.equal(lines?.length, 144); assert.equal(f.nativeLimit(), 0); assert.ok(f.calls.length <= 50);
  });
});

test('members can invoke shared AI but not draft AI; a draft administrator downgraded after model resolution cannot call upstream', async t => {
  const f = await app(t, 16), member = await f.signIn('member'); f.calls.length = 0; let upstream = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => { upstream++; return reply(options); });
  assert.equal((await f.request('draft', member)).response.status, 403); assert.equal(upstream, 0);
  f.calls.length = 0; f.tasks.length = 0;
  assert.equal((await f.request('manual', member)).response.status, 202); assert.equal(upstream, 1); assert.ok(f.read().translation);
  const g = await app(t, 16), batch = g.db.batch.bind(g.db); let downgraded = false;
  g.db.batch = async statements => {
    const before = g.db.queries.length, result = await batch(statements);
    if (!downgraded && g.db.queries.slice(before).some(sql => sql.includes('SELECT value_json,revision FROM instance_settings WHERE key=?'))) {
      downgraded = true; g.sqlite.prepare("UPDATE accounts SET role='member' WHERE account_id=?").run(g.owner);
    }
    return result;
  };
  const before = upstream; const draft = await g.request('draft');
  assert.equal(downgraded, true); assert.equal(draft.response.status, 403); assert.equal(upstream, before);
  assert.equal(g.read().translation, null); assert.equal(g.read().aiCompletion, null);
});

test('an administrator downgraded during draft AI cannot return a receipt or publish a shared mutation', async t => {
  const f = await app(t, 16), entered = deferred(), released = deferred();
  const before = JSON.stringify(f.read());
  t.mock.method(globalThis, 'fetch', async (input, options) => { entered.resolve(); await released.promise; return reply(options); });
  const pending = f.request('draft'); await entered.promise;
  f.sqlite.prepare("UPDATE accounts SET role='member' WHERE account_id=?").run(f.owner);
  released.resolve(); const result = await pending;
  assert.equal(result.response.status, 403); assert.equal(result.body.data?.receipt, undefined);
  assert.equal(JSON.stringify(f.read()), before); assert.equal(f.nativeLimit(), 0);
});

test('Gateway uninstall during every browser AI consumer discards delayed shared writes and draft receipts', async t => {
  for (const kind of ['playback', 'manual', 'legacy', 'draft']) await t.test(kind, async t => {
    const f = await app(t, 16), entered = deferred(), released = deferred();
    t.mock.method(globalThis, 'fetch', async (input, options) => { entered.resolve(); await released.promise; return reply(options); });
    const pending = f.request(kind); await entered.promise; const before = JSON.stringify(f.read());
    await pluginRegistry.setInstalled(f.controlEnv, f.signed.session, 'ai-gateway', { installed: false, revision: 1 });
    released.resolve(); const result = await pending;
    assert.equal(JSON.stringify(f.read()), before); assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, null);
    assert.equal(result.body.data?.receipt, undefined); if (kind === 'draft') assert.equal(result.response.status, 409);
    assert.equal(f.nativeLimit(), 0);
  });
});

test('all not-needed compact batches settle without a translation and do not run again for the same policy', async t => {
  const f = await app(t, 32); let upstream = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => { upstream++; return reply(options, 'not-needed'); });
  assert.equal((await f.request('playback')).response.status, 200); assert.equal(upstream, 2);
  assert.equal(f.read().translation, null); assert.equal(f.read().aiCompletion?.status, 'completed');
  assert.equal(f.sqlite.prepare("SELECT language FROM Songs WHERE id='s1'").get().language, 'en');
  f.calls.length = 0; f.tasks.length = 0;
  assert.equal((await f.request('playback')).response.status, 200); assert.equal(upstream, 2); assert.equal(f.nativeLimit(), 0);
});
