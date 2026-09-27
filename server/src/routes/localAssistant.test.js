import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalAssistantRoute } from './localAssistant.js';
import { fixture } from './localAssistant.fixture.js';
import { assignAiProfile, createAiProfile } from '../instanceAdmin/aiProfiles.js';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';
import { executeLocalManagePlaylist } from '../tools/localManagePlaylist.js';
import { songDetailsTool } from '../tools/songDetails.js';

const chatBody = (revision = 0, clientId = 'turn-1') => ({
  revision, client_message_id: clientId, message: '你好', enable_thinking: false, context: {},
});

const parseEvents = (text) => text.split('\n\n')
  .filter(Boolean).map((line) => JSON.parse(line.slice('data: '.length)));
const streamEvents = async (response) => parseEvents(await response.text());

const musicCall = (args = { action: 'search', keyword: '星河' }, id = 'call-1') => ({
  type: 'function_calls', functionCalls: [{ id, name: 'music_query', args }],
});
const availableToolNames = [
  'music_query', 'my_listening_stats', 'my_playlists', 'get_current_playback',
  'current_time', 'manage_playlist', 'music_control', 'player_queue',
  'player_seek', 'roam_control',
  'song_details',
];
const statsCall = (args = {}, id = 'stats-1') => ({
  type: 'function_calls', functionCalls: [{ id, name: 'my_listening_stats', args }],
});
const playlistCall = (args = { action: 'list' }, id = 'playlist-1') => ({
  type: 'function_calls', functionCalls: [{ id, name: 'my_playlists', args }],
});

test('bootstrap reads local assistant config and never exposes persona, rules or key', async () => {
  const { sqlite, route } = fixture();
  try {
    const response = await route('/api/ai/bootstrap', 'GET');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.assistant.name, '小A');
    assert.equal(body.user.accountId, 'account-A');
    assert.equal(body.systemPolicyVersion, 3);
    assert.equal('persona' in body.assistant, false);
    assert.equal('systemRules' in body.assistant, false);
    assert.equal('provider' in body.assistant, false);
    assert.equal(JSON.stringify(body).includes('test-secret'), false);
  } finally { sqlite.close(); }
});

test('assistant chat uses the assigned model profile and its credential', async () => {
  const { sqlite, db, request, session } = fixture();
  try {
    sqlite.exec(`INSERT INTO accounts (account_id, username, display_name, role, status, created_at, updated_at)
      VALUES ('admin', 'owner', 'Owner', 'admin', 'active', 1, 1);`);
    sqlite.prepare(`INSERT INTO account_credentials (account_id, kdf, kdf_version,
      kdf_params_json, salt, password_hash, must_change_password, updated_at)
      VALUES ('admin', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}', ?, ?, 0, 1)`)
      .run(Buffer.alloc(16, 1).toString('base64url'), Buffer.alloc(32, 2).toString('base64url'));
    const migration = KNOWN_MIGRATIONS.find(({ version }) => version === 2);
    sqlite.prepare(`INSERT INTO ft_migrations (version, name, checksum, stage, state, started_at, completed_at)
      VALUES (?, ?, ?, ?, 'completed', 1, 1)`).run(migration.version, migration.name,
      migration.checksum, migration.stage);
    sqlite.exec(`UPDATE ft_instance SET schema_version = 2, initialized_at = 1 WHERE id = 1`);
    const env = { SETUP_SECRET: 's'.repeat(48), DEEPSEEK_API_KEY: 'legacy-key' };
    const profile = await createAiProfile(db, 'admin', { name: '聊天', provider: 'openai',
      model: 'custom-chat', baseUrl: 'https://api.example.test/v1', apiKey: 'profile-secret' }, env);
    await assignAiProfile(db, 'admin', 'assistant', profile.id, 0);
    const seen = [];
    const req = request('/api/ai/chat', 'POST', chatBody());
    const response = await handleLocalAssistantRoute(req, new URL(req.url), db, {},
      session('account-A'), env, { chat: async (messages, tools, config, aiEnv) => {
        seen.push({ config, aiEnv });
        return { type: 'content', content: '已连接' };
      } });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(seen[0].config.model, 'custom-chat');
    assert.equal(seen[0].config.provider, 'openai');
    assert.equal(seen[0].aiEnv.OPENAI_API_KEY, 'profile-secret');
    assert.equal(seen[0].aiEnv.OPENAI_BASE_URL, 'https://api.example.test/v1');
  } finally { sqlite.close(); }
});

test('thread and chat are scoped by account_id with idempotent revisions', async () => {
  const { sqlite, route } = fixture();
  try {
    const empty = await route('/api/ai/thread', 'GET');
    assert.equal((await empty.json()).thread.revision, 0);
    const aiCalls = [];
    const answer = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async (messages, tools, config, env) => {
        aiCalls.push({ messages, tools, config, env });
        return { type: 'content', content: '你好，听什么？' };
      },
    });
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get('Content-Type'), /^text\/event-stream/);
    assert.match(await answer.text(), /"type":"done"/);
    assert.equal(aiCalls.length, 1);
    assert.deepEqual(aiCalls[0].tools.map((tool) => tool.function.name), availableToolNames);
    assert.match(aiCalls[0].messages[0].content, /不编造/);
    assert.equal(aiCalls[0].env.DEEPSEEK_API_KEY, 'test-secret');
    const thread = (await (await route('/api/ai/thread', 'GET')).json()).thread;
    assert.equal(thread.revision, 2);
    assert.deepEqual(thread.messages.map(({ role, content }) => [role, content]), [
      ['user', '你好'], ['assistant', '你好，听什么？'],
    ]);
    const other = (await (await route('/api/ai/thread', 'GET', undefined, 'account-B')).json()).thread;
    assert.equal(other.revision, 0);
    assert.deepEqual(other.messages, []);
    const duplicate = await route('/api/ai/chat', 'POST', chatBody());
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'duplicate_message');
    const stale = await route('/api/ai/chat', 'POST', chatBody(0, 'turn-2'));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).revision, 2);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM music_chat_turns').get().count, 1);
  } finally { sqlite.close(); }
});

test('music_query sends tool data without persisting reply-end song cards', async () => {
  const { sqlite, route } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Songs (id,title,artist,album,audio_url,cover_url,language)
      VALUES ('song-1','星河','甲','星空','/media/audio/song-1.mp3','/media/cover/song-1.jpg','zh')`).run();
    const calls = [];
    const answer = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async (messages, tools) => {
        calls.push({ messages: structuredClone(messages), tools });
        return calls.length === 1 ? musicCall() : { type: 'content', content: '曲库里有《星河》。' };
      },
    });
    assert.equal(answer.status, 200);
    const events = await streamEvents(answer);
    assert.deepEqual(calls.map(({ tools }) => tools.map((tool) => tool.function.name)), [
      availableToolNames, availableToolNames,
    ]);
    assert.deepEqual(calls[1].messages.slice(-2).map((message) => message.role), ['assistant', 'tool']);
    assert.equal(calls[1].messages.at(-1).tool_call_id, 'call-1');
    assert.match(calls[1].messages.at(-1).content, /星河/);
    assert.deepEqual(events.map((event) => event.type), [
      'tool_call', 'tool_result', 'content', 'thread_state', 'done',
    ]);
    assert.equal(events[0].displayName, '检索乐境曲库');
    assert.equal(events[1].data.songs[0].id, 'song-1');
    assert.equal(Object.hasOwn(events[3].thread.messages.at(-1), 'displaySongs'), false);
    const persisted = (await (await route('/api/ai/thread', 'GET')).json()).thread;
    assert.equal(Object.hasOwn(persisted.messages.at(-1), 'songs'), false);
    assert.equal(Object.hasOwn(persisted.messages.at(-1), 'displaySongs'), false);
    const storedExtra = JSON.parse(sqlite.prepare(`SELECT extra_json FROM music_chat_thread_messages
      WHERE account_id='account-A' AND role='assistant'`).get().extra_json);
    assert.equal(Object.hasOwn(storedExtra, 'songs'), false);
    assert.equal(Object.hasOwn(storedExtra, 'displaySongs'), false);
    sqlite.prepare(`UPDATE music_chat_thread_messages SET extra_json = ?
      WHERE account_id='account-A' AND role='assistant'`)
      .run(JSON.stringify({ ...storedExtra, songs: [{ id: 'song-1' }], displaySongs: [{ id: 'song-1' }] }));
    const legacyThread = (await (await route('/api/ai/thread', 'GET')).json()).thread;
    assert.equal(Object.hasOwn(legacyThread.messages.at(-1), 'songs'), false);
    assert.equal(Object.hasOwn(legacyThread.messages.at(-1), 'displaySongs'), false);
    assert.match(legacyThread.messages.at(-1).content, /星河/);
    const other = (await (await route('/api/ai/thread', 'GET', undefined, 'account-B')).json()).thread;
    assert.deepEqual(other.messages, []);
  } finally { sqlite.close(); }
});

test('personal listening stats use session account only and persist account-scoped summary', async () => {
  const { sqlite, route } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Songs (id,title,artist,audio_url) VALUES
      ('song-A','A 的歌','甲','/media/audio/a.mp3'),
      ('song-B','B 的歌','乙','/media/audio/b.mp3')`).run();
    sqlite.prepare(`INSERT INTO Member_Song_Plays (account_id,song_id,play_count,last_played_at)
      VALUES ('account-A','song-A',4,100),('account-B','song-B',9,200)`).run();
    const answerFor = async (actor, expectedTitle) => {
      let calls = 0;
      const answer = await route('/api/ai/chat', 'POST', {
        ...chatBody(), context: { accountId: actor === 'account-A' ? 'account-B' : 'account-A',
          user_sub: 'legacy-impostor' },
      }, actor, {
        chat: async (messages, tools) => {
          calls += 1;
          assert.deepEqual(tools.map((tool) => tool.function.name), availableToolNames);
          if (calls === 1) return statsCall({ limit: 1 });
          assert.match(messages.at(-1).content, new RegExp(expectedTitle));
          return { type: 'content', content: `你最常听${expectedTitle}。` };
        },
      });
      assert.equal(answer.status, 200);
      return streamEvents(answer);
    };
    const aEvents = await answerFor('account-A', 'A 的歌');
    assert.deepEqual(aEvents.map((event) => event.type), [
      'tool_call', 'tool_result', 'content', 'thread_state', 'done',
    ]);
    assert.equal(aEvents[0].name, 'my_listening_stats');
    assert.equal(aEvents[0].displayName, '我的收听统计');
    assert.match(aEvents[0].progress, /收听统计|播放数据/);
    assert.equal(aEvents[1].data.total_plays, 4);
    assert.deepEqual(aEvents[1].data.songs.map((song) => song.id), ['song-A']);
    assert.equal(Object.hasOwn(aEvents[3].thread.messages.at(-1), 'displaySongs'), false);
    assert.deepEqual(aEvents[3].thread.messages.at(-1).toolSummaries,
      [{ id: 'stats-1', name: 'my_listening_stats', summary: '读到 1 首收听最多的歌曲', ok: true,
        totalPlays: 4, totalUniqueSongs: 1 }]);
    const bEvents = await answerFor('account-B', 'B 的歌');
    assert.equal(bEvents[1].data.total_plays, 9);
    assert.deepEqual(bEvents[1].data.songs.map((song) => song.id), ['song-B']);
    const aThread = (await (await route('/api/ai/thread', 'GET', undefined, 'account-A')).json()).thread;
    const bThread = (await (await route('/api/ai/thread', 'GET', undefined, 'account-B')).json()).thread;
    assert.equal(Object.hasOwn(aThread.messages.at(-1), 'songs'), false);
    assert.equal(Object.hasOwn(bThread.messages.at(-1), 'songs'), false);
    assert.equal(JSON.stringify(aThread).includes('B 的歌'), false);
    assert.equal(JSON.stringify(bThread).includes('A 的歌'), false);
    assert.equal(sqlite.prepare('SELECT SUM(play_count) AS total FROM Member_Song_Plays').get().total, 13);
  } finally { sqlite.close(); }
});

test('stats arguments reject identity injection and invalid limits before any stats query', async () => {
  const { sqlite, db, route } = fixture();
  try {
    let statsQueries = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/\bFROM\s+Member_Song_Plays\b/i.test(sql)) statsQueries += 1;
      return prepare(sql);
    };
    const badArgs = [
      { account_id: 'account-B' }, { accountId: 'account-B' }, { user_sub: 'legacy-B' },
      { limit: 0 }, { limit: 51 }, { limit: '1' }, { limit: 1.5 },
    ];
    for (const [index, args] of badArgs.entries()) {
      const response = await route('/api/ai/chat', 'POST', chatBody(index, `turn-${index}`),
        'account-A', { chat: async () => statsCall(args) });
      assert.equal(response.status, 200);
      assert.equal((await streamEvents(response)).at(-1).type, 'error');
    }
    assert.equal(statsQueries, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM music_chat_thread_messages WHERE role='assistant'").get().count, 0);
  } finally { sqlite.close(); }
});

test('stats limit 50 survives mixed read-only tool rounds without reply cards', async () => {
  const { sqlite, route } = fixture();
  try {
    const addSong = sqlite.prepare(`INSERT INTO Songs (id,title,artist,audio_url)
      VALUES (?,?,?,?)`);
    const addPlay = sqlite.prepare(`INSERT INTO Member_Song_Plays
      (account_id,song_id,play_count,last_played_at) VALUES ('account-A',?,?,?)`);
    for (let index = 0; index < 50; index += 1) {
      const id = `song-${index}`;
      addSong.run(id, `第 ${index} 首`, '甲', `/media/audio/${id}.mp3`);
      addPlay.run(id, 50 - index, 100 - index);
    }
    addSong.run('new-song', '曲库新歌', '乙', '/media/audio/new-song.mp3');
    let call = 0;
    const response = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => {
        call += 1;
        if (call === 1) return statsCall({ limit: 50 });
        if (call === 2) return musicCall({ action: 'search', keyword: '曲库新歌' }, 'catalog-2');
        return { type: 'content', content: '这是你常听的歌，也已核对曲库。' };
      },
    });
    assert.equal(response.status, 200);
    const events = await streamEvents(response);
    assert.deepEqual(events.filter((event) => event.type === 'tool_call').map((event) => event.name),
      ['my_listening_stats', 'music_query']);
    assert.equal(events.find((event) => event.type === 'tool_result' && event.name === 'my_listening_stats').data.songs.length, 50);
    const saved = events.find((event) => event.type === 'thread_state').thread.messages.at(-1);
    assert.equal(Object.hasOwn(saved, 'songs'), false);
    assert.equal(Object.hasOwn(saved, 'displaySongs'), false);
    assert.deepEqual(saved.toolSummaries.map((entry) => entry.name),
      ['my_listening_stats', 'music_query']);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM Member_Song_Plays WHERE account_id='account-A'").get().count, 50);
  } finally { sqlite.close(); }
});

test('personal playlist tool lists and reads only session-owned playlists without writes', async () => {
  const { sqlite, route } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Songs (id,title,artist,audio_url) VALUES
      ('song-A','A 的收藏','甲','/media/audio/a.mp3'),
      ('song-B','B 的收藏','乙','/media/audio/b.mp3')`).run();
    sqlite.prepare(`INSERT INTO Member_Playlists
      (id,account_id,kind,name,description,revision,created_at,updated_at) VALUES
      ('playlist-A','account-A','regular','A 的歌单','',3,1,1),
      ('playlist-B','account-B','regular','B 的歌单','',4,1,1)`).run();
    sqlite.prepare(`INSERT INTO Member_Playlist_Songs
      (playlist_id,song_id,sort_order,added_at) VALUES
      ('playlist-A','song-A',0,1),('playlist-B','song-B',0,1)`).run();
    const before = sqlite.prepare('SELECT COUNT(*) AS count FROM Member_Playlists').get().count;
    const answerFor = async (actor, expectedPlaylist, expectedSong) => {
      let calls = 0;
      const answer = await route('/api/ai/chat', 'POST', {
        ...chatBody(), context: { accountId: actor === 'account-A' ? 'account-B' : 'account-A',
          user_sub: 'legacy-impostor' },
      }, actor, {
        chat: async (messages, tools) => {
          calls += 1;
          assert.deepEqual(tools.map((tool) => tool.function.name), availableToolNames);
          if (calls === 1) return playlistCall();
          if (calls === 2) {
            assert.match(messages.at(-1).content, new RegExp(expectedPlaylist));
            return playlistCall({ action: 'read', playlist_id: expectedPlaylist, limit: 1 }, 'playlist-2');
          }
          assert.match(messages.at(-1).content, new RegExp(expectedSong));
          return { type: 'content', content: `找到了${expectedSong}。` };
        },
      });
      assert.equal(answer.status, 200);
      return streamEvents(answer);
    };
    const a = await answerFor('account-A', 'playlist-A', 'A 的收藏');
    assert.deepEqual(a.filter((event) => event.type === 'tool_result')[0].data.playlists.map((item) => item.id), ['playlist-A']);
    assert.deepEqual(a.filter((event) => event.type === 'tool_result')[1].data.songs.map((song) => song.id), ['song-A']);
    assert.equal(Object.hasOwn(a.find((event) => event.type === 'thread_state').thread.messages.at(-1),
      'displaySongs'), false);
    const b = await answerFor('account-B', 'playlist-B', 'B 的收藏');
    assert.deepEqual(b.filter((event) => event.type === 'tool_result')[0].data.playlists.map((item) => item.id), ['playlist-B']);
    assert.deepEqual(b.filter((event) => event.type === 'tool_result')[1].data.songs.map((song) => song.id), ['song-B']);
    assert.equal(JSON.stringify(a).includes('B 的歌单'), false);
    assert.equal(JSON.stringify(b).includes('A 的歌单'), false);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM Member_Playlists').get().count, before);
    assert.equal(sqlite.prepare("SELECT revision FROM Member_Playlists WHERE id='playlist-A'").get().revision, 3);
  } finally { sqlite.close(); }
});

test('personal playlist lookup never reveals another account and rejects identity injection before querying', async () => {
  const { sqlite, db, route } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Member_Playlists
      (id,account_id,kind,name,description,revision,created_at,updated_at)
      VALUES ('private-B','account-B','regular','仅 B 可见','',0,1,1)`).run();
    let missingCallCount = 0;
    const missing = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async (_messages, _tools, _config, _env) => playlistCall(
        { action: 'read', playlist_id: 'private-B' }, `playlist-${++missingCallCount}`),
    });
    assert.equal(missing.status, 200);
    const missingEvents = await streamEvents(missing);
    assert.equal(missingEvents.find((event) => event.type === 'tool_result').data.error.code, 'playlist_not_found');
    assert.equal(JSON.stringify(missingEvents).includes('仅 B 可见'), false);
    let playlistQueries = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/\bFROM\s+Member_Playlists\b|\bFROM\s+Member_Playlist_Songs\b/i.test(sql)) playlistQueries += 1;
      return prepare(sql);
    };
    const invalid = [
      { action: 'list', account_id: 'account-B' },
      { action: 'read', playlist_id: 'private-B', accountId: 'account-B' },
      { action: 'read', playlist_id: 'private-B', user_sub: 'legacy-B' },
      { action: 'read', playlist_id: 'private-B', limit: 51 },
      { action: 'read', playlist_id: 'private-B', offset: -1 },
      { action: 'read', playlist_id: '' },
    ];
    for (const [index, args] of invalid.entries()) {
      const answer = await route('/api/ai/chat', 'POST', chatBody(index + 2, `invalid-${index}`),
        'account-A', { chat: async () => playlistCall(args) });
      assert.equal(answer.status, 200, `invalid args index ${index}`);
      assert.equal((await streamEvents(answer)).at(-1).type, 'error');
    }
    assert.equal(playlistQueries, 0);
  } finally { sqlite.close(); }
});

test('tool_call SSE chunk is readable while catalog query and model continuation are pending', async () => {
  const { sqlite, db, route } = fixture();
  let releaseQuery;
  const queryGate = new Promise((resolve) => { releaseQuery = resolve; });
  try {
    sqlite.prepare(`INSERT INTO Songs (id,title,artist,audio_url)
      VALUES ('song-1','星河','甲','/media/audio/song-1.mp3')`).run();
    let catalogStarted;
    const catalogEntered = new Promise((resolve) => { catalogStarted = resolve; });
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/\bFROM\s+Songs\s+s\b/i.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = async () => { catalogStarted(); await queryGate; return all(); };
      }
      return statement;
    };
    let modelCalls = 0;
    const response = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => {
        modelCalls += 1;
        return modelCalls === 1 ? musicCall() : { type: 'content', content: '找到了《星河》。' };
      },
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const firstText = new TextDecoder().decode(first.value);
    assert.deepEqual(parseEvents(firstText).map((event) => event.type), ['tool_call']);
    await catalogEntered;
    assert.equal(modelCalls, 1);
    assert.equal(sqlite.prepare("SELECT status FROM music_chat_turns WHERE account_id='account-A'").get().status, 'running');
    releaseQuery();
    let remaining = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining += new TextDecoder().decode(chunk.value);
    }
    const events = parseEvents(firstText + remaining);
    assert.deepEqual(events.map((event) => event.type), [
      'tool_call', 'tool_result', 'content', 'thread_state', 'done',
    ]);
    assert.equal(modelCalls, 2);
    assert.equal(sqlite.prepare("SELECT status FROM music_chat_turns WHERE account_id='account-A'").get().status, 'completed');
  } finally { releaseQuery(); sqlite.close(); }
});

test('assistant content deltas arrive before the model finishes and canonical state waits for commit', async () => {
  const { sqlite, route } = fixture();
  let releaseModel;
  const modelGate = new Promise((resolve) => { releaseModel = resolve; });
  try {
    const response = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async (_messages, _tools, _config, _env, options) => {
        await options.onContentDelta('你好，');
        await modelGate;
        await options.onContentDelta('听什么？');
        return { type: 'content', content: '你好，听什么？' };
      },
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.deepEqual(parseEvents(new TextDecoder().decode(first.value)), [
      { type: 'content_delta', content: '你好，' },
    ]);
    assert.equal(sqlite.prepare("SELECT status FROM music_chat_turns WHERE account_id='account-A'").get().status, 'running');
    releaseModel();
    let remaining = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining += new TextDecoder().decode(chunk.value);
    }
    const events = parseEvents(remaining);
    assert.deepEqual(events.map((event) => event.type), [
      'content_delta', 'content', 'thread_state', 'done',
    ]);
    assert.equal(events[0].content, '听什么？');
    assert.equal(events[1].content, '你好，听什么？');
    assert.equal(events[2].thread.messages.at(-1).content, '你好，听什么？');
  } finally { releaseModel(); sqlite.close(); }
});

test('tool continuation clears provisional content while keeping live thought and tool progress', async () => {
  const { sqlite, route } = fixture();
  try {
    let calls = 0;
    const response = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async (_messages, _tools, _config, _env, options) => {
        calls += 1;
        await options.onThoughtDelta(calls === 1 ? '先查询。' : '整理结果。');
        await options.onContentDelta(calls === 1 ? '我先看看' : '找到一首歌。');
        return calls === 1 ? musicCall() : { type: 'content', content: '找到一首歌。' };
      },
    });
    const events = await streamEvents(response);
    assert.deepEqual(events.map((event) => event.type), [
      'thought', 'content_delta', 'content_reset', 'tool_call', 'tool_result',
      'thought', 'content_delta', 'content', 'thread_state', 'done',
    ]);
    assert.equal(events.at(-3).content, '找到一首歌。');
    assert.equal(events.at(-2).thread.messages.at(-1).content, '找到一首歌。');
  } finally { sqlite.close(); }
});

test('failure after live tool progress sends error without done and leaves a recoverable thread', async () => {
  const { sqlite, route } = fixture();
  try {
    let modelCalls = 0;
    const response = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => {
        modelCalls += 1;
        if (modelCalls === 1) return musicCall({ action: 'search', keyword: 'Alpha' });
        throw new Error('AI_UPSTREAM_503');
      },
    });
    assert.equal(response.status, 200);
    const events = await streamEvents(response);
    assert.deepEqual(events.map((event) => event.type), ['tool_call', 'tool_result', 'error']);
    assert.equal(events.at(-1).error, 'upstream_unavailable');
    assert.equal(sqlite.prepare("SELECT status FROM music_chat_turns WHERE account_id='account-A'").get().status, 'failed');
    const thread = (await (await route('/api/ai/thread', 'GET')).json()).thread;
    assert.deepEqual(thread.messages.map((message) => message.role), ['user']);
    assert.equal(thread.revision, 1);
  } finally { sqlite.close(); }
});

test('unknown or malformed tools are rejected without executing mutations or finalizing a false answer', async () => {
  const { sqlite, db, route } = fixture();
  try {
    let catalogQueries = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/\bFROM\s+Songs\b/i.test(sql)) catalogQueries += 1;
      return prepare(sql);
    };
    let callCount = 0;
    const unknown = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => { callCount += 1; return { type: 'function_calls',
        functionCalls: [{ id: 'bad-1', name: 'admin_delete_account', args: { account_id: 'account-A' } }] }; },
    });
    assert.equal(unknown.status, 200);
    assert.equal((await streamEvents(unknown)).at(-1).type, 'error');
    assert.equal(callCount, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM Member_Playlists').get().count, 0);
    assert.equal(sqlite.prepare("SELECT status FROM music_chat_turns WHERE account_id='account-A'").get().status, 'failed');
    const malformed = await route('/api/ai/chat', 'POST', chatBody(1, 'turn-2'), 'account-A', {
      chat: async () => musicCall({ action: 'search', keyword: 'x', extra: 'not allowed' }),
    });
    assert.equal(malformed.status, 200);
    assert.equal((await streamEvents(malformed)).at(-1).type, 'error');
    const malformedJson = await route('/api/ai/chat', 'POST', chatBody(2, 'turn-3'), 'account-A', {
      chat: async () => musicCall('{"action":"search",'),
    });
    assert.equal(malformedJson.status, 200);
    assert.equal((await streamEvents(malformedJson)).at(-1).type, 'error');
    assert.equal(catalogQueries, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM music_chat_thread_messages WHERE role='assistant'").get().count, 0);
  } finally { sqlite.close(); }
});

test('five tool rounds are followed by one tool-free finalization request', async () => {
  const { sqlite, route } = fixture();
  try {
    const seenTools = [];
    const answer = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async (_messages, tools) => {
        seenTools.push(tools.map((tool) => tool.function.name));
        return musicCall({ action: 'search', keyword: 'Alpha' }, `call-${seenTools.length}`);
      },
    });
    assert.equal(answer.status, 200);
    const events = await streamEvents(answer);
    assert.deepEqual(seenTools, [availableToolNames, availableToolNames, availableToolNames,
      availableToolNames, availableToolNames, []]);
    assert.equal(events.filter((event) => event.type === 'tool_call').length, 5);
    assert.match(events.find((event) => event.type === 'content').content, /没能整理出可靠答案/);
    assert.equal(sqlite.prepare("SELECT status FROM music_chat_turns WHERE account_id='account-A'").get().status, 'completed');
  } finally { sqlite.close(); }
});

test('oversized tool batches fail before any catalog query runs', async () => {
  const { sqlite, db, route } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Songs (id,title,artist,audio_url)
      VALUES ('song-1','星河','甲','/media/audio/song-1.mp3')`).run();
    let catalogQueries = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/\bFROM\s+Songs\b/i.test(sql)) catalogQueries += 1;
      return prepare(sql);
    };
    const response = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => ({ type: 'function_calls', functionCalls: Array.from({ length: 5 }, (_, index) => ({
        id: `call-${index}`, name: 'music_query',
        args: { action: 'search', keyword: '星河' },
      })) }),
    });
    assert.equal(response.status, 200);
    assert.equal((await streamEvents(response)).at(-1).type, 'error');
    assert.equal(catalogQueries, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM music_chat_thread_messages WHERE role='assistant'").get().count, 0);
  } finally { sqlite.close(); }
});

test('thread clear requires matching revision and preserves another account', async () => {
  const { sqlite, route } = fixture();
  try {
    await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => ({ type: 'content', content: '答复' }),
    });
    const stale = await route('/api/ai/thread', 'DELETE', { revision: 0 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).revision, 2);
    const cleared = await route('/api/ai/thread', 'DELETE', { revision: 2 });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).thread.revision, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM music_chat_thread_messages WHERE account_id='account-A'").get().count, 0);
    const other = await route('/api/ai/thread', 'GET', undefined, 'account-B');
    assert.deepEqual((await other.json()).thread.messages, []);
  } finally { sqlite.close(); }
});

test('invalid requests and missing key fail closed without reserving a turn', async () => {
  const { sqlite, db, request, session, route } = fixture();
  try {
    assert.equal((await route('/api/ai/chat', 'POST', { message: 'hi' })).status, 400);
    const req = request('/api/ai/chat', 'POST', chatBody());
    const noKey = await handleLocalAssistantRoute(req, new URL(req.url), db, {}, session('account-A'), {});
    assert.equal(noKey.status, 503);
    assert.equal((await noKey.json()).error, 'ai_provider_unconfigured');
    let unauthenticatedProviderCalls = 0;
    const limited = await handleLocalAssistantRoute(req, new URL(req.url), db, {},
      { mode: 'must_change_password', account: session('account-A').account },
      { DEEPSEEK_API_KEY: 'test-secret' }, { chat: async () => {
        unauthenticatedProviderCalls += 1;
        return { type: 'content', content: 'must not be called' };
      } });
    assert.equal(limited.status, 401);
    assert.equal(unauthenticatedProviderCalls, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM music_chat_turns').get().count, 0);
  } finally { sqlite.close(); }
});

test('upstream failure marks turn failed; no fabricated assistant message is stored', async () => {
  const { sqlite, route } = fixture();
  try {
    const failed = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => { throw new Error('AI_UPSTREAM_503'); },
    });
    assert.equal(failed.status, 200);
    assert.equal((await streamEvents(failed)).at(-1).error, 'upstream_unavailable');
    assert.equal(sqlite.prepare("SELECT status FROM music_chat_turns WHERE account_id='account-A'").get().status, 'failed');
    const thread = (await (await route('/api/ai/thread', 'GET')).json()).thread;
    assert.deepEqual(thread.messages.map((message) => message.role), ['user']);
    assert.equal(thread.revision, 1);
    const recovered = await route('/api/ai/chat', 'POST', chatBody(1, 'turn-2'), 'account-A', {
      chat: async () => ({ type: 'content', content: '现在可以回答了' }),
    });
    assert.equal(recovered.status, 200);
    assert.equal((await streamEvents(recovered)).at(-1).type, 'done');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM music_chat_turns WHERE status='running'").get().count, 0);
  } finally { sqlite.close(); }
});

test('an in-flight turn blocks clear and another chat without deleting data', async () => {
  const { sqlite, route } = fixture();
  try {
    let release;
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const paused = new Promise((resolve) => { release = resolve; });
    const first = route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async () => { notifyStarted(); await paused; return { type: 'content', content: '完成' }; },
    });
    await started;
    const revision = (await (await route('/api/ai/thread', 'GET')).json()).thread.revision;
    assert.equal(revision, 1);
    const competing = await route('/api/ai/chat', 'POST', chatBody(1, 'turn-2'));
    assert.equal(competing.status, 409);
    const clear = await route('/api/ai/thread', 'DELETE', { revision: 1 });
    assert.equal(clear.status, 409);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM music_chat_thread_messages').get().count, 1);
    release();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    await streamEvents(firstResponse);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM music_chat_thread_messages').get().count, 2);
  } finally { sqlite.close(); }
});

test('live time and switched playback replace historical song in each model turn', async () => {
  const { sqlite, route } = fixture();
  try {
    const prompts = [];
    const chat = async (messages) => {
      prompts.push(messages[0].content);
      return { type: 'content', content: `第 ${prompts.length} 轮` };
    };
    const first = await route('/api/ai/chat', 'POST', {
      ...chatBody(), message: '我在听什么', context: { timeZone: 'Asia/Shanghai',
        playback: { songId: 'song-a', title: '只因你太美', artist: '甲', isPlaying: true } },
    }, 'account-A', { chat, now: () => Date.UTC(2026, 11, 24, 12, 0) });
    assert.equal(first.status, 200);
    await first.text();
    const next = await route('/api/ai/chat', 'POST', {
      ...chatBody(2, 'turn-2'), message: '你要和我过圣诞吗',
      context: { timeZone: 'Asia/Shanghai', playback: { songId: 'song-b',
        title: 'Last Christmas', artist: 'Wham!', isPlaying: true },
      recentPlayback: [{ title: '只因你太美', artist: '甲' }] },
    }, 'account-A', { chat, now: () => Date.UTC(2026, 11, 24, 12, 1) });
    assert.equal(next.status, 200);
    await next.text();
    assert.match(prompts[1], /当前时间：.*2026.*Asia\/Shanghai/);
    assert.match(prompts[1], /当前在听：《Last Christmas》/);
    assert.match(prompts[1], /最近切歌：《只因你太美》.*此前播放/);
    assert.match(prompts[1], /历史消息中的播放、队列等状态陈述可能已经过期/);
  } finally { sqlite.close(); }
});

test('provider thought is streamed and stored; absent thought is labelled without fabrication', async () => {
  const { sqlite, route } = fixture();
  try {
    const withThought = await route('/api/ai/chat', 'POST', {
      ...chatBody(), enable_thinking: true,
    }, 'account-A', { chat: async (_messages, _tools, _config, _env, options) => {
      options.onThoughtDelta('先核对现场。');
      return { type: 'content', content: '你好' };
    } });
    const events = await streamEvents(withThought);
    assert.deepEqual(events.map((event) => event.type), ['thought', 'content', 'thread_state', 'done']);
    assert.equal(events[2].thread.messages.at(-1).thought, '先核对现场。');
    const withoutThought = await route('/api/ai/chat', 'POST', {
      ...chatBody(2, 'turn-2'), enable_thinking: true,
    }, 'account-A', { chat: async () => ({ type: 'content', content: '继续' }) });
    const next = await streamEvents(withoutThought);
    assert.equal(next.find((event) => event.type === 'thought'), undefined);
    assert.equal(next.find((event) => event.type === 'thread_state').thread.messages.at(-1).thinkingRequested, true);
  } finally { sqlite.close(); }
});

test('first provider thought reaches SSE before the model finishes', async () => {
  const { sqlite, route } = fixture();
  let releaseModel;
  const modelGate = new Promise((resolve) => { releaseModel = resolve; });
  try {
    const response = await route('/api/ai/chat', 'POST', chatBody(), 'account-A', {
      chat: async (_messages, _tools, _config, _env, options) => {
        options.onThoughtDelta('正在核对。');
        await modelGate;
        return { type: 'content', content: '核对完成。' };
      },
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"type":"thought","content":"正在核对。"/);
    releaseModel();
    let remaining = '';
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      remaining += new TextDecoder().decode(next.value);
    }
    assert.match(remaining, /"type":"done"/);
  } finally { releaseModel(); sqlite.close(); }
});

test('DeepSeek thinking carries reasoning through a tool round and stores it', async () => {
  const { sqlite, route } = fixture();
  let calls = 0;
  try {
    const response = await route('/api/ai/chat', 'POST', {
      ...chatBody(), message: '列出我的歌单', enable_thinking: true,
    }, 'account-A', { chat: async (messages, _tools, _config, _env, options) => {
      calls += 1;
      if (calls === 1) {
        options.onThoughtDelta('先读取歌单。');
        return { ...playlistCall(), reasoningContent: '先读取歌单。' };
      }
      assert.equal(messages.find((message) => message.role === 'assistant' && message.tool_calls)
        ?.reasoning_content, '先读取歌单。');
      options.onThoughtDelta('工具返回后整理。');
      return { type: 'content', content: '你有一个歌单。' };
    } });
    const events = await streamEvents(response);
    assert.equal(calls, 2);
    assert.equal(events.find((event) => event.type === 'thought')?.content, '先读取歌单。');
    assert.equal(events.find((event) => event.type === 'thread_state')?.thread.messages.at(-1).thought,
      '先读取歌单。工具返回后整理。');
    const saved = events.find((event) => event.type === 'thread_state')?.thread.messages.at(-1);
    assert.deepEqual(saved.processEntries.map((entry) => entry.type), ['thought', 'tool', 'thought']);
    assert.equal(saved.processEntries[1].id, events.find((event) => event.type === 'tool_call').id);
    assert.equal(events.find((event) => event.type === 'tool_result').id, saved.processEntries[1].id);
    assert.equal(saved.processEntries[1].summary, saved.toolSummaries[0].summary);
  } finally { sqlite.close(); }
});

test('assistant tool actions are not screened by message keywords', async () => {
  const { sqlite, route } = fixture();
  try {
    const run = async (message, revision, clientId) => {
      let calls = 0;
      const answer = await route('/api/ai/chat', 'POST', {
        ...chatBody(revision, clientId), message,
      }, 'account-A', { chat: async () => (++calls === 1
        ? { type: 'function_calls', functionCalls: [{ id: `pause-${clientId}`,
          name: 'music_control', args: { action: 'pause' } }] }
        : { type: 'content', content: '指令已下发，待浏览器执行。' }) });
      return streamEvents(answer);
    };
    const allowed = await run('暂停播放', 0, 'turn-1');
    assert.equal(allowed.find((event) => event.type === 'player_action').action.action, 'pause');
    const followUp = await run('那这首呢？', 2, 'turn-2');
    assert.equal(followUp.find((event) => event.type === 'player_action')?.action?.action, 'pause');
    assert.equal(followUp.find((event) => event.type === 'tool_result')?.data?.ok, true);
  } finally { sqlite.close(); }
});

test('read-only Chinese song lookup is not blocked by a follow-up question', async () => {
  const { sqlite, route } = fixture();
  sqlite.prepare(`INSERT INTO Songs (id, title, artist, audio_url, language)
    VALUES ('zh-song', '晴天', '周杰伦', '/zh.mp3', 'zh')`).run();
  try {
    const previous = await route('/api/ai/chat', 'POST', {
      ...chatBody(), message: '找一些日语歌曲',
    }, 'account-A', { chat: async () => ({ type: 'content', content: '这里有几首日语歌曲。' }) });
    assert.equal((await streamEvents(previous)).at(-1).type, 'done');
    let calls = 0;
    const response = await route('/api/ai/chat', 'POST', {
      ...chatBody(2, 'turn-2'), message: '中文歌曲呢？',
    }, 'account-A', { chat: async () => (++calls === 1
      ? musicCall({ action: 'random', language: 'zh', count: 2 }, 'zh-query')
      : { type: 'content', content: '这里有中文歌曲。' }) });
    const events = await streamEvents(response);
    assert.equal(events.find((event) => event.type === 'tool_result')?.data?.ok, true);
    assert.deepEqual(events.find((event) => event.type === 'tool_result')?.data?.songs?.map((song) => song.id), ['zh-song']);
    assert.equal(events.find((event) => event.type === 'player_action'), undefined);
    assert.equal(events.at(-1).type, 'done');
  } finally { sqlite.close(); }
});

test('assistant can play a song after conversational agreement', async () => {
  const { sqlite, route } = fixture();
  sqlite.prepare(`INSERT INTO Songs (id, title, artist, audio_url, language)
    VALUES ('offered-song', 'はいよろこんで', 'こっちのけんと', '/offered.mp3', 'ja')`).run();
  try {
    const offer = await route('/api/ai/chat', 'POST', {
      ...chatBody(), message: '找一首日语歌叫 haiyorokonde',
    }, 'account-A', { chat: async () => ({ type: 'content',
      content: '找到《はいよろこんで》，ID offered-song。要放吗？说一声我就下指令。' }) });
    assert.equal((await streamEvents(offer)).at(-1).type, 'done');
    let calls = 0;
    const agreed = await route('/api/ai/chat', 'POST', {
      ...chatBody(2, 'turn-2'), message: '放吧',
    }, 'account-A', { chat: async () => (++calls === 1
      ? { type: 'function_calls', functionCalls: [{ id: 'play-offered', name: 'music_control',
        args: { action: 'play_song', song_id: 'offered-song' } }] }
      : { type: 'content', content: '已发出播放指令。' }) });
    const events = await streamEvents(agreed);
    assert.equal(events.find((event) => event.type === 'tool_result')?.data?.ok, true);
    assert.equal(events.find((event) => event.type === 'player_action')?.action?.song?.id, 'offered-song');

  } finally { sqlite.close(); }
});

test('assistant playlist deletion waits for browser confirmation without changing data', async () => {
  const { sqlite, db, route } = fixture();
  try {
    const created = await executeLocalManagePlaylist({ action: 'create', name: '测试01' },
      { db, accountId: 'account-A', clientMessageId: 'setup', toolCallId: 'setup' });
    const playlistId = created.eventData.playlist.id;
    let calls = 0;
    const response = await route('/api/ai/chat', 'POST', { ...chatBody(), message: '测试删除测试01' },
      'account-A', { chat: async (messages) => {
        calls += 1;
        if (calls === 1) {
          assert.match(messages[0].content, /不要要求听众再输入固定格式/);
          return { type: 'function_calls', functionCalls: [{ id: 'list-call', name: 'manage_playlist',
            args: { action: 'list' } }] };
        }
        if (calls === 2) return { type: 'function_calls', functionCalls: [{ id: 'delete-call',
          name: 'manage_playlist', args: { action: 'delete', playlist_id: playlistId } }] };
        return { type: 'content', content: '请点选下方操作。' };
      } });
    const events = await streamEvents(response);
    const tool = events.find((event) => event.type === 'tool_result' && event.id === 'delete-call');
    assert.equal(tool?.data?.error, 'CONFIRMATION_REQUIRED', JSON.stringify(events));
    assert.deepEqual(tool.data.confirmation, { playlistId, name: '测试01', expectedRevision: 0 });
    assert.equal(events.at(-1).type, 'done');
    assert.equal((await executeLocalManagePlaylist({ action: 'read', playlist_id: playlistId },
      { db, accountId: 'account-A' })).eventData.ok, true);
  } finally { sqlite.close(); }
});

test('assistant delete confirmation rejects foreign and stale playlists', async () => {
  const { sqlite, db } = fixture();
  try {
    const created = await executeLocalManagePlaylist({ action: 'create', name: '自己的歌单' },
      { db, accountId: 'account-A', clientMessageId: 'setup', toolCallId: 'setup' });
    const id = created.eventData.playlist.id;
    const foreign = await executeLocalManagePlaylist({ action: 'delete', playlist_id: id },
      { db, accountId: 'account-B', requireDeleteConfirmation: true });
    assert.equal(foreign.eventData.error, 'PLAYLIST_NOT_FOUND');
    assert.equal(foreign.eventData.confirmation, undefined);
    const stale = await executeLocalManagePlaylist({ action: 'delete', playlist_id: id,
      expected_revision: 1 }, { db, accountId: 'account-A', requireDeleteConfirmation: true });
    assert.equal(stale.eventData.error, 'REVISION_CONFLICT');
    assert.equal(stale.eventData.confirmation, undefined);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM Member_Playlists WHERE id = ?').get(id).n, 1);
  } finally { sqlite.close(); }
});

test('assistant playlist clear remains available while deletion requires confirmation', async () => {
  const { sqlite, db, route } = fixture();
  try {
    const first = await executeLocalManagePlaylist({ action: 'create', name: '圣诞' },
      { db, accountId: 'account-A', clientMessageId: 'setup', toolCallId: 'first' });
    const second = await executeLocalManagePlaylist({ action: 'create', name: '备用' },
      { db, accountId: 'account-A', clientMessageId: 'setup', toolCallId: 'second' });
    const cases = [
      ['把我的歌单清空', 'clear', first.eventData.playlist.id],
      ['删除歌单《备用》', 'delete', second.eventData.playlist.id],
    ];
    for (const [index, [message, action, playlistId]] of cases.entries()) {
      let calls = 0;
      const response = await route('/api/ai/chat', 'POST', { ...chatBody(index * 2, `positive-${index}`), message },
        'account-A', { chat: async () => (++calls === 1
          ? { type: 'function_calls', functionCalls: [{ id: `positive-call-${index}`,
            name: 'manage_playlist', args: { action, playlist_id: playlistId } }] }
          : { type: 'content', content: '操作完成。' }) });
      const events = await streamEvents(response);
      assert.equal(events.find((event) => event.type === 'tool_result')?.data?.error,
        action === 'delete' ? 'CONFIRMATION_REQUIRED' : undefined, message);
    }
    assert.equal((await executeLocalManagePlaylist({ action: 'read', playlist_id: second.eventData.playlist.id },
      { db, accountId: 'account-A' })).eventData.ok, true);
  } finally { sqlite.close(); }
});

test('assistant playlist mutations are account-scoped, revisioned and idempotent', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Songs (id,title,artist,audio_url)
      VALUES ('song-1','Last Christmas','Wham!','/media/audio/song-1.mp3')`).run();
    const context = { db, accountId: 'account-A', clientMessageId: 'turn-1', toolCallId: 'call-1' };
    const created = await executeLocalManagePlaylist({ action: 'create', name: '圣诞歌单' }, context);
    assert.equal(created.eventData.ok, true, JSON.stringify(created.eventData));
    const id = created.eventData.playlist.id;
    const repeated = await executeLocalManagePlaylist({ action: 'create', name: '圣诞歌单' }, context);
    assert.equal(repeated.eventData.outcome, 'noop');
    assert.equal(repeated.eventData.playlist.id, id);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE account_id='account-A' AND kind='regular'").get().n, 1);
    const foreign = await executeLocalManagePlaylist({ action: 'read', playlist_id: id },
      { db, accountId: 'account-B' });
    assert.equal(foreign.eventData.ok, false);
    const added = await executeLocalManagePlaylist({ action: 'add_songs', playlist_id: id,
      song_ids: ['song-1'], expected_revision: 0 }, context);
    assert.equal(added.eventData.ok, true);
    const stale = await executeLocalManagePlaylist({ action: 'delete', playlist_id: id,
      expected_revision: 0 }, context);
    assert.equal(stale.eventData.error, 'REVISION_CONFLICT');
    const after = await executeLocalManagePlaylist({ action: 'read', playlist_id: id }, context);
    assert.deepEqual(after.eventData.playlist.songs.map((song) => song.id), ['song-1']);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM Member_Playlists WHERE account_id='account-B'").get().n, 0);
  } finally { sqlite.close(); }
});

test('song details use an exact catalog ID and do not fetch missing lyrics externally', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.prepare(`INSERT INTO Songs (id,title,artist,album,language)
      VALUES ('song-1','Last Christmas','Wham!','Music from the Edge of Heaven','en')`).run();
    const found = await songDetailsTool.execute({ song_id: 'song-1', include_lyrics: true }, { db, env: {} });
    assert.equal(found.eventData.ok, true);
    assert.equal(found.eventData.song.title, 'Last Christmas');
    assert.equal(found.eventData.lyricsAvailable, false);
    assert.equal(JSON.parse(found.modelText).lyrics, null);
    const missing = await songDetailsTool.execute({ song_id: 'song-2' }, { db });
    assert.equal(missing.eventData.error, 'song_not_found');
  } finally { sqlite.close(); }
});

test('one assistant turn cannot emit more than four browser mutations', async () => {
  const { sqlite, route } = fixture();
  try {
    let round = 0;
    const answer = await route('/api/ai/chat', 'POST', {
      ...chatBody(), message: '暂停播放',
    }, 'account-A', { chat: async () => {
      round += 1;
      if (round === 1) return { type: 'function_calls', functionCalls: Array.from({ length: 4 }, (_, index) => ({
        id: `pause-${index}`, name: 'music_control', args: { action: 'pause' },
      })) };
      if (round === 2) return { type: 'function_calls', functionCalls: [{ id: 'pause-5',
        name: 'music_control', args: { action: 'pause' } }] };
      return { type: 'content', content: '指令已下发。' };
    } });
    const events = await streamEvents(answer);
    assert.equal(events.filter((event) => event.type === 'player_action').length, 4);
    assert.equal(events.filter((event) => event.type === 'tool_result').at(-1).data.error,
      'mutation_budget_exceeded');
  } finally { sqlite.close(); }
});
