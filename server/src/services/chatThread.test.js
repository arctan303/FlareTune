import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  clearChatThread,
  completeChatTurn,
  failChatTurn,
  formatMessageTimestamp,
  getChatThread,
  modelMessagesFromThread,
  reserveChatTurn,
} from './chatThread.js';

class Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.owner, this.sql, values); }
  async first() { return this.owner.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.owner.database.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.owner.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

function createDb(schema) {
  const owner = {
    database: new DatabaseSync(':memory:'),
    beforeBatch: null,
    prepare(sql) { return new Statement(this, sql); },
    async batch(statements) {
      this.beforeBatch?.();
      this.beforeBatch = null;
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.database.exec('COMMIT');
        return results;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  owner.database.exec(schema);
  return owner;
}

function createMusicDb() {
  return createDb(readFileSync(new URL('../../db/migrations/0017_music_chat_threads.sql', import.meta.url), 'utf8'));
}

const CURRENT_CHAT_STATUS_MIGRATION = readFileSync(
  new URL('../../db/migrations/0020_rebuild_music_chat_turn_status.sql', import.meta.url),
  'utf8',
);

test('music clear keeps records when another writer advances the revision before its batch', async () => {
  const music = createMusicDb();
  music.database.exec(`
    INSERT INTO music_chat_threads(user_sub,revision,next_sequence,created_at,updated_at) VALUES ('subject',0,2,1,1);
    INSERT INTO music_chat_thread_messages(id,user_sub,sequence,role,content,created_at) VALUES ('message','subject',1,'user','keep me',1);
  `);
  music.beforeBatch = () => music.database.prepare("UPDATE music_chat_threads SET revision=1 WHERE user_sub='subject'").run();
  const result = await clearChatThread({ DB: music }, 'subject', 0, 2);
  assert.equal(result.conflict, true);
  assert.equal(music.database.prepare("SELECT COUNT(*) AS count FROM music_chat_thread_messages WHERE user_sub='subject'").get().count, 1);
});

test('music turn reservation writes local thread state once', async () => {
  const music = createMusicDb();
  const env = { DB: music };
  const first = await reserveChatTurn(env, { userSub: 'subject', clientMessageId: 'client-1', expectedRevision: 0, content: 'hello', now: 1 });
  assert.equal(first.duplicate, undefined);
  const duplicate = await reserveChatTurn(env, { userSub: 'subject', clientMessageId: 'client-1', expectedRevision: 0, content: 'hello', now: 2 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(music.database.prepare("SELECT COUNT(*) AS count FROM music_chat_thread_messages WHERE user_sub='subject'").get().count, 1);
  assert.equal(music.database.prepare("SELECT COUNT(*) AS count FROM music_chat_turns WHERE user_sub='subject'").get().count, 1);
});

test('music thread completes entirely in the music database', async () => {
  const music = createMusicDb();
  const env = { DB: music };

  const reserved = await reserveChatTurn(env, {
    userSub: 'subject',
    clientMessageId: 'music-client-1',
    expectedRevision: 0,
    content: '只属于音乐站的问题',
    now: 10,
  });
  const completed = await completeChatTurn(env, {
    userSub: 'subject',
    turnId: reserved.turn.id,
    expectedRevision: reserved.turn.reserved_revision,
    content: '只属于音乐站的回答',
    now: 11,
  });

  assert.equal(completed.conflict, false);
  assert.equal(completed.thread.revision, 2);
  assert.deepEqual(completed.thread.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '只属于音乐站的问题' },
    { role: 'assistant', content: '只属于音乐站的回答' },
  ]);
});

test('music thread keeps legacy song data stored but omits it from message DTOs', async () => {
  const music = createMusicDb();
  const env = { DB: music };

  const reserved = await reserveChatTurn(env, {
    userSub: 'subject-cards',
    clientMessageId: 'client-msg-cards',
    expectedRevision: 0,
    content: '推荐几首好听的歌',
    now: 10,
  });

  const songList = [
    { id: 'song-a', title: 'Song Alpha', artist: 'Artist A' },
    { id: 'song-b', title: 'Song Beta', artist: 'Artist B' },
  ];

  const completed = await completeChatTurn(env, {
    userSub: 'subject-cards',
    turnId: reserved.turn.id,
    expectedRevision: reserved.turn.reserved_revision,
    content: '为你推荐这两首歌：',
    extra: { songs: songList },
    now: 11,
  });

  assert.equal(completed.conflict, false);
  const assistantMsg = completed.thread.messages.find((m) => m.role === 'assistant');
  assert.ok(assistantMsg);
  assert.equal(Object.hasOwn(assistantMsg, 'songs'), false);
  assert.equal('extra' in assistantMsg, false);
  assert.equal(JSON.parse(music.database.prepare("SELECT extra_json FROM music_chat_thread_messages WHERE role='assistant'").get().extra_json).songs.length, 2);

  const refreshedThread = await getChatThread(env, 'subject-cards');
  const refreshedAssistant = refreshedThread.messages.find((m) => m.role === 'assistant');
  assert.ok(refreshedAssistant);
  assert.equal(Object.hasOwn(refreshedAssistant, 'songs'), false);
});

test('music thread completeChatTurn persists extra.thought and getChatThread returns parsed thought', async () => {
  const music = createMusicDb();
  const env = { DB: music };

  const reserved = await reserveChatTurn(env, {
    userSub: 'subject-thought',
    clientMessageId: 'client-msg-thought',
    expectedRevision: 0,
    content: '周杰伦有什么好听的歌？',
    now: 10,
  });

  const thoughtText = '思考中：首先需要分析用户偏好，并检索周杰伦的经典曲目...';

  const completed = await completeChatTurn(env, {
    userSub: 'subject-thought',
    turnId: reserved.turn.id,
    expectedRevision: reserved.turn.reserved_revision,
    content: '周杰伦的经典曲目有《晴天》、《七里香》等。',
    extra: { thought: thoughtText },
    now: 11,
  });

  assert.equal(completed.conflict, false);
  const assistantMsg = completed.thread.messages.find((m) => m.role === 'assistant');
  assert.ok(assistantMsg);
  assert.equal(assistantMsg.thought, thoughtText);
  assert.equal('extra' in assistantMsg, false);

  const refreshedThread = await getChatThread(env, 'subject-thought');
  const refreshedAssistant = refreshedThread.messages.find((m) => m.role === 'assistant');
  assert.ok(refreshedAssistant);
  assert.equal(refreshedAssistant.thought, thoughtText);
});

test('music turn reservation has no external usage-event dependency', async () => {
  const music = createMusicDb();
  const env = { DB: music };

  const result = await reserveChatTurn(env, {
    userSub: 'subject',
    clientMessageId: 'client-without-usage-event',
    expectedRevision: 0,
    content: 'hello',
    now: 1,
  });

  assert.equal(result.thread.revision, 1);
  assert.equal((await getChatThread(env, 'subject')).messages.length, 1);
});

test('new music thread starts empty', async () => {
  const music = createMusicDb();
  const thread = await getChatThread({ DB: music }, 'subject');
  assert.equal(thread.revision, 0);
  assert.deepEqual(thread.messages, []);
});

test('stale revision cannot reserve a second music turn', async () => {
  const music = createMusicDb();
  const env = { DB: music };
  const first = await reserveChatTurn(env, {
    userSub: 'subject',
    clientMessageId: 'current-client',
    expectedRevision: 0,
    content: 'current message',
    now: 1,
  });
  assert.equal(first.thread.revision, 1);

  const stale = await reserveChatTurn(env, {
    userSub: 'subject',
    clientMessageId: 'stale-client',
    expectedRevision: 0,
    content: 'stale message',
    now: 2,
  });
  assert.equal(stale.conflict, true);
  assert.equal(stale.thread.revision, 1);
  assert.deepEqual(stale.thread.messages.map(({ content }) => content), ['current message']);
});

test('an active music turn prevents thread clearing without deleting messages', async () => {
  const music = createMusicDb();
  const env = { DB: music };
  const reserved = await reserveChatTurn(env, {
    userSub: 'subject',
    clientMessageId: 'active-client',
    expectedRevision: 0,
    content: 'keep while running',
    now: 1,
  });

  const cleared = await clearChatThread(env, 'subject', reserved.thread.revision, 2);
  assert.equal(cleared.conflict, true);
  assert.equal(cleared.thread.revision, 1);
  assert.deepEqual(cleared.thread.messages.map(({ content }) => content), ['keep while running']);
  assert.equal(music.database.prepare("SELECT status FROM music_chat_turns WHERE user_sub='subject'").get().status, 'running');
});

test('legacy awaiting_client turns are not accepted by the current runtime state machine', async () => {
  const music = createMusicDb();
  music.database.exec(`
    INSERT INTO music_chat_threads(user_sub,revision,next_sequence,created_at,updated_at)
    VALUES ('legacy-subject',1,2,1,1);
    INSERT INTO music_chat_thread_messages(id,user_sub,sequence,role,content,client_message_id,turn_id,created_at)
    VALUES ('legacy-message','legacy-subject',1,'user','legacy message','legacy-client','legacy-turn',1);
    INSERT INTO music_chat_turns(id,user_sub,client_message_id,base_revision,reserved_revision,assistant_id,site,status,created_at,updated_at)
    VALUES ('legacy-turn','legacy-subject','legacy-client',0,1,'xiaoa','music','awaiting_client',1,1);
  `);
  const env = { DB: music };

  const completed = await completeChatTurn(env, {
    userSub: 'legacy-subject',
    turnId: 'legacy-turn',
    expectedRevision: 1,
    content: 'must not be persisted',
    now: 2,
  });
  assert.equal(completed.conflict, true);
  assert.equal(music.database.prepare("SELECT COUNT(*) AS count FROM music_chat_thread_messages WHERE role='assistant'").get().count, 0);

  await failChatTurn(env, 'legacy-subject', 'legacy-turn', 3);
  assert.equal(music.database.prepare("SELECT status FROM music_chat_turns WHERE id='legacy-turn'").get().status, 'awaiting_client');

  const cleared = await clearChatThread(env, 'legacy-subject', 1, 4);
  assert.equal(cleared.conflict, false);
  assert.equal(music.database.prepare("SELECT COUNT(*) AS count FROM music_chat_turns WHERE user_sub='legacy-subject'").get().count, 0);
});

test('current chat status migration preserves the table contract and discards awaiting_client turns', () => {
  const music = createMusicDb();
  music.database.exec(`
    INSERT INTO music_chat_threads(user_sub,revision,next_sequence,created_at,updated_at)
    VALUES ('migration-subject',0,1,1,1);
    INSERT INTO music_chat_turns(id,user_sub,client_message_id,base_revision,reserved_revision,assistant_id,site,status,assistant_message_id,created_at,updated_at)
    VALUES
      ('running-turn','migration-subject','running-client',0,1,'xiaoa','music','running',NULL,1,1),
      ('completed-turn','migration-subject','completed-client',0,1,'xiaoa','music','completed','assistant-message',1,2),
      ('failed-turn','migration-subject','failed-client',0,1,'xiaoa','music','failed',NULL,1,3),
      ('awaiting-turn','migration-subject','awaiting-client',0,1,'xiaoa','music','awaiting_client',NULL,1,4);
  `);

  music.database.exec(CURRENT_CHAT_STATUS_MIGRATION);

  assert.deepEqual(
    music.database.prepare('SELECT id, status FROM music_chat_turns ORDER BY id').all()
      .map((row) => ({ id: row.id, status: row.status })),
    [
      { id: 'completed-turn', status: 'completed' },
      { id: 'failed-turn', status: 'failed' },
      { id: 'running-turn', status: 'running' },
    ],
  );
  assert.deepEqual(
    music.database.prepare('PRAGMA table_info(music_chat_turns)').all().map((column) => column.name),
    [
      'id', 'user_sub', 'client_message_id', 'base_revision', 'reserved_revision',
      'assistant_id', 'site', 'status', 'assistant_message_id', 'created_at', 'updated_at',
    ],
  );
  const foreignKey = music.database.prepare('PRAGMA foreign_key_list(music_chat_turns)').get();
  assert.equal(foreignKey.table, 'music_chat_threads');
  assert.equal(foreignKey.from, 'user_sub');
  assert.equal(foreignKey.to, 'user_sub');
  assert.equal(foreignKey.on_delete, 'CASCADE');
  assert.ok(music.database.prepare('PRAGMA index_list(music_chat_turns)').all()
    .some((index) => index.name === 'idx_music_chat_turns_status'));
  assert.throws(() => music.database.prepare(`
    INSERT INTO music_chat_turns(id,user_sub,client_message_id,base_revision,reserved_revision,status,created_at,updated_at)
    VALUES ('bad-status','migration-subject','bad-client',0,1,'awaiting_client',1,1)
  `).run(), /CHECK constraint failed/);
  assert.throws(() => music.database.prepare(`
    INSERT INTO music_chat_turns(id,user_sub,client_message_id,base_revision,reserved_revision,status,created_at,updated_at)
    VALUES ('duplicate-client','migration-subject','running-client',0,1,'running',1,1)
  `).run(), /UNIQUE constraint failed/);

  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  const currentTable = schema.match(/CREATE TABLE IF NOT EXISTS music_chat_turns[\s\S]*?\n\);/)?.[0] || '';
  assert.match(currentTable, /status IN \('running', 'completed', 'failed'\)/);
  assert.doesNotMatch(currentTable, /awaiting_client/);
});

test('music running turns remain scoped to the music thread', async () => {
  const music = createMusicDb();
  const env = { DB: music };

  const reserved = await reserveChatTurn(env, {
    userSub: 'subject',
    clientMessageId: 'music-running',
    expectedRevision: 0,
    content: 'music message',
    now: 2,
  });

  assert.equal(reserved.thread.revision, 1);
  assert.equal(music.database.prepare("SELECT status FROM music_chat_turns WHERE user_sub='subject'").get().status, 'running');
});

test('model messages carry a UTC+8 send-time prefix that ignores the runtime timezone', () => {
  const thread = {
    messages: [
      { role: 'user', content: '第一句', createdAt: Date.UTC(2026, 8, 14, 7, 30) },
      { role: 'assistant', content: '  第二句  ', createdAt: Date.UTC(2026, 8, 14, 16, 30) },
      { role: 'system', content: '系统消息不进入模型历史', createdAt: Date.UTC(2026, 8, 14, 7, 30) },
      { role: 'user', content: '   ', createdAt: Date.UTC(2026, 8, 14, 7, 30) },
    ],
  };
  const originalTz = process.env.TZ;
  const utcRun = modelMessagesFromThread(thread);
  process.env.TZ = 'America/New_York';
  const shiftedRun = modelMessagesFromThread(thread);
  if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;

  assert.deepEqual(shiftedRun, utcRun);
  assert.deepEqual(utcRun, [
    { role: 'user', content: '[09-14 15:30] 第一句' },
    { role: 'assistant', content: '[09-15 00:30] 第二句' },
    // 空白内容沿用既有的空串行为，不会被加上时间前缀。
    { role: 'user', content: '' },
  ]);
  assert.equal(formatMessageTimestamp(Date.UTC(2026, 8, 14, 7, 30)), '09-14 15:30');
  assert.equal(formatMessageTimestamp(Date.UTC(2026, 8, 14, 16, 0)), '09-15 00:00');
  assert.equal(formatMessageTimestamp(0), '');
  assert.equal(formatMessageTimestamp('not-a-number'), '');
});

test('model messages keep the last 24 entries and leave unprefixable timestamps untouched', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: 'user',
    content: `消息 ${index}`,
    createdAt: Date.UTC(2026, 8, 14, 0, 0) + index * 60000,
  }));
  messages.push({ role: 'assistant', content: '没有时间戳的回复', createdAt: undefined });

  const projected = modelMessagesFromThread({ messages });
  assert.equal(projected.length, 24);
  assert.equal(projected.at(-1).content, '没有时间戳的回复');
  assert.equal(projected[0].content, '[09-14 08:07] 消息 7');
  assert.deepEqual(modelMessagesFromThread(null), []);
});

test('music thread hides legacy reply-card metadata without deleting stored history', async () => {
  const music = createMusicDb();
  const env = { DB: music };
  const reserved = await reserveChatTurn(env, {
    userSub: 'subject-display',
    clientMessageId: 'client-msg-display',
    expectedRevision: 0,
    content: '推荐几首好听的歌',
    now: 10,
  });

  const candidateSongs = [{ id: 'song-a', title: 'Song Alpha' }];
  const displaySongs = [{ id: 'song-b', title: 'Song Beta' }];
  const completed = await completeChatTurn(env, {
    userSub: 'subject-display',
    turnId: reserved.turn.id,
    expectedRevision: reserved.turn.reserved_revision,
    content: '为你推荐这首：',
    extra: { songs: candidateSongs, displaySongs },
    now: 11,
  });

  const assistantMsg = completed.thread.messages.find((message) => message.role === 'assistant');
  assert.equal(Object.hasOwn(assistantMsg, 'songs'), false);
  assert.equal(Object.hasOwn(assistantMsg, 'displaySongs'), false);
  const stored = JSON.parse(music.database.prepare("SELECT extra_json FROM music_chat_thread_messages WHERE role='assistant'").get().extra_json);
  assert.deepEqual(stored.songs, candidateSongs);
  assert.deepEqual(stored.displaySongs, displaySongs);

  const legacyReserved = await reserveChatTurn(env, {
    userSub: 'subject-display',
    clientMessageId: 'client-msg-display-legacy',
    expectedRevision: completed.thread.revision,
    content: '再来一轮',
    now: 12,
  });
  const legacyCompleted = await completeChatTurn(env, {
    userSub: 'subject-display',
    turnId: legacyReserved.turn.id,
    expectedRevision: legacyReserved.turn.reserved_revision,
    content: '这次没有展示集。',
    extra: { songs: candidateSongs },
    now: 13,
  });
  const legacyAssistant = legacyCompleted.thread.messages.filter((message) => message.role === 'assistant').at(-1);
  assert.equal(Object.hasOwn(legacyAssistant, 'songs'), false);
  assert.equal(Object.hasOwn(legacyAssistant, 'displaySongs'), false);
});
