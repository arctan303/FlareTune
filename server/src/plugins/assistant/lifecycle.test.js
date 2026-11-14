import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../routes/localAssistant.fixture.js';
import { handleLocalAssistantRoute, createAssistantHandler } from './handler.js';
import { createPluginContext } from '../context.js';
import { pluginRegistry } from '../registry.js';
import { KNOWN_MIGRATIONS } from '../../instance/schemaManifest.js';

const paths = ['/api/ai', '/api/account/plugins/assistant'];
const body = id => ({ revision: 0, client_message_id: id, message: '你好', enable_thinking: false });
const events = async response => (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
const envOf = f => ({ DB: f.db, DEEPSEEK_API_KEY: 'assistant-test-only-key' });
async function install(f, id, installed = true) {
  f.sqlite.exec("UPDATE accounts SET role='admin' WHERE account_id='account-A'");
  return pluginRegistry.setInstalled(envOf(f), f.session('account-A'), id,
    { installed, revision: (await pluginRegistry.readInstallation(envOf(f), id)).revision });
}

test('new and legacy assistant URLs share installation, dependency, role and build gates', async t => {
  const f = fixture({ installed: false }); t.after(() => f.sqlite.close());
  for (const prefix of paths) assert.equal((await f.route(`${prefix}/bootstrap`, 'GET')).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM music_chat_threads').get().n, 0);
  await assert.rejects(install(f, 'assistant'), { code: 'PLUGIN_DEPENDENCY_MISSING' });
  await install(f, 'ai-gateway'); await install(f, 'assistant');
  for (const prefix of paths) assert.equal((await f.route(`${prefix}/bootstrap`, 'GET', undefined, 'account-B')).status, 200);
  await assert.rejects(pluginRegistry.setInstalled(envOf(f), f.session('account-B'), 'assistant', { installed: false, revision: 1 }), { code: 'forbidden' });
  const context = await createPluginContext({ env: envOf(f), session: f.session('account-B'), pluginId: 'assistant' });
  const denied = await createAssistantHandler(envOf(f), f.session('account-B'))({ request: f.request('/config'), path: '/config', scope: 'admin', context });
  assert.equal(denied.status, 403);
  for (const prefix of paths) for (const digest of [null, '0'.repeat(64)]) {
    const request = new Request(`https://flare.test${prefix}/bootstrap`, { headers: digest ? { 'X-FlareTune-Plugin-Build': digest } : {} });
    assert.equal((await handleLocalAssistantRoute(request, new URL(request.url), f.db, {}, f.session('account-B'), envOf(f))).status, 409);
  }
});

test('uninstall preserves account history and memory while old/new APIs stop working; reinstall restores own data', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  await f.route('/api/ai/memory', 'POST', { content: '我喜欢爵士乐' });
  await events(await f.route('/api/ai/chat', 'POST', body('history'), 'account-A', { chat: async () => ({ type: 'content', content: '收到' }) }));
  const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM music_chat_thread_messages').get().n;
  await install(f, 'assistant', false);
  for (const prefix of paths) assert.equal((await f.route(`${prefix}/thread`, 'GET')).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM music_chat_thread_messages').get().n, before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM assistant_memories').get().n, 1);
  await install(f, 'assistant');
  const own = await (await f.route('/api/account/plugins/assistant/thread', 'GET')).json();
  assert.deepEqual(own.thread.messages.map(row => row.content), ['你好', '收到']);
  const foreign = await (await f.route('/api/account/plugins/assistant/thread', 'GET', undefined, 'account-B')).json();
  assert.deepEqual(foreign.thread.messages, []);
});

for (const retirement of ['assistant-uninstall', 'gateway-epoch', 'logout']) {
  test(`${retirement} retires in-flight provider results, events, tools and completion writes`, async t => {
    const f = fixture(); t.after(() => f.sqlite.close());
    const response = await f.route('/api/ai/chat', 'POST', body(retirement), 'account-A', { pollIntervalMs: 5,
      chat: async (_messages, _tools, _config, _privateEnv, options) => {
        if (retirement === 'logout') f.sqlite.exec('UPDATE account_sessions SET revoked_at=1');
        else {
          const id = retirement === 'gateway-epoch' ? 'ai-gateway' : 'assistant';
          f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(
            JSON.stringify({ installed: retirement === 'gateway-epoch', epoch: crypto.randomUUID() }), `plugin.installation.${id}`);
        }
        options.onContentDelta?.('This late text must not escape');
        return { type: 'function_calls', functionCalls: [{ id: 'late-create', name: 'manage_playlist', args: { action: 'create', name: '迟到歌单' } }] };
      } });
    const result = await events(response);
    assert.equal(result.some(event => ['content_delta', 'content', 'player_action', 'tool_call', 'tool_result', 'done'].includes(event.type)), false);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE name='迟到歌单'").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM music_chat_thread_messages WHERE role='assistant'").get().n, 0);
  });
}

test('plugin retirement inside the final tool transaction guard prevents a playlist mutation', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => { const statement = prepare(sql); statement.sql = sql; return statement; };
  const batch = f.db.batch.bind(f.db);
  let raced = false;
  f.db.batch = async statements => {
    if (!raced && statements.some(statement => /INSERT INTO Member_Playlists/.test(statement.sql || ''))) {
      raced = true;
      f.sqlite.prepare('UPDATE instance_settings SET value_json=? WHERE key=?').run(
        JSON.stringify({ installed: false, epoch: crypto.randomUUID() }), 'plugin.installation.assistant');
    }
    return batch(statements);
  };
  const result = await events(await f.route('/api/ai/chat', 'POST', body('tool-race'), 'account-A', { chat: async () => ({
    type: 'function_calls', functionCalls: [{ id: 'create', name: 'manage_playlist', args: { action: 'create', name: '被撤销的歌单' } }] }) }));
  assert.equal(raced, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE name='被撤销的歌单'").get().n, 0);
  assert.equal(result.some(event => event.type === 'done'), false);
});

test('assistant playlist confirmation uses account ownership, revision, favorite and plugin transaction guards', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  f.sqlite.exec(`INSERT INTO Member_Playlists(id,account_id,kind,name,revision,created_at,updated_at)
    VALUES ('own','account-A','regular','Own',3,1,1),('foreign','account-B','regular','Foreign',1,1,1),('favorite','account-A','favorite','Favorite',0,1,1)`);
  const route = input => f.route('/api/account/plugins/assistant/playlist-delete', 'POST', input);
  assert.equal((await route({ playlistId: 'foreign', revision: 1 })).status, 404);
  assert.equal((await route({ playlistId: 'favorite', revision: 0 })).status, 409);
  assert.equal((await route({ playlistId: 'own', revision: 2 })).status, 409);
  const success = await route({ playlistId: 'own', revision: 3 });
  assert.equal(success.status, 200); assert.equal((await success.json()).data.deletedPlaylistId, 'own');
  assert.ok(f.sqlite.prepare("SELECT id FROM Member_Playlists WHERE id='foreign'").get());
});

test('runtime retirement aborts a provider which is waiting without publishing a successful turn', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  let started, providerAborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  const response = await f.route('/api/ai/chat', 'POST', body('abort-provider'), 'account-A', { pollIntervalMs: 5,
    chat: async (_messages, _tools, _config, _privateEnv, options) => {
      started();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        providerAborted = true; reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true }));
    } });
  await entered;
  f.sqlite.exec('UPDATE account_sessions SET revoked_at=1');
  const result = await events(response);
  assert.equal(providerAborted, true);
  assert.equal(result.some(event => event.type === 'done'), false);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM music_chat_thread_messages WHERE role='assistant'").get().n, 0);
});

test('assistant instance config and image settings retain revision and administrator permissions', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  f.sqlite.exec("UPDATE accounts SET role='admin' WHERE account_id='account-A'");
  const migration = KNOWN_MIGRATIONS.find(row => row.version === 2);
  f.sqlite.prepare(`INSERT INTO ft_migrations(version,name,checksum,stage,state,started_at,completed_at)
    VALUES (?,?,?,?,'completed',1,1)`).run(migration.version, migration.name, migration.checksum, migration.stage);
  f.sqlite.exec('UPDATE ft_instance SET schema_version=2,initialized_at=1 WHERE id=1');
  const session = f.session('account-A'), env = envOf(f);
  const context = await createPluginContext({ env, session, pluginId: 'assistant' });
  const handler = createAssistantHandler(env, session);
  const call = (path, method = 'GET', payload) => handler({ request: f.request(path, method, payload), path, scope: 'admin', context });
  const original = await (await call('/settings')).json();
  assert.deepEqual(Object.keys(original.settings), ['assistant.images_enabled']);
  assert.equal(Object.hasOwn(original, 'secrets'), false);
  const { revision, ...patch } = original.assistant;
  patch.name = 'Listener helper';
  assert.equal((await call('/config', 'PUT', { patch, expectedRevision: revision })).status, 200);
  assert.equal((await call('/config', 'PUT', { patch, expectedRevision: revision })).status, 409);
  const images = await call('/settings/images', 'PUT', { value: true, expectedRevision: 0 });
  assert.equal(images.status, 200); assert.equal((await images.json()).value, true);
  assert.equal((await (await call('/settings')).json()).assistant.name, 'Listener helper');
});

for (const path of ['/settings', '/config']) test(`administrator demotion during ${path} rejects private assistant configuration`, async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  f.sqlite.exec("UPDATE accounts SET role='admin' WHERE account_id='account-A'");
  const session = f.session('account-A'), env = envOf(f);
  const context = await createPluginContext({ env, session, pluginId: 'assistant' });
  const prepare = f.db.prepare.bind(f.db), batch = f.db.batch.bind(f.db);
  f.db.prepare = sql => { const statement = prepare(sql); statement.sql = sql; return statement; };
  let demoted = false;
  f.db.batch = async statements => {
    const result = await batch(statements);
    if (statements.some(statement => /SELECT name,description,avatar_icon,persona/.test(statement.sql || ''))) {
      f.sqlite.exec("UPDATE accounts SET role='member' WHERE account_id='account-A'"); demoted = true;
    }
    return result;
  };
  const response = await createAssistantHandler(env, session)({ request: f.request(path), path, scope: 'admin', context });
  assert.equal(demoted, true);
  assert.notEqual(response.status, 200);
  assert.doesNotMatch(await response.text(), /persona|system_rules|defaults/);
});
