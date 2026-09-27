import { AuthError } from './index.js';

export function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw new AuthError('invalid_display_name', 400);
  const name = value.trim();
  if (name.length > 80 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)) {
    throw new AuthError('invalid_display_name', 400);
  }
  return name;
}

export async function updateOwnDisplayName(db, accountId, value, now = Date.now()) {
  const displayName = normalizeDisplayName(value);
  const result = await db.prepare(`UPDATE accounts SET display_name = ?,
    updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
    WHERE account_id = ? AND status = 'active'`)
    .bind(displayName, now, now, accountId).run();
  if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) {
    throw new AuthError('authentication_required', 401);
  }
  const row = await db.prepare(`SELECT account_id, username, display_name, role FROM accounts
    WHERE account_id = ? AND status = 'active'`).bind(accountId).first();
  return { accountId: row.account_id, username: row.username,
    displayName: row.display_name, role: row.role };
}
