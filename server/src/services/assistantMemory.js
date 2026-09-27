const MAX_MEMORIES = 30;
const rows = (result) => result?.results || [];
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export class MemoryError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function validContent(value) {
  if (typeof value !== 'string') throw new MemoryError('invalid_memory');
  const content = value.trim().replace(/\s+/gu, ' ');
  if (!content || content.length > 240 || /[\u0000-\u001f\u007f]/u.test(content)) {
    throw new MemoryError('invalid_memory');
  }
  // Memory is user information, never a store for credentials.
  if (/(?:密码|验证码|密钥|口令|私钥|api[\s_-]*key|access[\s_-]*token|bearer[\s_-]*token)\s*(?:[:：=]|是|为|是：|为：|\s)\s*\S{4,}/iu.test(content)
    || /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u.test(content)
    || /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(content)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) {
    throw new MemoryError('credential_not_allowed');
  }
  return content;
}

const dto = (row) => ({ id: row.id, content: row.content, source: row.source,
  createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });

export async function memoryEnabled(db, accountId) {
  const setting = await db.prepare(`SELECT enabled FROM assistant_memory_settings WHERE account_id = ?`)
    .bind(accountId).first();
  return setting?.enabled === 1;
}

export async function readAssistantMemories(db, accountId, { forAssistant = false } = {}) {
  const enabled = await memoryEnabled(db, accountId);
  if (forAssistant && !enabled) return { enabled, memories: [] };
  const result = await db.prepare(`SELECT id, content, source, created_at, updated_at
    FROM assistant_memories WHERE account_id = ?
    ${forAssistant ? 'AND EXISTS (SELECT 1 FROM assistant_memory_settings s WHERE s.account_id = ? AND s.enabled = 1)' : ''}
    ORDER BY updated_at DESC, id LIMIT ?`)
    .bind(...(forAssistant ? [accountId, accountId, MAX_MEMORIES] : [accountId, MAX_MEMORIES])).all();
  return { enabled, memories: rows(result).map(dto) };
}

export async function setAssistantMemoryEnabled(db, accountId, enabled, now = Date.now()) {
  if (typeof enabled !== 'boolean') throw new MemoryError('invalid_input');
  await db.prepare(`INSERT INTO assistant_memory_settings (account_id, enabled, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
    enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .bind(accountId, enabled ? 1 : 0, now).run();
  return { enabled };
}

export async function saveAssistantMemory(db, accountId, { id, content, source = 'user_edited',
  actor = 'user', now = Date.now() }) {
  const clean = validContent(content);
  if (!['stated', 'inferred', 'user_edited'].includes(source)) throw new MemoryError('invalid_source');
  if (actor === 'assistant' && !await memoryEnabled(db, accountId)) {
    throw new MemoryError('memory_disabled', 403);
  }
  if (id !== undefined) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new MemoryError('invalid_memory_id');
    const result = await db.prepare(`UPDATE assistant_memories SET content = ?, source = ?, updated_at = ?
      WHERE id = ? AND account_id = ? ${actor === 'assistant' ? `AND source != 'user_edited'
      AND EXISTS (SELECT 1 FROM assistant_memory_settings s WHERE s.account_id = ? AND s.enabled = 1)` : ''}`)
      .bind(...(actor === 'assistant' ? [clean, source, now, id, accountId, accountId]
        : [clean, 'user_edited', now, id, accountId])).run();
    if (changes(result) !== 1) throw new MemoryError('memory_not_found', 404);
    const saved = await db.prepare(`SELECT id, content, source, created_at, updated_at
      FROM assistant_memories WHERE id = ? AND account_id = ?`).bind(id, accountId).first();
    return { memory: dto(saved), action: 'updated' };
  }
  const duplicate = await db.prepare(`SELECT id, content, source, created_at, updated_at
    FROM assistant_memories WHERE account_id = ? AND content = ? LIMIT 1`)
    .bind(accountId, clean).first();
  if (duplicate) return { memory: dto(duplicate), action: 'unchanged' };
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM assistant_memories WHERE account_id = ?`)
    .bind(accountId).first();
  if (Number(count?.total || 0) >= MAX_MEMORIES) throw new MemoryError('memory_limit_reached', 409);
  const newId = crypto.randomUUID();
  const inserted = await db.prepare(`INSERT INTO assistant_memories
    (id, account_id, content, source, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE
      (SELECT COUNT(*) FROM assistant_memories WHERE account_id = ?) < ?
      ${actor === 'assistant' ? `AND EXISTS (SELECT 1 FROM assistant_memory_settings s
        WHERE s.account_id = ? AND s.enabled = 1)` : ''}`)
    .bind(...(actor === 'assistant'
      ? [newId, accountId, clean, source, now, now, accountId, MAX_MEMORIES, accountId]
      : [newId, accountId, clean, 'user_edited', now, now, accountId, MAX_MEMORIES])).run();
  if (changes(inserted) !== 1) throw new MemoryError(actor === 'assistant'
    && !await memoryEnabled(db, accountId) ? 'memory_disabled' : 'memory_limit_reached', 409);
  return { memory: { id: newId, content: clean,
    source: actor === 'assistant' ? source : 'user_edited', createdAt: now, updatedAt: now }, action: 'created' };
}

export async function deleteAssistantMemory(db, accountId, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new MemoryError('invalid_memory_id');
  const result = await db.prepare(`DELETE FROM assistant_memories WHERE id = ? AND account_id = ?`)
    .bind(id, accountId).run();
  if (changes(result) !== 1) throw new MemoryError('memory_not_found', 404);
  return { ok: true };
}
