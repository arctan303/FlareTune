const MAX_MESSAGES = 500;
const clean = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

// 服务端消息时间固定 UTC+8，与运行环境时区无关：先把时间戳平移到东八区，再取 UTC 字段。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad2 = (value) => String(value).padStart(2, '0');

export const formatMessageTimestamp = (createdAt) => {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) return '';
  const shifted = new Date(value + BEIJING_OFFSET_MS);
  return `${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
};

const requireDb = (env) => {
  if (!env.DB?.prepare || typeof env.DB.batch !== 'function') throw new Error('MUSIC_DB_UNAVAILABLE');
  return env.DB;
};

const mapMessage = (row) => {
  let extra = null;
  try { extra = row.extra_json ? JSON.parse(row.extra_json) : null; } catch {}
  return {
    id: row.id,
    role: row.role,
    content: row.content || '',
    sequence: Number(row.sequence),
    clientMessageId: row.client_message_id || undefined,
    turnId: row.turn_id || undefined,
    thought: typeof extra?.thought === 'string' ? extra.thought : undefined,
    createdAt: Number(row.created_at),
  };
};

export async function ensureChatThread(env, userSub, now = Date.now()) {
  const db = requireDb(env);
  const subject = String(userSub);
  await db.prepare(`INSERT OR IGNORE INTO music_chat_threads(user_sub, revision, next_sequence, created_at, updated_at)
    VALUES (?, 0, 1, ?, ?)`).bind(subject, now, now).run();
  return db.prepare('SELECT * FROM music_chat_threads WHERE user_sub = ?').bind(subject).first();
}

export async function getChatThread(env, userSub) {
  const db = requireDb(env);
  const thread = await ensureChatThread(env, userSub);
  const { results = [] } = await db.prepare(`SELECT * FROM (
    SELECT id, sequence, role, content, extra_json, client_message_id, turn_id, created_at FROM music_chat_thread_messages
    WHERE user_sub = ? ORDER BY sequence DESC LIMIT ?) latest ORDER BY sequence ASC`).bind(String(userSub), MAX_MESSAGES).all();
  return { id: `thread_${userSub}`, revision: Number(thread?.revision || 0), createdAt: Number(thread?.created_at || 0), updatedAt: Number(thread?.updated_at || 0), messages: results.map(mapMessage) };
}

export const modelMessagesFromThread = (thread) => (thread?.messages || [])
  .filter((item) => ['user', 'assistant'].includes(item.role) && item.content)
  .slice(-24)
  .map(({ role, content, createdAt }) => {
    const body = clean(content);
    // 空白内容保持原有的空串行为，不加时间前缀。
    const timestamp = body ? formatMessageTimestamp(createdAt) : '';
    return { role, content: timestamp ? `[${timestamp}] ${body}` : body };
  });

export async function getChatTurn(env, userSub, clientMessageId) {
  return requireDb(env).prepare('SELECT * FROM music_chat_turns WHERE user_sub = ? AND client_message_id = ?').bind(String(userSub), String(clientMessageId)).first();
}

export async function reserveChatTurn(env, { userSub, clientMessageId, expectedRevision, content, assistantId = 'xiaoa', now = Date.now() }) {
  const db = requireDb(env);
  const subject = clean(String(userSub), 240); const clientId = clean(clientMessageId, 160); const userContent = clean(content);
  if (!subject || !clientId || !userContent) throw new Error('INVALID_CHAT_TURN');
  const selectedAssistantId = clean(assistantId, 120) || 'xiaoa';
  await ensureChatThread(env, subject, now);
  // 自动清理超过 30 秒的陈旧 running turn，避免音乐站多标签页/设备互相死锁。
  await db.prepare(`UPDATE music_chat_turns SET status='failed', updated_at=?
    WHERE user_sub=? AND status='running' AND updated_at < ?`)
    .bind(now, subject, now - 30_000).run().catch(() => {});
  const existing = await getChatTurn(env, subject, clientId);
  if (existing) return { duplicate: true, turn: existing, thread: await getChatThread(env, subject) };
  const thread = await db.prepare('SELECT revision, next_sequence FROM music_chat_threads WHERE user_sub = ?').bind(subject).first();
  const revision = Number(expectedRevision);
  if (!Number.isInteger(revision) || revision !== Number(thread?.revision)) return { conflict: true, thread: await getChatThread(env, subject) };
  const turnId = `turn_${crypto.randomUUID()}`; const messageId = `msg_${crypto.randomUUID()}`; const reservedRevision = revision + 1;
  try {
    const statements = [
      db.prepare(`INSERT INTO music_chat_turns(id,user_sub,client_message_id,base_revision,reserved_revision,assistant_id,site,status,assistant_message_id,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?, 'running',NULL,?,? FROM music_chat_threads WHERE user_sub=? AND revision=?`)
        .bind(turnId, subject, clientId, revision, reservedRevision, selectedAssistantId, 'music', now, now, subject, revision),
      db.prepare(`INSERT INTO music_chat_thread_messages(id,user_sub,sequence,role,content,extra_json,client_message_id,turn_id,created_at)
        SELECT ?,?,?,'user',?,?,?,?,? FROM music_chat_threads WHERE user_sub=? AND revision=?`)
        .bind(messageId, subject, Number(thread.next_sequence || 1), userContent, null, clientId, turnId, now, subject, revision),
      db.prepare('UPDATE music_chat_threads SET revision=revision+1,next_sequence=next_sequence+1,updated_at=? WHERE user_sub=? AND revision=?').bind(now, subject, revision),
    ];
    const results = await db.batch(statements);
    if (changes(results[2]) !== 1) return { conflict: true, thread: await getChatThread(env, subject) };
  } catch (error) {
    const duplicate = await getChatTurn(env, subject, clientId);
    if (duplicate) return { duplicate: true, turn: duplicate, thread: await getChatThread(env, subject) };
    throw error;
  }
  return { turn: await getChatTurn(env, subject, clientId), thread: await getChatThread(env, subject) };
}

export async function completeChatTurn(env, { userSub, turnId, expectedRevision, content, extra = null, now = Date.now() }) {
  const db = requireDb(env); const subject = String(userSub); const revision = Number(expectedRevision); const assistantContent = clean(content, 100000);
  if (!assistantContent) return { conflict: false, thread: await getChatThread(env, subject) };
  const thread = await db.prepare('SELECT next_sequence FROM music_chat_threads WHERE user_sub=? AND revision=?').bind(subject, revision).first();
  if (!thread) return { conflict: true, thread: await getChatThread(env, subject) };
  const messageId = `msg_${crypto.randomUUID()}`;
  const results = await db.batch([
    db.prepare(`INSERT INTO music_chat_thread_messages(id,user_sub,sequence,role,content,extra_json,client_message_id,turn_id,created_at)
      SELECT ?,?,?,'assistant',?,?,NULL,?,? FROM music_chat_threads WHERE user_sub=? AND revision=?
      AND EXISTS(SELECT 1 FROM music_chat_turns WHERE id=? AND user_sub=? AND reserved_revision=? AND status='running')`)
      .bind(messageId, subject, Number(thread.next_sequence), assistantContent, extra ? JSON.stringify(extra) : null, turnId, now, subject, revision, turnId, subject, revision),
    db.prepare(`UPDATE music_chat_turns SET status='completed',assistant_message_id=?,updated_at=? WHERE id=? AND user_sub=? AND reserved_revision=? AND status='running'`).bind(messageId, now, turnId, subject, revision),
    db.prepare(`UPDATE music_chat_threads SET revision=revision+1,next_sequence=next_sequence+1,updated_at=? WHERE user_sub=? AND revision=?
      AND EXISTS(SELECT 1 FROM music_chat_turns WHERE id=? AND user_sub=? AND status='completed')`).bind(now, subject, revision, turnId, subject),
  ]);
  return changes(results[2]) === 1 ? { conflict: false, thread: await getChatThread(env, subject) } : { conflict: true, thread: await getChatThread(env, subject) };
}

export async function failChatTurn(env, userSub, turnId, now = Date.now()) {
  await requireDb(env).prepare(`UPDATE music_chat_turns SET status='failed',updated_at=? WHERE id=? AND user_sub=? AND status='running'`).bind(now, turnId, String(userSub)).run();
}

export async function clearChatThread(env, userSub, expectedRevision, now = Date.now()) {
  const db = requireDb(env); const current = await ensureChatThread(env, userSub); const revision = Number(expectedRevision);
  if (!Number.isInteger(revision) || revision !== Number(current.revision)) return { conflict: true, thread: await getChatThread(env, userSub) };
  const subject = String(userSub);
  const results = await db.batch([
    db.prepare(`DELETE FROM music_chat_thread_messages WHERE user_sub=?
      AND EXISTS(SELECT 1 FROM music_chat_threads WHERE user_sub=? AND revision=?)
      AND NOT EXISTS(SELECT 1 FROM music_chat_turns WHERE user_sub=? AND status='running')`)
      .bind(subject, subject, revision, subject),
    db.prepare(`DELETE FROM music_chat_turns WHERE user_sub=?
      AND EXISTS(SELECT 1 FROM music_chat_threads WHERE user_sub=? AND revision=?)
      AND NOT EXISTS(SELECT 1 FROM music_chat_turns active WHERE active.user_sub=? AND active.status='running')`)
      .bind(subject, subject, revision, subject),
    db.prepare(`UPDATE music_chat_threads SET revision=revision+1,next_sequence=1,updated_at=? WHERE user_sub=? AND revision=?
      AND NOT EXISTS(SELECT 1 FROM music_chat_turns WHERE user_sub=? AND status='running')`)
      .bind(now, subject, revision, subject),
  ]);
  return changes(results[2]) === 1 ? { conflict: false, thread: await getChatThread(env, subject) } : { conflict: true, thread: await getChatThread(env, subject) };
}
