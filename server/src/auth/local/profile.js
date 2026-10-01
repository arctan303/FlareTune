import { AuthError } from './index.js';

const UI_LANGUAGES = new Set(['auto', 'zh', 'en']);
const languageKey = (accountId) => `account.ui_language.${accountId}`;

export async function getOwnUiLanguage(db, accountId) {
  const row = await db.prepare('SELECT value_json FROM instance_settings WHERE key = ?')
    .bind(languageKey(accountId)).first();
  if (!row) return 'auto';
  try {
    const value = JSON.parse(row.value_json);
    return UI_LANGUAGES.has(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export async function updateOwnUiLanguage(db, accountId, value, now = Date.now()) {
  if (!UI_LANGUAGES.has(value)) throw new AuthError('invalid_ui_language', 400);
  const key = languageKey(accountId);
  const result = await db.prepare(`INSERT INTO instance_settings
      (key, value_json, revision, updated_at, updated_by)
    SELECT ?, ?, 1, ?, ? WHERE EXISTS
      (SELECT 1 FROM accounts WHERE account_id = ? AND status = 'active')
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
      revision = instance_settings.revision + 1,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(key, JSON.stringify(value), now, accountId, accountId).run();
  if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) {
    throw new AuthError('authentication_required', 401);
  }
  return { uiLanguage: value };
}

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
